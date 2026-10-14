//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import {
  MenuInteractionType,
  RootMenuItem,
  ShowMenuOptions,
  SelectionSource,
} from './index';
import { Modifiers, RuntimeAppBinding, AppOp } from './app-switcher';
import { MenuItem, Workflow, WorkflowAction } from './settings-schemata';

/**
 * Regex matching literal macOS `open -a` commands according to V3.1 grammar:
 *
 * - Literal-only app name or bundle name
 * - Quoted with double quotes: `"([^"$`{}]+)"`
 * - Or unquoted identifier: `([A-Za-z0-9._+-]+)`
 * - No path separators ('/'), no shell metacharacters, no expansions.
 */
const APP_LAUNCH_REGEX = /^open -a (?:"([^"$`\\{}]+)"|([A-Za-z0-9._+-]+))$/;

const ALLOWED_OTHER_ACTIONS: Record<string, true> = {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  'close-menu': true,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  'inhibit-shortcuts': true,
  delay: true,
};

/**
 * Inspects a menu item and returns the application launch target name if it matches the
 * strict V3.1 app-launcher grammar, or `null` otherwise.
 *
 * Rules:
 *
 * - `item.type === 'button'`
 * - `selectWorkflow.actions` contains exactly one `execute-command` action
 * - Every other action in `selectWorkflow.actions` is in `{close-menu, inhibit-shortcuts,
 *   delay}`
 * - The command matches `^open -a (?:"([^"$`{}]+)"|([A-Za-z0-9._+-]+))$` after trimming
 * - No '/', no shell metacharacters, no '{{'
 * - Normalised by stripping one trailing '.app' case-insensitively
 */
export function getAppLaunchTarget(item: unknown): string | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Partial<MenuItem>;
  if (candidate.type !== 'button') {
    return null;
  }

  const actions = candidate.selectWorkflow?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return null;
  }

  const executeCommandActions = actions.filter(
    (action) => action && action.type === 'execute-command'
  );

  if (executeCommandActions.length !== 1) {
    return null;
  }
  const otherActions = actions.filter(
    (action) => action && action.type !== 'execute-command'
  );

  for (const action of otherActions) {
    if (!action || !ALLOWED_OTHER_ACTIONS[action.type]) {
      return null;
    }
  }

  const executeAction = executeCommandActions[0] as { command?: unknown };
  if (typeof executeAction.command !== 'string') {
    return null;
  }

  const trimmed = executeAction.command.trim();
  const match = trimmed.match(APP_LAUNCH_REGEX);
  if (!match) {
    return null;
  }

  const rawTarget = match[1] ?? match[2];
  if (!rawTarget) {
    return null;
  }

  // Reject path separators, shell expansions/metacharacters, placeholders
  if (
    rawTarget.includes('/') ||
    rawTarget.includes('{{') ||
    /[/$;|&<>()*?!#~\\`]/.test(rawTarget)
  ) {
    return null;
  }

  let target = rawTarget;
  if (target.toLowerCase().endsWith('.app')) {
    target = target.slice(0, -4);
  }

  if (target.trim().length === 0) {
    return null;
  }

  return target;
}

/**
 * Resolves the operational action to perform for an app item given the modifier keys held
 * during selection.
 *
 * Exact modifier combinations:
 *
 * - `{}`: running ? `'activate'` : `'launch'`
 * - `{ctrl}`: running ? `'quit'` : `'none'`
 * - `{meta}`: running && binding.windowsKnown && binding.windowId !== undefined ?
 *   `'close-window'` : `'none'`
 * - `{alt}`: running && binding.windowsKnown && binding.windowId !== undefined ?
 *   `'close-tab'` : `'none'`
 * - `{meta, alt}`: running ? `'hide'` : `'none'`
 * - Any other combination (including shift): `'none'`
 *
 * Non-running apps with any modifier pressed never launch (`'none'`).
 */
export function resolveAppOp(
  modifiers: Modifiers,
  binding: RuntimeAppBinding
): AppOp | 'launch' | 'none' {
  const ctrl = Boolean(modifiers.ctrl);
  const meta = Boolean(modifiers.meta);
  const alt = Boolean(modifiers.alt);
  const shift = Boolean(modifiers.shift);

  // Shift or combinations with shift are not used
  if (shift) {
    return 'none';
  }

  // Exact set: {}
  if (!ctrl && !meta && !alt) {
    return binding.running ? 'activate' : 'launch';
  }

  // Non-running app selected with any modifier never launches
  if (!binding.running) {
    return 'none';
  }

  // Exact set: {ctrl}
  if (ctrl && !meta && !alt) {
    return 'quit';
  }

  // Exact set: {meta}
  if (!ctrl && meta && !alt) {
    return binding.windowsKnown && binding.windowId !== undefined
      ? 'close-window'
      : 'none';
  }

  // Exact set: {alt}
  if (!ctrl && !meta && alt) {
    return binding.windowsKnown && binding.windowId !== undefined ? 'close-tab' : 'none';
  }

  // Exact set: {meta, alt}
  if (!ctrl && meta && alt) {
    return 'hide';
  }

  // Any other combination (ctrl+meta, ctrl+alt, ctrl+meta+alt, etc.)
  return 'none';
}

/** Mapping information from a displayed-tree path to the original source-tree path. */
export type DisplayedPathInfo = {
  sourcePath: number[];
  isConvertedParent?: boolean;
  isSyntheticChild?: boolean;
};

/**
 * Translates interaction events from the displayed menu tree to the source menu tree for
 * public IPC listeners and observers (V3.5).
 *
 * Rules:
 *
 * - `closeMenu` is forwarded unchanged.
 * - `selectButton` on a synthetic window child is reported as `selectButton` on the SOURCE
 *   app button path.
 * - `hover*`, `activateMenu`, `open` interactions on synthetic children or converted
 *   parents are suppressed (`null`).
 * - Interactions on non-converted items are forwarded unchanged with their source path.
 */
export function translateIpcInteraction(
  type: MenuInteractionType,
  path: number[],
  pathMap?: Map<string, DisplayedPathInfo>
): { type: MenuInteractionType; path: number[] } | null {
  if (type === MenuInteractionType.eCloseMenu) {
    return { type, path };
  }

  if (!pathMap) {
    return { type, path };
  }

  const key = path.join(',');
  const info = pathMap.get(key);
  if (!info) {
    return { type, path };
  }

  if (info.isSyntheticChild) {
    if (type === MenuInteractionType.eSelectButton) {
      return { type: MenuInteractionType.eSelectButton, path: info.sourcePath };
    }
    return null;
  }

  if (info.isConvertedParent) {
    return null;
  }

  return { type, path: info.sourcePath };
}

/** Decision for how to execute selection on an item. */
export type AppSelectionDecision = {
  workflowToExecute: Workflow;
  launchActionToOverride?: WorkflowAction;
  op: AppOp | 'launch' | 'none';
};

/**
 * The workflow which is executed if a native app operation was decided but the workflow
 * holds no launch action to replace. Running the workflow unchanged would launch the
 * application next to the destructive operation, so only the menu is closed.
 */
const FAIL_CLOSED_WORKFLOW: Workflow = {
  actions: [{ type: 'close-menu' }],
};

/**
 * Decides how to execute a button selection, extracting the decision logic from
 * MenuWindow for clean testability without Electron.
 */
export function decideAppSelection(
  item: {
    readonly type?: string;
    readonly app?: unknown;
    readonly selectWorkflow?: unknown;
  },
  modifiers: Modifiers
): AppSelectionDecision | null {
  const binding = item.app as RuntimeAppBinding | undefined;
  if (!binding) {
    return null;
  }

  const op = resolveAppOp(modifiers, binding);
  const selectWorkflow = item.selectWorkflow as Workflow | undefined;
  const actions = selectWorkflow?.actions;
  const workflow: Workflow =
    item.type === 'button' && Array.isArray(actions) && actions.length > 0
      ? selectWorkflow
      : (binding.originalWorkflow as Workflow);

  if (op === 'launch') {
    return {
      workflowToExecute: workflow,
      op: 'launch',
    };
  }

  const launchAction = workflow.actions?.find((a) => a && a.type === 'execute-command');

  if (!launchAction) {
    return {
      workflowToExecute: FAIL_CLOSED_WORKFLOW,
      op: 'none',
    };
  }

  return {
    workflowToExecute: workflow,
    launchActionToOverride: launchAction,
    op,
  };
}

/**
 * Normalises a displayed-menu generation. Zero means "the renderer does not know which
 * menu tree it is displaying". The main process drops interactions stamped with 0.
 */
export function normalizeMenuGeneration(generation: unknown): number {
  if (
    typeof generation === 'number' &&
    Number.isSafeInteger(generation) &&
    generation > 0
  ) {
    return generation;
  }
  return 0;
}

/**
 * Parses the arguments of a `menu-window.show-menu` message as sent by the main process:
 * `(root, menuOptions, environmentInfo, generation)`.
 *
 * The environmentInfo argument is kept in the contract. Dropping it would shift the
 * generation into its place, causing it to read the environment object and drop every
 * non-close interaction.
 */
export function parseShowMenuArgs(
  root: RootMenuItem,
  menuOptions: ShowMenuOptions,
  environmentInfo: unknown,
  generation: unknown
): {
  root: RootMenuItem;
  menuOptions: ShowMenuOptions;
  environmentInfo: unknown;
  generation: number;
} {
  return {
    root,
    menuOptions,
    environmentInfo,
    generation: normalizeMenuGeneration(generation),
  };
}

/**
 * Parses the arguments of a `menu-window.trigger-interaction` message as sent by the main
 * process: `(type, generation)`.
 *
 * The generation of the menu tree to close is forwarded so that the renderer can cancel
 * pending shows and acknowledge with the requested generation.
 */
export function parseTriggerInteractionArgs(
  type: unknown,
  generation?: unknown
): {
  type: MenuInteractionType.eCloseMenu | MenuInteractionType.eCloseSubmenu;
  generation: number;
} {
  return {
    type: type as MenuInteractionType.eCloseMenu | MenuInteractionType.eCloseSubmenu,
    generation: normalizeMenuGeneration(generation),
  };
}

/**
 * Decides whether a pending show with the given generation can proceed to install into
 * the DOM after asynchronous preparation (e.g. icon reloading).
 *
 * A show cannot install if:
 *
 * - The generation is invalid (0).
 * - A newer show was requested in the meantime.
 * - A close trigger has cancelled this generation (generation <= cancelledUpToGeneration).
 *
 * @param generation The generation of the pending show.
 * @param latestRequestedGeneration The highest generation requested so far.
 * @param cancelledUpToGeneration The highest generation cancelled so far.
 * @returns True if the show can install.
 */
export function canInstallPendingShow(
  generation: number,
  latestRequestedGeneration: number,
  cancelledUpToGeneration: number
): boolean {
  const gen = normalizeMenuGeneration(generation);
  if (gen === 0) {
    return false;
  }
  if (gen !== latestRequestedGeneration) {
    return false;
  }
  if (gen <= cancelledUpToGeneration) {
    return false;
  }
  return true;
}

/**
 * Pure evaluation of a close trigger received from the host process.
 *
 * @param triggerGeneration The generation the host requested to close.
 * @param displayedGeneration The generation currently displayed on screen.
 * @param cancelledUpToGeneration The highest generation cancelled so far.
 * @returns An object containing:
 *
 *   - AckGeneration: the generation to acknowledge.
 *   - ShouldHideInstalled: true if the currently installed menu should be hidden.
 *   - NewCancelledUpTo: updated highest cancelled generation.
 */
export function handleRendererCloseTrigger(
  triggerGeneration: number,
  displayedGeneration: number,
  cancelledUpToGeneration: number
): {
  ackGeneration: number;
  shouldHideInstalled: boolean;
  newCancelledUpTo: number;
} {
  const gen = normalizeMenuGeneration(triggerGeneration);
  const newCancelledUpTo = Math.max(cancelledUpToGeneration, gen);
  // A close for an older generation must not hide a newer window that has already
  // been installed. But if the installed generation is older or equal to the trigger
  // generation, the installed menu must be hidden.
  const shouldHideInstalled =
    displayedGeneration > 0 && (gen === 0 || displayedGeneration <= gen);

  return {
    ackGeneration: gen,
    shouldHideInstalled,
    newCancelledUpTo,
  };
}

/**
 * Coordinates menu installation and close triggers on the renderer side.
 *
 * It prevents races where a show message is received and begins asynchronous icon
 * reloading, but a close trigger arrives before the menu installs. In that scenario, the
 * pending show is cancelled and never installs, and the renderer acknowledges the close
 * with the requested generation rather than whatever happens to currently be installed on
 * screen.
 */
export class RendererMenuCoordinator {
  private latestRequestedGeneration = 0;
  private cancelledUpToGeneration = 0;
  private displayedGeneration = 0;
  private closingFromHost = false;

  public get displayedMenuGeneration(): number {
    return this.displayedGeneration;
  }

  public get latestRequested(): number {
    return this.latestRequestedGeneration;
  }

  public get cancelledUpTo(): number {
    return this.cancelledUpToGeneration;
  }

  public get isClosingFromHost(): boolean {
    return this.closingFromHost;
  }

  /**
   * Records that a new menu tree show was requested by the host.
   *
   * @param generation The generation from the show-menu message.
   */
  public recordShowRequest(generation: number): void {
    const gen = normalizeMenuGeneration(generation);
    if (gen > this.latestRequestedGeneration) {
      this.latestRequestedGeneration = gen;
    }
  }

  /**
   * Decides whether a show operation with the given generation is allowed to install into
   * the DOM after any asynchronous preparation.
   *
   * @param generation The generation of the show operation.
   * @returns True if the show can be installed.
   */
  public canInstall(generation: number): boolean {
    return canInstallPendingShow(
      generation,
      this.latestRequestedGeneration,
      this.cancelledUpToGeneration
    );
  }

  /**
   * Records that the menu with the given generation was installed and is now displayed on
   * screen.
   *
   * @param generation The installed generation.
   */
  public recordInstalled(generation: number): void {
    this.displayedGeneration = normalizeMenuGeneration(generation);
  }

  /** Records that the menu was closed (e.g. by user interaction). */
  public recordClosed(): void {
    this.displayedGeneration = 0;
  }

  /**
   * Evaluates a close trigger received from the host process.
   *
   * @param triggerGeneration The generation the host requested to close.
   * @returns An object indicating the generation to acknowledge and whether the currently
   *   installed menu should be hidden.
   */
  public handleCloseTrigger(triggerGeneration: number): {
    ackGeneration: number;
    shouldHideInstalled: boolean;
  } {
    const result = handleRendererCloseTrigger(
      triggerGeneration,
      this.displayedGeneration,
      this.cancelledUpToGeneration
    );
    this.cancelledUpToGeneration = result.newCancelledUpTo;
    if (result.shouldHideInstalled) {
      this.displayedGeneration = 0;
    }
    return {
      ackGeneration: result.ackGeneration,
      shouldHideInstalled: result.shouldHideInstalled,
    };
  }

  /**
   * Executes a host-initiated close trigger.
   *
   * Cancels any pending show whose generation <= triggerGeneration, hides the installed
   * menu if installed <= triggerGeneration, and sends the acknowledgement stamped with
   * triggerGeneration.
   *
   * @param triggerGeneration The generation to close.
   * @param actions Callbacks to hide installed UI and send the acknowledgement.
   */
  public closeFromHost(
    triggerGeneration: number,
    actions: {
      hideInstalled: () => void;
      sendAck: (ackGeneration: number, didHideInstalled?: boolean) => void;
    }
  ): void {
    const { ackGeneration, shouldHideInstalled } =
      this.handleCloseTrigger(triggerGeneration);
    if (shouldHideInstalled) {
      this.closingFromHost = true;
      try {
        actions.hideInstalled();
      } finally {
        this.closingFromHost = false;
      }
    }
    actions.sendAck(ackGeneration, shouldHideInstalled);
  }
}

/**
 * Builds the argument list of a `menu-window.finalize-interaction` message. The
 * generation of the installed menu tree is appended so that the main process can drop
 * interactions which belong to an older menu.
 */
export function stampInteraction(
  type: MenuInteractionType,
  path: number[],
  time: number,
  source: SelectionSource,
  modifiers: Modifiers,
  displayedGeneration: number
): [MenuInteractionType, number[], number, SelectionSource, Modifiers, number] {
  return [
    type,
    path,
    time,
    source,
    modifiers,
    normalizeMenuGeneration(displayedGeneration),
  ];
}

/**
 * Decides whether an interaction reported by the renderer belongs to a stale menu
 * generation, i.e. to a menu tree which the main process has already replaced. Such
 * interactions must not be dispatched, because their paths refer to items of the previous
 * menu.
 *
 * The check fails closed: an interaction without a valid, positive generation cannot
 * prove that its paths belong to the currently displayed menu, so it is treated as
 * stale.
 *
 * @param interactionGeneration The generation the renderer attached to the interaction.
 * @param currentGeneration The generation of the tree the main process currently holds.
 * @returns True if the interaction refers to a tree which is no longer displayed.
 */
export function isStaleInteraction(
  interactionGeneration: number | undefined,
  currentGeneration: number
): boolean {
  if (normalizeMenuGeneration(interactionGeneration) === 0) {
    return true;
  }
  return interactionGeneration !== currentGeneration;
}

/** The outcome of hiding the menu window. */
export type HideResult = 'completed' | 'cancelled';

/**
 * The state of a generation-bound hide operation.
 *
 * - 'not-started': no hide was requested for this generation.
 * - 'pending': a hide was started by markHiding(), but the platform hide has not run yet.
 * - 'completed': the fade-out finished and the platform window was hidden.
 * - 'cancelled': a newer menu superseded this hide before or during the fade-out.
 */
export type HideState = 'not-started' | 'pending' | 'completed' | 'cancelled';

/**
 * Schedules the fade-out which ends in the platform hide. Returns a function which
 * cancels the pending hide. Injectable, so tests can drive the fade-out without real
 * time.
 */
export type HideScheduler = (callback: () => void, timeoutMs: number) => () => void;

/** The window operations which the hide coordinator cannot perform itself. */
export type HideCoordinatorHost = {
  /** Hides the platform window. Called once the fade-out animation has finished. */
  hidePlatformWindow(): void;
  /**
   * Asks the renderer to close the menu for the given generation. The renderer answers
   * via finalize-interaction stamped with this generation.
   */
  requestClose(generation: number): void;
};

const DEFAULT_HIDE_SCHEDULER: HideScheduler = (callback, timeoutMs) => {
  const handle = setTimeout(callback, timeoutMs);
  return () => clearTimeout(handle);
};

/** Internal state of a hide operation bound to one menu generation. */
export type HideRecord = {
  generation: number;
  state: HideState;
  cancelFade: (() => void) | null;
  hidePromise: Promise<HideResult> | null;
  resolveHide: ((result: HideResult) => void) | null;
  waiters: Array<(result: HideResult) => void>;
};

/** One coalesced close request, bound to the generation which asked for the close. */
type CloseRequest = {
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Owns the visibility lifecycle of the menu window: the displayed-menu generation, the
 * fade-out which ends in the platform hide, and one coalesced close request.
 *
 * Hiding happens in two phases. The renderer is asked to close, then the main process
 * releases any shortcut inhibition before it waits for the fade-out and hides the window.
 * A new menu shown during that preparation or during the fade-out cancels the hide, so a
 * selection which was still waiting for the hide learns that the window was never
 * hidden.
 */
export class MenuHideCoordinator {
  /** True while the menu is shown and not fading out. */
  private visible = false;

  /** The generation of the menu tree which is currently displayed. */
  private generation = 0;

  /** The hide operation currently in preparation or fading out. */
  private hideRecord: HideRecord | null = null;

  /** The close request currently in flight, if any. */
  private closeRequest: CloseRequest | null = null;

  /** Monotonic request token allocated before asynchronous show awaits. */
  private lastRequestToken = 0;

  constructor(
    private host: HideCoordinatorHost,
    private scheduleHide: HideScheduler = DEFAULT_HIDE_SCHEDULER
  ) {}

  public get isVisible(): boolean {
    return this.visible;
  }

  public get displayedGeneration(): number {
    return this.generation;
  }

  /**
   * Allocates a monotonic request-order token before asynchronous awaits in show().
   *
   * @returns The newly allocated request token.
   */
  public allocateRequestToken(): number {
    this.lastRequestToken += 1;
    return this.lastRequestToken;
  }

  /**
   * Checks whether the given request token has not been superseded by a newer request.
   *
   * @param token The request token to check.
   * @returns True if the token is still current.
   */
  public isRequestCurrent(token: number): boolean {
    return token === this.lastRequestToken;
  }

  /**
   * Starts a new menu generation. Any in-flight hide is cancelled, and a close request
   * which is still waiting for that hide is settled, so nothing keeps waiting for a hide
   * which will never run.
   *
   * If a requestToken is supplied and has already been superseded by a newer request,
   * null is returned so the caller can abort without committing or publishing.
   *
   * @param requestToken Optional request token allocated before asynchronous awaits.
   * @returns The generation of the new menu tree, or null if superseded.
   */
  public startGeneration(requestToken?: number): number | null {
    if (requestToken !== undefined && !this.isRequestCurrent(requestToken)) {
      return null;
    }
    this.generation += 1;
    this.cancelHide();
    this.settleSupersededCloseRequest();
    return this.generation;
  }

  /** Marks the menu as shown. Cancels an in-flight hide like startGeneration(). */
  public show(): void {
    this.cancelHide();
    this.visible = true;
  }

  /**
   * Marks the menu as no longer visible and begins a hide operation for the currently
   * displayed generation.
   *
   * This runs synchronously before any await in hideWindow(). The operation captures the
   * generation which is being hidden, so a newer menu shown during a later await cancels
   * exactly this hide, and awaitHide() will not mistake the preparation phase for a
   * completed hide.
   *
   * @returns The newly created pending HideRecord.
   */
  public markHiding(): HideRecord {
    this.cancelHide();
    this.visible = false;
    const record: HideRecord = {
      generation: this.generation,
      state: 'pending',
      cancelFade: null,
      hidePromise: null,
      resolveHide: null,
      waiters: [],
    };
    this.hideRecord = record;
    return record;
  }

  /**
   * Cancels a pending hide operation and restores visibility state so waiters settle and
   * the menu is not left in an untruthful hidden state when hide preparation failed.
   *
   * @param record The specific hide record returned by markHiding(). If provided,
   *   cancellation only proceeds if this record is still the current pending hide.
   */
  public cancelPendingHide(record?: HideRecord): void {
    if (record && record !== this.hideRecord) {
      return;
    }
    if (this.hideRecord && this.hideRecord.state === 'pending') {
      this.visible = true;
    }
    this.cancelHide();
  }

  /**
   * Arms the fade-out of the hide operation started by markHiding().
   *
   * @param fadeOutDurationMs The duration of the fade-out animation.
   * @param record The specific hide record returned by markHiding(), ensuring the
   *   continuation acts only on the hide operation it prepared.
   * @returns A promise resolving to 'completed' once the platform window was hidden, or
   *   'cancelled' if a newer show cancelled this hide before or during the fade-out.
   */
  public hide(fadeOutDurationMs: number, record?: HideRecord): Promise<HideResult> {
    const targetRecord = record ?? this.hideRecord;

    if (
      !targetRecord ||
      targetRecord !== this.hideRecord ||
      targetRecord.generation !== this.generation ||
      targetRecord.state !== 'pending'
    ) {
      return Promise.resolve('cancelled');
    }

    if (!targetRecord.hidePromise) {
      targetRecord.hidePromise = new Promise<HideResult>((resolve) => {
        targetRecord.resolveHide = resolve;
      });
      targetRecord.cancelFade = this.scheduleHide(
        () => this.completeHide(targetRecord),
        fadeOutDurationMs
      );
    }

    return targetRecord.hidePromise;
  }

  /**
   * Waits for the hide of the given generation.
   *
   * @param generation The generation whose hide should be awaited.
   * @returns A promise which resolves with 'completed' once that hide ran, or with
   *   'cancelled' if a newer menu generation was shown in the meantime or if no hide was
   *   ever started for the generation.
   */
  public awaitHide(generation: number): Promise<HideResult> {
    if (generation !== this.generation) {
      return Promise.resolve('cancelled');
    }

    const record = this.hideRecord;
    if (!record || record.generation !== generation) {
      // No hide operation exists for this generation. It was either never started or
      // finished and was cleared. Fail closed so callers do not touch the window.
      return Promise.resolve('cancelled');
    }

    if (record.state === 'pending') {
      return new Promise<HideResult>((resolve) => {
        record.waiters.push(resolve);
      });
    }

    return Promise.resolve(record.state === 'completed' ? 'completed' : 'cancelled');
  }

  /**
   * Asks the renderer to close the menu. Concurrent requests share one promise, and one
   * close request sends exactly one close trigger.
   *
   * @returns A promise which settles once the renderer confirmed the close and the
   *   fade-out completed or was cancelled by a new show.
   */
  public close(): Promise<void> {
    if (!this.visible) {
      return Promise.resolve();
    }

    if (this.closeRequest) {
      return this.closeRequest.promise;
    }

    const generation = this.generation;
    let resolveClose: () => void = () => {};
    let rejectClose: (error: unknown) => void = () => {};

    const promise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });

    this.closeRequest = {
      generation,
      promise,
      resolve: resolveClose,
      reject: rejectClose,
    };

    this.host.requestClose(generation);
    return promise;
  }

  /**
   * Settles the close request of the given generation once its hide finished. A close
   * request of another generation is untouched, so an acknowledgement from an older menu
   * cannot settle a newer request.
   *
   * @param generation The generation whose close request should settle.
   */
  public settleCloseRequest(generation: number): void {
    const request = this.closeRequest;
    if (!request || request.generation !== generation) {
      return;
    }
    this.closeRequest = null;
    request.resolve();
  }

  /** Rejects the close request of the given generation if hiding the window failed. */
  public failCloseRequest(generation: number, error: unknown): void {
    const request = this.closeRequest;
    if (!request || request.generation !== generation) {
      return;
    }
    this.closeRequest = null;
    request.reject(error);
  }

  /** Cancels an in-flight hide and lets everything waiting for it settle. */
  private cancelHide(): void {
    const record = this.hideRecord;
    this.hideRecord = null;

    if (!record) {
      return;
    }

    record.cancelFade?.();
    record.cancelFade = null;

    if (record.state === 'pending') {
      record.state = 'cancelled';
      record.resolveHide?.('cancelled');
      record.resolveHide = null;
      for (const waiter of record.waiters) {
        waiter('cancelled');
      }
      record.waiters = [];
    }
  }

  /** Hides the platform window once the fade-out has finished. */
  private completeHide(record: HideRecord): void {
    if (this.hideRecord !== record || record.state !== 'pending') {
      return;
    }

    record.cancelFade = null;
    try {
      this.host.hidePlatformWindow();
      record.state = 'completed';
      record.resolveHide?.('completed');
      record.resolveHide = null;
      for (const waiter of record.waiters) {
        waiter('completed');
      }
      record.waiters = [];
    } catch (error) {
      this.visible = true;
      record.state = 'cancelled';
      record.resolveHide?.('cancelled');
      record.resolveHide = null;
      for (const waiter of record.waiters) {
        waiter('cancelled');
      }
      record.waiters = [];
      this.hideRecord = null;
    }
  }

  /** Settles a close request which a newer menu generation has superseded. */
  private settleSupersededCloseRequest(): void {
    const request = this.closeRequest;
    this.closeRequest = null;
    request?.resolve();
  }
}

/** The host operations required by the app-selection action override. */
export type AppOpOverrideHost = {
  /** True while the menu is shown and not fading out. */
  isVisible(): boolean;
  /** The generation of the menu tree currently held by the main process. */
  displayedGeneration(): number;
  /** Closes the menu window and settles once the fade-out ran or was cancelled. */
  closeMenu(): Promise<void>;
  /** Waits for the hide of the given generation. */
  awaitHide(generation: number): Promise<HideResult>;
  /** Performs the native control operation on the application or one of its windows. */
  controlApp(target: string, op: AppOp, windowId?: number, pid?: number): void;
};

/**
 * Builds the callback which replaces the launch action of a recognised app item.
 *
 * V3.2 ordering rule: for app items the menu always closes BEFORE the native operation,
 * even if the stored workflow had close-menu after the launch. The override closes the
 * menu itself, wherever the launch sits in the action list. The remaining actions of the
 * workflow, including a later close-menu and any inhibit-shortcuts finalizer, still run
 * in their configured order around this callback.
 *
 * The callback captures the generation the selection was made in. It verifies that the
 * menu has not been replaced before closing the window, and waits for the fade-out of
 * that generation so the selected window is never touched while the menu still covers
 * it.
 *
 * @param host The menu-window operations.
 * @param target The application, operation and window to act on.
 * @param capturedGeneration The generation the selection was made in.
 */
export function createAppOpOverride(
  host: AppOpOverrideHost,
  target: {
    target: string;
    op: AppOp | 'launch' | 'none';
    windowId?: number;
    pid?: number;
  },
  capturedGeneration: number
): () => Promise<void> {
  return async () => {
    // The selection may have been delayed by earlier actions in the workflow. A newer menu
    // may be on screen by now, and the captured pid and window may belong to a different
    // application. Do not close that newer menu and do not touch anything.
    if (host.displayedGeneration() !== capturedGeneration) {
      console.debug(
        'Skipping app operation of a superseded menu generation:',
        capturedGeneration,
        '!=',
        host.displayedGeneration()
      );
      return;
    }

    if (host.isVisible()) {
      await host.closeMenu();
      if (host.displayedGeneration() !== capturedGeneration) {
        return;
      }
    }

    const hideResult = await host.awaitHide(capturedGeneration);
    if (hideResult !== 'completed' || host.displayedGeneration() !== capturedGeneration) {
      return;
    }

    if (target.op !== 'none' && target.op !== 'launch') {
      host.controlApp(target.target, target.op, target.windowId, target.pid);
    }
  };
}

/**
 * Builds the callback which replaces a close-menu action in a recognised app item's
 * workflow.
 *
 * The callback only closes the menu window if the currently displayed menu generation
 * matches the generation captured when the selection was made. If a newer menu has been
 * shown, it does nothing so it cannot close the newer menu.
 *
 * @param host The host operations providing displayedGeneration and closeMenu.
 * @param capturedGeneration The generation the selection was made in.
 */
export function createCloseMenuOverride(
  host: Pick<AppOpOverrideHost, 'displayedGeneration' | 'closeMenu'>,
  capturedGeneration: number
): () => Promise<void> {
  return async () => {
    if (host.displayedGeneration() !== capturedGeneration) {
      return;
    }
    await host.closeMenu();
  };
}

/** Describes a pointer release for {@link modifiersForPointerRelease}. */
export type PointerRelease = {
  /** The `button` of the released pointer, or a negative number if unknown. */
  button: number;
  /** The `pointerType` of a pointer event ('mouse', 'touch', 'pen'), if it has one. */
  pointerType?: string;
  /** True if the matching press was a discrete primary mouse press in the current menu. */
  pressOwned: boolean;
  /** True if the release ends a plain click, false if it ends a drag (marking/turbo). */
  discreteClick: boolean;
};

/**
 * Decides which modifiers a pointer release may carry into a selection. Only the release
 * of a discrete primary mouse click whose press was made in the current menu session can
 * carry the held modifiers. Secondary, middle and back buttons (for example the end of a
 * right-click back/cancel gesture), drags, releases whose press belongs to an earlier
 * menu, and touch or pen input never do, so such gestures can not end in a quit/close
 * selection.
 *
 * @param release What is known about the release.
 * @param modifiers The modifiers held on release.
 */
export function modifiersForPointerRelease(
  release: PointerRelease,
  modifiers: Modifiers
): Modifiers {
  const isMouse = release.pointerType === undefined || release.pointerType === 'mouse';
  return release.button === 0 && release.pressOwned && release.discreteClick && isMouse
    ? { ...modifiers }
    : { ctrl: false, meta: false, alt: false, shift: false };
}

/**
 * Tracks a discrete primary mouse press from its press to its release. Such a press is
 * only eligible to carry modifiers into a selection if it really was a click: the pointer
 * never moved a drag threshold or more away from the press position, neither on any
 * motion event in between (evaluated on every incoming event, so that throttled or
 * ignored motion cannot hide an excursion) nor at the moment of release. Once a press has
 * been invalidated it stays invalid until the next press, even if the pointer returns.
 */
export class PrimaryPressTracker {
  private origin: { x: number; y: number } | null = null;

  /** Starts tracking an eligible primary mouse press at the given position. */
  public begin(x: number, y: number): void {
    this.origin = { x, y };
  }

  /** Forgets any tracked press (new menu, cancelled gesture, non-eligible press). */
  public cancel(): void {
    this.origin = null;
  }

  /** Reports pointer motion. A move of the drag threshold or more invalidates the press. */
  public move(x: number, y: number, dragThreshold: number): void {
    if (
      this.origin &&
      Math.hypot(x - this.origin.x, y - this.origin.y) >= dragThreshold
    ) {
      this.origin = null;
    }
  }

  /**
   * Ends the tracked press at the release position.
   *
   * @returns True if the press was a click: it is still valid and the release is within
   *   the drag threshold of the press position.
   */
  public release(x: number, y: number, dragThreshold: number): boolean {
    const isClick =
      this.origin !== null &&
      Math.hypot(x - this.origin.x, y - this.origin.y) < dragThreshold;
    this.origin = null;
    return isClick;
  }
}

/**
 * Tracks the lifecycle of an Enter key gesture (keydown -> keyup) bound to a specific
 * menu session.
 *
 * A pending Enter keydown snapshot is bound to the menu session in which it occurred. It
 * is invalidated whenever a menu is shown, cleared, or hidden. An Enter keyup without a
 * matching keydown in the current menu session is ignored and cannot trigger selection.
 */
export class EnterGestureTracker {
  private currentSession = 0;
  private pendingSession: number | null = null;
  private pendingModifiers: Modifiers | null = null;

  /** Resets any pending Enter gesture snapshot without changing the current session id. */
  public reset(): void {
    this.pendingSession = null;
    this.pendingModifiers = null;
  }

  /**
   * Starts a new menu session, advancing the session counter and clearing any pending
   * gesture from the previous session.
   */
  public startSession(): void {
    this.currentSession++;
    this.reset();
  }

  /**
   * Records an Enter keydown event and its modifier snapshot in the current session. Only
   * the first, non-repeat keydown of a physical press can begin a gesture: auto-repeat
   * events neither start a gesture nor replace the snapshot of a running one. This way a
   * key which is still held while a menu is replaced cannot arm the new menu.
   *
   * @param modifiers Modifiers held when Enter was pressed down.
   * @param repeat True if the keydown is an auto-repeat event of a held key.
   */
  public onKeyDown(modifiers: Modifiers, repeat = false): void {
    if (repeat) {
      return;
    }
    this.pendingSession = this.currentSession;
    this.pendingModifiers = { ...modifiers };
  }

  /**
   * Evaluates an Enter keyup event. Returns the modifiers captured on keydown if and only
   * if there was a matching keydown in the current menu session. Returns null otherwise.
   */
  public onKeyUp(): Modifiers | null {
    if (this.pendingSession !== this.currentSession || this.pendingModifiers === null) {
      this.reset();
      return null;
    }
    const captured = this.pendingModifiers;
    this.reset();
    return captured;
  }
}
