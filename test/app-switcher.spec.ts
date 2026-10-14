//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import { expect } from 'chai';
import {
  getAppLaunchTarget,
  resolveAppOp,
  translateIpcInteraction,
  DisplayedPathInfo,
  decideAppSelection,
  isStaleInteraction,
  MenuHideCoordinator,
  parseShowMenuArgs,
  parseTriggerInteractionArgs,
  stampInteraction,
  normalizeMenuGeneration,
  canInstallPendingShow,
  handleRendererCloseTrigger,
  RendererMenuCoordinator,
  createAppOpOverride,
  createCloseMenuOverride,
  AppOpOverrideHost,
  EnterGestureTracker,
  modifiersForPointerRelease,
  PrimaryPressTracker,
} from '../src/common/app-switcher-logic';
import {
  Modifiers,
  NO_MODIFIERS,
  RuntimeAppBinding,
  AppState,
  DisplayedButtonMenuItem,
  QuickCloseConfig,
  QuickCloseContext,
  DEFAULT_QUICK_CLOSE_BINDINGS,
} from '../src/common/app-switcher';
import {
  MenuInteractionType,
  ButtonMenuItem,
  WorkflowAction,
  Workflow,
  RootMenuItem,
  SubmenuMenuItem,
  ShowMenuOptions,
  SelectionSource,
} from '../src/common';
import { IPCObserverRegistry } from '../src/common/ipc/ipc-observer-registry';
import { resolveAppState, AppControlBackend } from '../src/main/app-state-resolver';
import { WorkflowExecutor, WorkflowActionOverrides } from '../src/main/workflow-executor';
import { KandoApp } from '../src/main/app';
function makeExecuteAction(command: string): WorkflowAction {
  return {
    type: 'execute-command',
    command,
    detached: true,
    isolated: false,
  };
}

describe('App switcher logic', () => {
  describe('getAppLaunchTarget', () => {
    function makeButtonItem(actions: unknown[]): ButtonMenuItem {
      return {
        type: 'button',
        name: 'Test App',
        icon: 'test.svg',
        iconTheme: 'default',
        selectWorkflow: {
          actions: actions as unknown as WorkflowAction[],
        },
      };
    }

    it('accepts valid literal open -a commands', () => {
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'execute-command', command: 'open -a "Google Chrome"' },
          ])
        )
      ).to.equal('Google Chrome');

      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -a Safari' }])
        )
      ).to.equal('Safari');

      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -a "Safari.app"' }])
        )
      ).to.equal('Safari');

      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -a "TextEdit.APP"' }])
        )
      ).to.equal('TextEdit');

      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -a "Foo.app.app"' }])
        )
      ).to.equal('Foo.app');
    });

    it('accepts dropped-app two-action shape (execute-command + close-menu)', () => {
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'execute-command', command: 'open -a "Google Chrome"' },
            { type: 'close-menu' },
          ])
        )
      ).to.equal('Google Chrome');
    });

    it('accepts other allowlisted actions alongside execute-command', () => {
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'inhibit-shortcuts' },
            { type: 'execute-command', command: 'open -a "Notes"' },
            { type: 'delay', duration: 0.1 },
            { type: 'close-menu' },
          ])
        )
      ).to.equal('Notes');
    });

    it('rejects invalid and non-literal commands per V3.1 grammar', () => {
      // Path separators
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'execute-command', command: 'open -a /Applications/Safari.app' },
          ])
        )
      ).to.be.null;
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'execute-command', command: 'open -a "/Applications/Safari.app"' },
          ])
        )
      ).to.be.null;

      // Shell chaining & expansions
      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -a Safari; true' }])
        )
      ).to.be.null;
      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -a "$(x)"' }])
        )
      ).to.be.null;
      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -a "{{app_name}}"' }])
        )
      ).to.be.null;

      // Extra arguments & flags
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'execute-command', command: 'open -a Safari --args foo' },
          ])
        )
      ).to.be.null;
      expect(
        getAppLaunchTarget(
          makeButtonItem([{ type: 'execute-command', command: 'open -n -a Safari' }])
        )
      ).to.be.null;

      // Multiple execute-command actions
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'execute-command', command: 'open -a Safari' },
            { type: 'execute-command', command: 'open -a "Google Chrome"' },
          ])
        )
      ).to.be.null;

      // Zero execute-command actions
      expect(getAppLaunchTarget(makeButtonItem([{ type: 'close-menu' }]))).to.be.null;

      // Non-allowlisted extra actions
      expect(
        getAppLaunchTarget(
          makeButtonItem([
            { type: 'execute-command', command: 'open -a Safari' },
            { type: 'open-uri', uri: 'https://example.com' },
          ])
        )
      ).to.be.null;

      // Non-button types
      expect(
        getAppLaunchTarget({
          type: 'submenu',
          name: 'Submenu',
          icon: 'icon',
          iconTheme: 'default',
          children: [],
        })
      ).to.be.null;

      // Null or invalid objects
      expect(getAppLaunchTarget(null)).to.be.null;
      expect(getAppLaunchTarget(undefined)).to.be.null;
    });
  });

  describe('resolveAppOp', () => {
    const runningBinding: RuntimeAppBinding = {
      target: 'TestApp',
      running: true,
      pid: 1234,
      windowId: 42,
      windowsKnown: true,
      originalWorkflow: { actions: [] },
    };

    const safariRunningBinding: RuntimeAppBinding = {
      target: 'Safari',
      running: true,
      pid: 1234,
      windowId: 42,
      windowsKnown: true,
      originalWorkflow: { actions: [] },
    };

    const notRunningBinding: RuntimeAppBinding = {
      target: 'TestApp',
      running: false,
      windowsKnown: false,
      originalWorkflow: { actions: [] },
    };

    const runningUnknownWindowsBinding: RuntimeAppBinding = {
      target: 'TestApp',
      running: true,
      pid: 1234,
      windowsKnown: false,
      originalWorkflow: { actions: [] },
    };

    const defaultConfig: QuickCloseConfig = {
      enabled: true,
      bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
    };

    const disabledConfig: QuickCloseConfig = {
      enabled: false,
      bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
    };

    const defaultContext: QuickCloseContext = {
      tabCloseAvailable: true,
    };

    const mod = (partial: Partial<Modifiers>): Modifiers => ({
      ctrl: false,
      meta: false,
      alt: false,
      shift: false,
      ...partial,
    });

    it('handles unmodified selection: activate when running, launch when not running', () => {
      expect(
        resolveAppOp(NO_MODIFIERS, runningBinding, defaultConfig, defaultContext)
      ).to.equal('activate');
      expect(
        resolveAppOp(NO_MODIFIERS, notRunningBinding, defaultConfig, defaultContext)
      ).to.equal('launch');
    });

    it('handles Control: always quit when running, none when not running', () => {
      expect(
        resolveAppOp(mod({ ctrl: true }), runningBinding, defaultConfig, defaultContext)
      ).to.equal('quit');
      expect(
        resolveAppOp(
          mod({ ctrl: true }),
          runningUnknownWindowsBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('quit');
      expect(
        resolveAppOp(
          mod({ ctrl: true }),
          notRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
    });

    it('handles Meta (Command): close-window when window known, else none', () => {
      expect(
        resolveAppOp(mod({ meta: true }), runningBinding, defaultConfig, defaultContext)
      ).to.equal('close-window');
      expect(
        resolveAppOp(
          mod({ meta: true }),
          runningUnknownWindowsBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ meta: true }),
          notRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
    });

    it('handles Alt (Option): close-tab when window known, context enabled and supported browser', () => {
      expect(
        resolveAppOp(
          mod({ alt: true }),
          safariRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('close-tab');
      expect(
        resolveAppOp(
          mod({ alt: true }),
          runningUnknownWindowsBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(mod({ alt: true }), notRunningBinding, defaultConfig, defaultContext)
      ).to.equal('none');
      // Unsupported browser target fails closed
      expect(
        resolveAppOp(mod({ alt: true }), runningBinding, defaultConfig, defaultContext)
      ).to.equal('none');
      // Tab closing unavailable in context fails closed
      expect(
        resolveAppOp(mod({ alt: true }), safariRunningBinding, defaultConfig, {
          tabCloseAvailable: false,
        })
      ).to.equal('none');
    });

    it('supports tab closing case-insensitively for all 5 browser targets', () => {
      for (const browser of [
        'Vivaldi',
        'google chrome',
        'BRAVE BROWSER',
        'safari',
        'Firefox',
      ]) {
        const binding: RuntimeAppBinding = { ...runningBinding, target: browser };
        expect(
          resolveAppOp(mod({ alt: true }), binding, defaultConfig, defaultContext)
        ).to.equal('close-tab');
      }
    });

    it('handles Meta+Alt (Command+Option): hide when running, none when not running', () => {
      expect(
        resolveAppOp(
          mod({ meta: true, alt: true }),
          runningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('hide');
      expect(
        resolveAppOp(
          mod({ meta: true, alt: true }),
          runningUnknownWindowsBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('hide');
      expect(
        resolveAppOp(
          mod({ meta: true, alt: true }),
          notRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
    });

    it('rejects shift and all other modifier combinations under default config', () => {
      expect(
        resolveAppOp(mod({ shift: true }), runningBinding, defaultConfig, defaultContext)
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ ctrl: true, meta: true }),
          runningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ ctrl: true, alt: true }),
          runningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ ctrl: true, meta: true, alt: true }),
          runningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ meta: true, shift: true }),
          runningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ alt: true, shift: true }),
          runningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
    });

    it('never launches a non-running app when any modifier is pressed', () => {
      expect(
        resolveAppOp(
          mod({ ctrl: true }),
          notRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ meta: true }),
          notRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(mod({ alt: true }), notRunningBinding, defaultConfig, defaultContext)
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ meta: true, alt: true }),
          notRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
      expect(
        resolveAppOp(
          mod({ shift: true }),
          notRunningBinding,
          defaultConfig,
          defaultContext
        )
      ).to.equal('none');
    });

    it('treats all modifiers as none when config.enabled is false', () => {
      expect(
        resolveAppOp(mod({ ctrl: true }), runningBinding, disabledConfig, defaultContext)
      ).to.equal('activate');
      expect(
        resolveAppOp(mod({ meta: true }), runningBinding, disabledConfig, defaultContext)
      ).to.equal('activate');
      expect(
        resolveAppOp(
          mod({ alt: true }),
          safariRunningBinding,
          disabledConfig,
          defaultContext
        )
      ).to.equal('activate');
      expect(
        resolveAppOp(
          mod({ meta: true, alt: true }),
          runningBinding,
          disabledConfig,
          defaultContext
        )
      ).to.equal('activate');
      expect(
        resolveAppOp(
          mod({ ctrl: true }),
          notRunningBinding,
          disabledConfig,
          defaultContext
        )
      ).to.equal('launch');
      expect(
        resolveAppOp(NO_MODIFIERS, notRunningBinding, disabledConfig, defaultContext)
      ).to.equal('launch');
    });

    it('honors custom modifier bindings', () => {
      const customConfig: QuickCloseConfig = {
        enabled: true,
        bindings: {
          quit: { ctrl: false, meta: true, alt: false, shift: true },
          closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
          closeTab: { ctrl: false, meta: false, alt: false, shift: true },
          hide: { ctrl: true, meta: true, alt: false, shift: false },
        },
      };

      expect(
        resolveAppOp(
          mod({ meta: true, shift: true }),
          runningBinding,
          customConfig,
          defaultContext
        )
      ).to.equal('quit');
      expect(
        resolveAppOp(mod({ ctrl: true }), runningBinding, customConfig, defaultContext)
      ).to.equal('close-window');
      expect(
        resolveAppOp(
          mod({ shift: true }),
          safariRunningBinding,
          customConfig,
          defaultContext
        )
      ).to.equal('close-tab');
      expect(
        resolveAppOp(
          mod({ ctrl: true, meta: true }),
          runningBinding,
          customConfig,
          defaultContext
        )
      ).to.equal('hide');
      // Old default combos now return none
      expect(
        resolveAppOp(
          mod({ meta: true, alt: true }),
          runningBinding,
          customConfig,
          defaultContext
        )
      ).to.equal('none');
    });

    it('fails closed when bindings contain duplicate combinations', () => {
      const duplicateConfig: QuickCloseConfig = {
        enabled: true,
        bindings: {
          quit: { ctrl: true, meta: false, alt: false, shift: false },
          closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
          closeTab: { ctrl: false, meta: false, alt: true, shift: false },
          hide: { ctrl: false, meta: true, alt: true, shift: false },
        },
      };

      expect(
        resolveAppOp(mod({ ctrl: true }), runningBinding, duplicateConfig, defaultContext)
      ).to.equal('none');
    });
  });

  describe('translateIpcInteraction', () => {
    const pathMap = new Map<string, DisplayedPathInfo>([
      ['0', { sourcePath: [0] }],
      ['1', { sourcePath: [1] }],
      ['2', { sourcePath: [2], isConvertedParent: true }],
      ['2,0', { sourcePath: [2], isSyntheticChild: true }],
      ['2,1', { sourcePath: [2], isSyntheticChild: true }],
    ]);

    it('always forwards closeMenu unchanged', () => {
      expect(
        translateIpcInteraction(MenuInteractionType.eCloseMenu, [], pathMap)
      ).to.deep.equal({ type: MenuInteractionType.eCloseMenu, path: [] });
    });

    it('maps selectButton on a synthetic child to the source app button path', () => {
      expect(
        translateIpcInteraction(MenuInteractionType.eSelectButton, [2, 1], pathMap)
      ).to.deep.equal({ type: MenuInteractionType.eSelectButton, path: [2] });
    });

    it('suppresses hover and other interactions on synthetic window children', () => {
      expect(translateIpcInteraction(MenuInteractionType.eHoverButton, [2, 0], pathMap))
        .to.be.null;
    });

    it('suppresses interactions on converted parent submenus', () => {
      expect(translateIpcInteraction(MenuInteractionType.eOpenSubmenu, [2], pathMap)).to
        .be.null;
      expect(translateIpcInteraction(MenuInteractionType.eHoverSubmenu, [2], pathMap)).to
        .be.null;
      expect(translateIpcInteraction(MenuInteractionType.eActivateMenu, [2], pathMap)).to
        .be.null;
    });

    it('forwards interactions on non-converted items unchanged', () => {
      expect(
        translateIpcInteraction(MenuInteractionType.eSelectButton, [0], pathMap)
      ).to.deep.equal({ type: MenuInteractionType.eSelectButton, path: [0] });

      expect(
        translateIpcInteraction(MenuInteractionType.eHoverButton, [1], pathMap)
      ).to.deep.equal({ type: MenuInteractionType.eHoverButton, path: [1] });
    });
  });

  describe('resolveAppState', () => {
    function makeFakeBackend(
      supportsAppControl: boolean,
      appStates: Record<string, AppState> = {}
    ): AppControlBackend {
      return {
        getBackendInfo() {
          return { supportsAppControl };
        },
        getAppStates(targets: string[]) {
          return targets.map(
            (t) =>
              appStates[t] ?? {
                running: false,
                windows: [],
                windowsKnown: false,
              }
          );
        },
      };
    }

    function makeMenuRoot(): RootMenuItem {
      return {
        type: 'root',
        name: 'Root',
        icon: 'root.svg',
        iconTheme: 'default',
        children: [
          {
            type: 'button',
            name: 'Regular Button',
            icon: 'btn.svg',
            iconTheme: 'default',
            angle: 45,
            selectWorkflow: {
              actions: [{ type: 'open-settings' }],
            },
          },
          {
            type: 'button',
            name: 'Safari App',
            icon: 'safari.svg',
            iconTheme: 'default',
            angle: 120,
            selectWorkflow: {
              quickSelectKey: 's',
              actions: [makeExecuteAction('open -a Safari'), { type: 'close-menu' }],
            },
          },
          {
            type: 'button',
            name: 'Chrome App',
            icon: 'chrome.svg',
            iconTheme: 'default',
            angle: 200,
            hoverWorkflow: {
              quickSelectKey: 'h',
              actions: [{ type: 'delay', duration: 0.05 }],
            },
            selectWorkflow: {
              quickSelectKey: 'c',
              actions: [
                makeExecuteAction('open -a "Google Chrome"'),
                { type: 'close-menu' },
              ],
            },
          },
          {
            type: 'submenu',
            name: 'Plain Submenu',
            icon: 'sub.svg',
            iconTheme: 'default',
            angle: 300,
            openWorkflow: {
              quickSelectKey: 'p',
              actions: [],
            },
            children: [
              {
                type: 'button',
                name: 'Nested Plain',
                icon: 'nested.svg',
                iconTheme: 'default',
                angle: 15,
                selectWorkflow: { actions: [{ type: 'open-settings' }] },
              },
            ],
          },
        ],
      };
    }

    it('leaves tree untouched when backend does not support app control', () => {
      const backend = makeFakeBackend(false);
      const root = makeMenuRoot();
      const snapshot = JSON.stringify(root);

      const result = resolveAppState(root, backend, 1);
      expect(result.generation).to.equal(1);
      expect(JSON.stringify(root)).to.equal(snapshot);
      expect(result.displayedRoot.children[1].type).to.equal('button');
      expect((result.displayedRoot.children[1] as DisplayedButtonMenuItem).app).to.be
        .undefined;
      expect(result.pathMap.get('1')).to.deep.equal({ sourcePath: [1] });
    });
    it('handles non-running app item', () => {
      const backend = makeFakeBackend(true, {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Safari: { running: false, windows: [], windowsKnown: false },
      });
      const root = makeMenuRoot();
      const result = resolveAppState(root, backend, 2);

      const item = result.displayedRoot.children[1] as DisplayedButtonMenuItem;
      expect(item.type).to.equal('button');
      expect(item.app?.running).to.be.false;
      expect(item.app).to.deep.include({
        target: 'Safari',
        running: false,
        windowsKnown: false,
      });
    });

    it('handles running app with windowsKnown false or 0 windows', () => {
      const backend = makeFakeBackend(true, {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Safari: { running: true, pid: 100, windows: [], windowsKnown: false },
      });
      const root = makeMenuRoot();
      const result = resolveAppState(root, backend, 3);

      const item = result.displayedRoot.children[1] as DisplayedButtonMenuItem;
      expect(item.type).to.equal('button');
      expect(item.app?.running).to.be.true;
      expect(item.app).to.deep.include({
        target: 'Safari',
        running: true,
        pid: 100,
        windowsKnown: false,
      });
      expect(item.app?.windowId).to.be.undefined;
    });

    it('handles running app with exactly 1 window by keeping it a button with windowId', () => {
      const backend = makeFakeBackend(true, {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Safari: {
          running: true,
          pid: 100,
          windowsKnown: true,
          windows: [{ windowId: 55, title: 'Apple' }],
        },
      });
      const root = makeMenuRoot();
      const result = resolveAppState(root, backend, 4);

      const item = result.displayedRoot.children[1] as DisplayedButtonMenuItem;
      expect(item.type).to.equal('button');
      expect(item.app?.running).to.be.true;
      expect(item.app?.windowId).to.equal(55);
      expect(item.app?.windowsKnown).to.be.true;
    });

    it('converts multi-window running app into submenu and maps paths correctly', () => {
      const backend = makeFakeBackend(true, {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Google Chrome': {
          running: true,
          pid: 200,
          windowsKnown: true,
          windows: [
            { windowId: 71, title: 'Google Search' },
            { windowId: 72, title: '' },
          ],
        },
      });
      const root = makeMenuRoot();
      const originalSnapshot = JSON.stringify(root);

      const result = resolveAppState(root, backend, 5);

      // Original root unmutated
      expect(JSON.stringify(root)).to.equal(originalSnapshot);

      // Converted submenu
      const submenu = result.displayedRoot.children[2] as SubmenuMenuItem;
      expect(submenu.type).to.equal('submenu');
      expect(submenu.name).to.equal('Chrome App');
      expect(submenu.openWorkflow?.quickSelectKey).to.equal('c');
      expect(submenu.openWorkflow?.actions).to.deep.equal([]);
      expect(submenu.activateWorkflow).to.be.undefined;
      expect(submenu.children).to.have.lengthOf(2);

      // Window children
      const child0 = submenu.children[0] as ButtonMenuItem & { app?: RuntimeAppBinding };
      expect(child0.type).to.equal('button');
      expect(child0.name).to.equal('Google Search');
      expect(child0.selectWorkflow?.quickSelectKey).to.be.undefined;
      expect(child0.app?.windowId).to.equal(71);

      const child1 = submenu.children[1] as ButtonMenuItem & { app?: RuntimeAppBinding };
      expect(child1.type).to.equal('button');
      expect(child1.name).to.equal('Chrome App (window 2)');
      expect(child1.app?.windowId).to.equal(72);

      // Path mapping: displayed [2] is converted parent, [2, 1] maps to source [2]
      expect(result.pathMap.get('2')).to.deep.equal({
        sourcePath: [2],
        isConvertedParent: true,
      });
      expect(result.pathMap.get('2,1')).to.deep.equal({
        sourcePath: [2],
        isSyntheticChild: true,
      });
    });

    it('handles nested submenus containing app items', () => {
      const backend = makeFakeBackend(true, {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Safari: {
          running: true,
          pid: 100,
          windowsKnown: true,
          windows: [
            { windowId: 1, title: 'Tab 1' },
            { windowId: 2, title: 'Tab 2' },
          ],
        },
      });

      const root: RootMenuItem = {
        type: 'root',
        name: 'Root',
        icon: 'root.svg',
        iconTheme: 'default',
        children: [
          {
            type: 'submenu',
            name: 'Nested',
            icon: 'icon.svg',
            iconTheme: 'default',
            children: [
              {
                type: 'button',
                name: 'Safari',
                icon: 'safari.svg',
                iconTheme: 'default',
                selectWorkflow: {
                  actions: [makeExecuteAction('open -a Safari')],
                },
              },
            ],
          },
        ],
      };

      const result = resolveAppState(root, backend, 6);
      const nestedSubmenu = result.displayedRoot.children[0] as SubmenuMenuItem;
      const convertedSubmenu = nestedSubmenu.children[0] as SubmenuMenuItem;
      expect(convertedSubmenu.type).to.equal('submenu');
      expect(convertedSubmenu.children).to.have.lengthOf(2);
      expect(result.pathMap.get('0,0,1')).to.deep.equal({
        sourcePath: [0, 0],
        isSyntheticChild: true,
      });
    });

    it('keeps the fixed angle of plain items and leaves them deep-equal to their source', () => {
      const backend = makeFakeBackend(true, {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Safari: { running: true, pid: 100, windows: [], windowsKnown: false },
      });
      const root = makeMenuRoot();
      const result = resolveAppState(root, backend, 7);

      // Plain button, untouched by the app switcher.
      expect(result.displayedRoot.children[0]).to.deep.equal(root.children[0]);

      // Plain submenu and its child, including their fixed angles.
      const plainSubmenu = result.displayedRoot.children[3] as SubmenuMenuItem;
      expect(plainSubmenu).to.deep.equal(root.children[3]);
      expect((plainSubmenu.children[0] as ButtonMenuItem).angle).to.equal(15);
    });

    it('keeps the fixed angle of app buttons and of a converted submenu', () => {
      const backend = makeFakeBackend(true, {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Safari: {
          running: true,
          pid: 100,
          windowsKnown: true,
          windows: [{ windowId: 55, title: 'Apple' }],
        },
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Google Chrome': {
          running: true,
          pid: 200,
          windowsKnown: true,
          windows: [
            { windowId: 71, title: 'Google Search' },
            { windowId: 72, title: '' },
          ],
        },
      });
      const root = makeMenuRoot();
      const result = resolveAppState(root, backend, 8);

      // App button with a single known window stays a button and keeps its angle.
      const appButton = result.displayedRoot.children[1] as ButtonMenuItem;
      expect(appButton.angle).to.equal(120);

      // The converted submenu keeps name, icon, iconTheme, angle and hoverWorkflow of
      // the source button (V3.4).
      const converted = result.displayedRoot.children[2] as SubmenuMenuItem;
      const source = root.children[2] as ButtonMenuItem;
      expect(converted.type).to.equal('submenu');
      expect(converted.name).to.equal(source.name);
      expect(converted.icon).to.equal(source.icon);
      expect(converted.iconTheme).to.equal(source.iconTheme);
      expect(converted.angle).to.equal(source.angle);
      expect(converted.angle).to.equal(200);
      expect(converted.hoverWorkflow).to.deep.equal(source.hoverWorkflow);

      // The launch workflow moves into the binding and is not attached to the submenu.
      expect(converted.openWorkflow?.quickSelectKey).to.equal('c');
      expect(converted.openWorkflow?.actions).to.deep.equal([]);
      expect(converted.activateWorkflow).to.be.undefined;
      expect(converted.children.every((child) => child.type === 'button')).to.be.true;
    });
  });

  describe('WorkflowExecutor overrides', () => {
    it('executes actions in order and replaces overridden action', async () => {
      const events: string[] = [];

      const fakeApp = {
        getBackend: () => ({
          inhibitAllShortcuts: async () => {
            events.push('inhibit-start');
            return 42;
          },
          releaseInhibition: async (id: number) => {
            events.push(`inhibit-end-${id}`);
          },
        }),
        getMenuWindow: () => ({
          closeMenu: async () => {
            events.push('close-menu');
          },
        }),
      } as unknown as KandoApp;

      const launchAction = makeExecuteAction('open -a Safari');
      const inhibitAction: WorkflowAction = { type: 'inhibit-shortcuts' };
      const closeAction: WorkflowAction = { type: 'close-menu' };

      const workflow: Workflow = {
        actions: [inhibitAction, launchAction, closeAction],
      };

      const overrides: WorkflowActionOverrides = new Map([
        [
          launchAction,
          async () => {
            events.push('override-launch-op');
          },
        ],
      ]);

      await WorkflowExecutor.getInstance().executeWorkflow(workflow, fakeApp, overrides);

      expect(events).to.deep.equal([
        'inhibit-start',
        'override-launch-op',
        'close-menu',
        'inhibit-end-42',
      ]);
    });

    it('continues workflow and finalizers if override callback throws', async () => {
      const events: string[] = [];

      const fakeApp = {
        getBackend: () => ({
          inhibitAllShortcuts: async () => {
            events.push('inhibit-start');
            return 99;
          },
          releaseInhibition: async (id: number) => {
            events.push(`inhibit-end-${id}`);
          },
        }),
        getMenuWindow: () => ({
          closeMenu: async () => {
            events.push('close-menu');
          },
        }),
      } as unknown as KandoApp;

      const launchAction = makeExecuteAction('open -a Safari');
      const inhibitAction: WorkflowAction = { type: 'inhibit-shortcuts' };
      const closeAction: WorkflowAction = { type: 'close-menu' };

      const workflow: Workflow = {
        actions: [inhibitAction, launchAction, closeAction],
      };

      const overrides: WorkflowActionOverrides = new Map([
        [
          launchAction,
          async () => {
            events.push('override-throw');
            throw new Error('Native controlApp failed');
          },
        ],
      ]);

      await WorkflowExecutor.getInstance().executeWorkflow(workflow, fakeApp, overrides);

      expect(events).to.deep.equal([
        'inhibit-start',
        'override-throw',
        'close-menu',
        'inhibit-end-99',
      ]);
    });

    it('skips cancelled override and close-menu when generation changed during delay before launch [delay, execute-command, close-menu]', async () => {
      const events: string[] = [];
      let currentGen = 1;

      const fakeApp = {
        getBackend: () => ({
          inhibitAllShortcuts: async () => {
            events.push('inhibit-start');
            return 11;
          },
          releaseInhibition: async (id: number) => {
            events.push(`inhibit-end-${id}`);
          },
        }),
        getMenuWindow: () => ({
          closeMenu: async () => {
            events.push('window-close');
          },
        }),
      } as unknown as KandoApp;

      const delayAction: WorkflowAction = { type: 'delay', duration: 0.01 };
      const launchAction = makeExecuteAction('open -a Safari');
      const closeAction: WorkflowAction = { type: 'close-menu' };
      const inhibitAction: WorkflowAction = { type: 'inhibit-shortcuts' };

      const workflow: Workflow = {
        actions: [inhibitAction, delayAction, launchAction, closeAction],
      };

      const host: AppOpOverrideHost = {
        isVisible: () => true,
        displayedGeneration: () => currentGen,
        closeMenu: async () => {
          events.push('host-close');
        },
        awaitHide: async () => 'completed',
        controlApp: () => {
          events.push('native-op');
        },
      };

      const overrides: WorkflowActionOverrides = new Map([
        [
          launchAction,
          createAppOpOverride(host, { target: 'Safari', op: 'activate' }, 1),
        ],
        [closeAction, createCloseMenuOverride(host, 1)],
      ]);

      // Change generation during the delay
      setTimeout(() => {
        currentGen = 2;
        events.push('new-menu-shown');
      }, 3);

      await WorkflowExecutor.getInstance().executeWorkflow(
        workflow,
        fakeApp,
        overrides,
        () => host.displayedGeneration() === 1
      );

      // Verify that neither the launch op nor close-menu ran for stale gen 1,
      // but inhibit finalizer ran.
      expect(events).to.deep.equal(['inhibit-start', 'new-menu-shown', 'inhibit-end-11']);
    });

    it('skips close-menu when generation changed during delay after execute-command [execute-command, delay, close-menu]', async () => {
      const events: string[] = [];
      let currentGen = 1;

      const fakeApp = {
        getBackend: () => ({
          inhibitAllShortcuts: async () => {
            events.push('inhibit-start');
            return 22;
          },
          releaseInhibition: async (id: number) => {
            events.push(`inhibit-end-${id}`);
          },
        }),
        getMenuWindow: () => ({
          closeMenu: async () => {
            events.push('window-close');
          },
        }),
      } as unknown as KandoApp;

      const launchAction = makeExecuteAction('open -a Safari');
      const delayAction: WorkflowAction = { type: 'delay', duration: 0.01 };
      const closeAction: WorkflowAction = { type: 'close-menu' };
      const inhibitAction: WorkflowAction = { type: 'inhibit-shortcuts' };

      const workflow: Workflow = {
        actions: [inhibitAction, launchAction, delayAction, closeAction],
      };

      const host: AppOpOverrideHost = {
        isVisible: () => true,
        displayedGeneration: () => currentGen,
        closeMenu: async () => {
          events.push('host-close');
        },
        awaitHide: async () => 'completed',
        controlApp: () => {
          events.push('native-op');
        },
      };

      const overrides: WorkflowActionOverrides = new Map([
        [
          launchAction,
          createAppOpOverride(host, { target: 'Safari', op: 'activate' }, 1),
        ],
        [closeAction, createCloseMenuOverride(host, 1)],
      ]);

      // Change generation during the delay
      setTimeout(() => {
        currentGen = 2;
        events.push('new-menu-shown');
      }, 3);

      await WorkflowExecutor.getInstance().executeWorkflow(
        workflow,
        fakeApp,
        overrides,
        () => host.displayedGeneration() === 1
      );

      // Verify: launchAction ran for gen 1, delay waited, gen changed,
      // close-menu was skipped (did not close newer menu), and inhibit finalizer ran.
      expect(events).to.deep.equal([
        'inhibit-start',
        'host-close',
        'native-op',
        'new-menu-shown',
        'inhibit-end-22',
      ]);
    });
  });

  describe('decideAppSelection', () => {
    const launchAction = makeExecuteAction('open -a Safari');
    const closeAction: WorkflowAction = { type: 'close-menu' };
    const originalWorkflow: Workflow = { actions: [launchAction, closeAction] };
    const config: QuickCloseConfig = {
      enabled: true,
      bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
    };
    const context: QuickCloseContext = {
      tabCloseAvailable: true,
    };

    it('returns null for non-app items', () => {
      const item: ButtonMenuItem = {
        type: 'button',
        name: 'Normal',
        icon: 'icon',
        iconTheme: 'theme',
        selectWorkflow: { actions: [closeAction] },
      };
      expect(decideAppSelection(item, NO_MODIFIERS, config, context)).to.be.null;
    });

    it('returns launch without override for unmodified non-running app', () => {
      const item = {
        type: 'button',
        name: 'Safari',
        icon: 'icon',
        iconTheme: 'theme',
        selectWorkflow: originalWorkflow,
        app: {
          target: 'Safari',
          running: false,
          windowsKnown: false,
          originalWorkflow,
        },
      };

      const decision = decideAppSelection(item, NO_MODIFIERS, config, context);
      expect(decision).to.not.be.null;
      expect(decision?.op).to.equal('launch');
      expect(decision?.launchActionToOverride).to.be.undefined;
      expect(decision?.workflowToExecute).to.equal(originalWorkflow);
    });

    it('overrides launch action with none for modified non-running app', () => {
      const item = {
        type: 'button',
        name: 'Safari',
        icon: 'icon',
        iconTheme: 'theme',
        selectWorkflow: originalWorkflow,
        app: {
          target: 'Safari',
          running: false,
          windowsKnown: false,
          originalWorkflow,
        },
      };

      const decision = decideAppSelection(
        item,
        {
          ctrl: true,
          meta: false,
          alt: false,
          shift: false,
        },
        config,
        context
      );
      expect(decision).to.not.be.null;
      expect(decision?.op).to.equal('none');
      expect(decision?.launchActionToOverride).to.equal(launchAction);
    });

    it('overrides launch action with activate for unmodified running app', () => {
      const item = {
        type: 'button',
        name: 'Safari',
        icon: 'icon',
        iconTheme: 'theme',
        selectWorkflow: originalWorkflow,
        app: {
          target: 'Safari',
          running: true,
          pid: 10,
          windowsKnown: true,
          windowId: 50,
          originalWorkflow,
        },
      };

      const decision = decideAppSelection(item, NO_MODIFIERS, config, context);
      expect(decision).to.not.be.null;
      expect(decision?.op).to.equal('activate');
      expect(decision?.launchActionToOverride).to.equal(launchAction);
    });

    it('uses originalWorkflow from binding for window child with empty selectWorkflow', () => {
      const childItem = {
        type: 'button',
        name: 'Safari (window 1)',
        icon: 'icon',
        iconTheme: 'theme',
        selectWorkflow: { actions: [] as WorkflowAction[] },
        app: {
          target: 'Safari',
          running: true,
          pid: 10,
          windowsKnown: true,
          windowId: 101,
          originalWorkflow,
        },
      };

      const decision = decideAppSelection(
        childItem,
        {
          ctrl: false,
          meta: true,
          alt: false,
          shift: false,
        },
        config,
        context
      );
      expect(decision).to.not.be.null;
      expect(decision?.op).to.equal('close-window');
      expect(decision?.workflowToExecute).to.equal(originalWorkflow);
      expect(decision?.launchActionToOverride).to.equal(launchAction);
    });

    it('fails closed when the workflow holds no launch action to replace', () => {
      const workflowWithoutLaunch: Workflow = {
        actions: [{ type: 'delay', duration: 0.1 }],
      };
      const item = {
        type: 'button',
        name: 'Safari',
        icon: 'icon',
        iconTheme: 'theme',
        selectWorkflow: workflowWithoutLaunch,
        app: {
          target: 'Safari',
          running: true,
          pid: 10,
          windowsKnown: true,
          windowId: 50,
          originalWorkflow: workflowWithoutLaunch,
        },
      };

      const decision = decideAppSelection(
        item,
        {
          ctrl: true,
          meta: false,
          alt: false,
          shift: false,
        },
        config,
        context
      );

      expect(decision).to.not.be.null;
      expect(decision?.op).to.equal('none');
      expect(decision?.launchActionToOverride).to.be.undefined;
      expect(decision?.workflowToExecute.actions).to.deep.equal([{ type: 'close-menu' }]);
    });

    it('treats modified click as unmodified when Quick close is disabled', () => {
      const disabledConfig: QuickCloseConfig = {
        enabled: false,
        bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
      };
      const item = {
        type: 'button',
        name: 'Safari',
        icon: 'icon',
        iconTheme: 'theme',
        selectWorkflow: originalWorkflow,
        app: {
          target: 'Safari',
          running: true,
          pid: 10,
          windowsKnown: true,
          windowId: 50,
          originalWorkflow,
        },
      };
      const decision = decideAppSelection(
        item,
        { ctrl: true, meta: false, alt: false, shift: false },
        disabledConfig,
        context
      );
      expect(decision?.op).to.equal('activate');
    });
  });

  describe('isStaleInteraction', () => {
    it('drops interactions of a generation which is no longer displayed', () => {
      expect(isStaleInteraction(4, 5)).to.be.true;
      expect(isStaleInteraction(6, 5)).to.be.true;
    });

    it('keeps interactions of the current generation', () => {
      expect(isStaleInteraction(5, 5)).to.be.false;
    });

    it('drops interactions which carry no valid positive generation', () => {
      expect(isStaleInteraction(undefined, 5)).to.be.true;
      expect(isStaleInteraction(0, 5)).to.be.true;
      expect(isStaleInteraction(-1, 5)).to.be.true;
      expect(isStaleInteraction(NaN, 5)).to.be.true;
    });
  });

  describe('show-menu generation contract', () => {
    const rootItem: RootMenuItem = {
      type: 'root',
      name: 'Root',
      icon: 'root.svg',
      iconTheme: 'default',
      children: [],
    };

    const options: ShowMenuOptions = {
      mousePosition: { x: 0, y: 0 },
      windowSize: { x: 800, y: 600 },
      zoomFactor: 1,
      useFixedPosition: false,
      fixedMenuPosition: { x: 0, y: 0 },
      anchoredMode: false,
      hoverMode: false,
      systemIconsChanged: false,
    };
    const environment = {
      appName: 'Finder',
      windowName: 'Desktop',
      windowPosition: { x: 0, y: 0 },
    };

    it('extracts the generation from the real main payload shape', () => {
      // Main sends (root, menuOptions, environmentInfo, generation).
      const parsed = parseShowMenuArgs(rootItem, options, environment, 7);
      expect(parsed.generation).to.equal(7);
      expect(parsed.root).to.equal(rootItem);
      expect(parsed.menuOptions).to.equal(options);
      expect(parsed.environmentInfo).to.equal(environment);
    });

    it('normalises missing or non-positive generations to 0', () => {
      expect(normalizeMenuGeneration(undefined)).to.equal(0);
      expect(normalizeMenuGeneration(0)).to.equal(0);
      expect(normalizeMenuGeneration(-2)).to.equal(0);
      expect(normalizeMenuGeneration('7')).to.equal(0);
      expect(normalizeMenuGeneration(environment)).to.equal(0);
      expect(normalizeMenuGeneration(7)).to.equal(7);
    });

    it('stamps the installed generation onto the finalized interaction', () => {
      const parsed = parseShowMenuArgs(rootItem, options, environment, 42);
      const stamped = stampInteraction(
        MenuInteractionType.eOpenMenu,
        [],
        0,
        SelectionSource.eUnknown,
        NO_MODIFIERS,
        parsed.generation
      );

      // The 6th parameter is the generation
      expect(stamped[5]).to.equal(42);
      expect(isStaleInteraction(stamped[5], 42)).to.be.false;
    });
  });

  describe('trigger-interaction contract & RendererMenuCoordinator', () => {
    it('parses trigger-interaction arguments and normalises the generation', () => {
      const parsedValid = parseTriggerInteractionArgs(MenuInteractionType.eCloseMenu, 5);
      expect(parsedValid.type).to.equal(MenuInteractionType.eCloseMenu);
      expect(parsedValid.generation).to.equal(5);

      const parsedUnstamped = parseTriggerInteractionArgs(MenuInteractionType.eCloseMenu);
      expect(parsedUnstamped.generation).to.equal(0);

      const parsedInvalid = parseTriggerInteractionArgs(
        MenuInteractionType.eCloseSubmenu,
        -3
      );
      expect(parsedInvalid.type).to.equal(MenuInteractionType.eCloseSubmenu);
      expect(parsedInvalid.generation).to.equal(0);
    });

    it('pure helper canInstallPendingShow rejects stale, cancelled, or unstamped shows', () => {
      expect(canInstallPendingShow(0, 1, 0)).to.be.false;
      // Superseded: latest requested is 2, pending is 1
      expect(canInstallPendingShow(1, 2, 0)).to.be.false;
      // Cancelled: pending is 1, cancelledUpTo is 1
      expect(canInstallPendingShow(1, 1, 1)).to.be.false;
      // Cancelled by a higher generation close
      expect(canInstallPendingShow(1, 1, 2)).to.be.false;
      // Valid: pending is 2, latest is 2, cancelledUpTo is 1
      expect(canInstallPendingShow(2, 2, 1)).to.be.true;
    });

    it('pure helper handleRendererCloseTrigger computes acks and protects newer windows', () => {
      // Case 1: uninstalled show (displayed is 0), close trigger 3
      const res1 = handleRendererCloseTrigger(3, 0, 0);
      expect(res1.ackGeneration).to.equal(3);
      expect(res1.shouldHideInstalled).to.be.false;
      expect(res1.newCancelledUpTo).to.equal(3);

      // Case 2: installed show 2, close trigger 3
      const res2 = handleRendererCloseTrigger(3, 2, 0);
      expect(res2.ackGeneration).to.equal(3);
      expect(res2.shouldHideInstalled).to.be.true;
      expect(res2.newCancelledUpTo).to.equal(3);

      // Case 3: installed show 4, stale close trigger 2
      const res3 = handleRendererCloseTrigger(2, 4, 1);
      expect(res3.ackGeneration).to.equal(2);
      expect(res3.shouldHideInstalled).to.be.false;
      expect(res3.newCancelledUpTo).to.equal(2);

      // Case 4: unstamped close trigger
      const res4 = handleRendererCloseTrigger(0, 2, 0);
      expect(res4.ackGeneration).to.equal(0);
      expect(res4.shouldHideInstalled).to.be.true;
      expect(res4.newCancelledUpTo).to.equal(0);
    });

    it('cancels pending show when close trigger arrives before installation finishes', () => {
      const coordinator = new RendererMenuCoordinator();

      coordinator.recordShowRequest(1);
      expect(coordinator.latestRequested).to.equal(1);

      // Host requests close for generation 1 while async work is pending
      let acked = 0;
      let hideCalled = false;
      coordinator.closeFromHost(1, {
        hideInstalled: () => {
          hideCalled = true;
        },
        sendAck: (ackGen) => {
          acked = ackGen;
        },
      });

      expect(acked).to.equal(1);
      expect(hideCalled).to.be.false;
      expect(coordinator.cancelledUpTo).to.equal(1);

      // Async work finishes: show 1 must NOT install
      expect(coordinator.canInstall(1)).to.be.false;

      // Newer show 2 arrives and can install
      coordinator.recordShowRequest(2);
      expect(coordinator.canInstall(2)).to.be.true;
      coordinator.recordInstalled(2);
      expect(coordinator.displayedMenuGeneration).to.equal(2);
    });

    it('acknowledges close with trigger generation even when installed tree is older', () => {
      const coordinator = new RendererMenuCoordinator();

      // Show 1 installed
      coordinator.recordShowRequest(1);
      coordinator.recordInstalled(1);
      expect(coordinator.displayedMenuGeneration).to.equal(1);

      // Show 2 requested (pending icon reload)
      coordinator.recordShowRequest(2);

      // Close requested for generation 2
      let acked = 0;
      let hideCalled = false;
      coordinator.closeFromHost(2, {
        hideInstalled: () => {
          hideCalled = true;
        },
        sendAck: (ackGen) => {
          acked = ackGen;
        },
      });

      // Acknowledges 2 (NOT 1!) and hides installed tree 1
      expect(acked).to.equal(2);
      expect(hideCalled).to.be.true;
      expect(coordinator.displayedMenuGeneration).to.equal(0);

      // Show 2 finishes icon reload and must not install
      expect(coordinator.canInstall(2)).to.be.false;
    });

    it('does not hide newer window when receiving a stale close trigger', () => {
      const coordinator = new RendererMenuCoordinator();

      coordinator.recordShowRequest(3);
      coordinator.recordInstalled(3);

      let acked = 0;
      let hideCalled = false;
      coordinator.closeFromHost(2, {
        hideInstalled: () => {
          hideCalled = true;
        },
        sendAck: (ackGen) => {
          acked = ackGen;
        },
      });

      expect(acked).to.equal(2);
      expect(hideCalled).to.be.false;
      expect(coordinator.displayedMenuGeneration).to.equal(3);
    });

    it('preserves displayedMenuGeneration and stamps the next interaction when receiving a stale close trigger', () => {
      const coordinator = new RendererMenuCoordinator();
      let displayedMenuGeneration = 0;

      // Menu generation G+1 (3) is installed
      coordinator.recordShowRequest(3);
      coordinator.recordInstalled(3);
      displayedMenuGeneration = coordinator.displayedMenuGeneration;

      let acked = 0;
      let hideCalled = false;
      coordinator.closeFromHost(2, {
        hideInstalled: () => {
          hideCalled = true;
          displayedMenuGeneration = 0;
        },
        sendAck: (ackGen, didHideInstalled) => {
          acked = ackGen;
          if (didHideInstalled) {
            displayedMenuGeneration = 0;
          }
        },
      });

      expect(acked).to.equal(2);
      expect(hideCalled).to.be.false;
      expect(coordinator.displayedMenuGeneration).to.equal(3);
      expect(displayedMenuGeneration).to.equal(3);

      // Subsequent interaction on the still-installed menu G+1 must be stamped with G+1 (3)
      const nextInteraction = stampInteraction(
        MenuInteractionType.eSelectButton,
        [0],
        100,
        SelectionSource.eClick,
        NO_MODIFIERS,
        displayedMenuGeneration
      );
      expect(nextInteraction[0]).to.equal(MenuInteractionType.eSelectButton);
      expect(nextInteraction[3]).to.equal(SelectionSource.eClick);
      expect(nextInteraction[5]).to.equal(3);
      expect(isStaleInteraction(nextInteraction[5], 3)).to.be.false;
    });

    it('flags isClosingFromHost while hideInstalled runs to suppress duplicate interaction stamping', () => {
      const coordinator = new RendererMenuCoordinator();
      coordinator.recordShowRequest(1);
      coordinator.recordInstalled(1);

      let duringHideClosingFlag = false;
      coordinator.closeFromHost(1, {
        hideInstalled: () => {
          duringHideClosingFlag = coordinator.isClosingFromHost;
        },
        sendAck: () => {},
      });

      expect(duringHideClosingFlag).to.be.true;
      expect(coordinator.isClosingFromHost).to.be.false;
    });
  });

  describe('MenuHideCoordinator', () => {
    function makeScheduler() {
      const pending = new Map<number, () => void>();
      let nextHandle = 1;

      return {
        scheduler: (callback: () => void) => {
          const handle = nextHandle++;
          pending.set(handle, callback);
          return () => {
            pending.delete(handle);
          };
        },
        runAll() {
          const callbacks = [...pending.values()];
          pending.clear();
          for (const callback of callbacks) {
            callback();
          }
        },
        pendingCount() {
          return pending.size;
        },
      };
    }

    function makeCoordinator() {
      const host = {
        hidePlatformWindow: () => {
          host.hidden += 1;
        },
        requestClose: (generation?: number) => {
          host.closed += 1;
          host.lastCloseGeneration = generation;
        },
        hidden: 0,
        closed: 0,
        lastCloseGeneration: undefined as number | undefined,
      };
      const fakeTimers = makeScheduler();
      const coordinator = new MenuHideCoordinator(host, fakeTimers.scheduler);
      return { coordinator, host, fakeTimers };
    }

    it('completes a hide after the fade-out and reports it to waiters', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      coordinator.startGeneration();
      coordinator.show();

      coordinator.markHiding();
      const hide = coordinator.hide(200);
      const awaited = coordinator.awaitHide(coordinator.displayedGeneration);
      fakeTimers.runAll();

      expect(await hide).to.equal('completed');
      expect(await awaited).to.equal('completed');
      expect(host.hidden).to.equal(1);
    });

    it('reports a completed hide to a waiter which starts after the fade-out', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      const generation = coordinator.startGeneration();
      coordinator.show();

      coordinator.markHiding();
      const hide = coordinator.hide(200);
      fakeTimers.runAll();
      expect(await hide).to.equal('completed');

      expect(await coordinator.awaitHide(generation)).to.equal('completed');
      expect(host.hidden).to.equal(1);
    });

    it('does not report a hide as completed before the platform hide ran', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();
      const generation = coordinator.startGeneration();
      coordinator.show();

      // Preparation starts before the shortcut is released.
      coordinator.markHiding();

      let settled = false;
      const awaited = coordinator.awaitHide(generation).then((r) => {
        settled = true;
        return r;
      });

      await Promise.resolve();
      expect(settled).to.be.false;
      expect(host.hidden).to.equal(0);

      // Now arm the fade and run timers.
      const hide = coordinator.hide(200);
      fakeTimers.runAll();

      expect(await hide).to.equal('completed');
      expect(await awaited).to.equal('completed');
      expect(host.hidden).to.equal(1);
    });

    it('cancels the hide and settles waiters when a new menu is shown during the fade', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      const generation = coordinator.startGeneration();
      coordinator.show();

      coordinator.markHiding();
      const hide = coordinator.hide(200);
      const awaited = coordinator.awaitHide(generation);

      // A new menu opens while the old one is still fading out. The old fade-out must not
      // keep anything waiting forever.
      coordinator.startGeneration();
      coordinator.show();

      expect(await hide).to.equal('cancelled');
      expect(await awaited).to.equal('cancelled');
      expect(fakeTimers.pendingCount()).to.equal(0);
      expect(host.hidden).to.equal(0);
    });

    it('cancels a prepared hide when a new menu is shown before the fade-out starts', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();
      const generation = coordinator.startGeneration();
      coordinator.show();

      coordinator.markHiding();
      const awaited = coordinator.awaitHide(generation);

      // A new menu opens while the old hide was still releasing its shortcut inhibition.
      coordinator.startGeneration();
      coordinator.show();

      const hide = coordinator.hide(200);
      expect(await hide).to.equal('cancelled');
      expect(await awaited).to.equal('cancelled');
      expect(fakeTimers.pendingCount()).to.equal(0);
      expect(host.hidden).to.equal(0);
    });

    it('sends one close trigger per close request and settles it later', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      const generation = coordinator.startGeneration();
      coordinator.show();

      const first = coordinator.close();
      const second = coordinator.close();

      expect(host.closed).to.equal(1);

      coordinator.markHiding();
      const hide = coordinator.hide(1);
      fakeTimers.runAll();
      await hide;
      coordinator.settleCloseRequest(generation);

      await first;
      await second;
    });

    it('still sends a trigger for a close requested after a reopen during a fade', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      coordinator.startGeneration();
      coordinator.show();

      // A close is requested, then a new menu opens before the close was confirmed. The
      // stale close request must be cleared, else it would swallow every later close.
      const pendingClose = coordinator.close();
      coordinator.startGeneration();
      coordinator.show();
      await pendingClose;

      const nextGeneration = coordinator.displayedGeneration;
      const nextClose = coordinator.close();
      expect(host.closed).to.equal(2);

      coordinator.markHiding();
      const hide = coordinator.hide(1);
      fakeTimers.runAll();
      await hide;
      coordinator.settleCloseRequest(nextGeneration);
      await nextClose;
    });

    it('does not settle a newer close request from an older generation acknowledgement', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      const firstGeneration = coordinator.startGeneration();
      coordinator.show();
      const firstClose = coordinator.close();

      // New menu shown: cancels and settles the first close.
      const secondGeneration = coordinator.startGeneration();
      coordinator.show();
      await firstClose;

      const secondClose = coordinator.close();
      expect(host.closed).to.equal(2);

      // Stale close acknowledgment of the first menu arrives.
      coordinator.settleCloseRequest(firstGeneration);

      let settled = false;
      secondClose.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).to.be.false;

      // The second close settles only when its own hide finishes.
      coordinator.markHiding();
      const hide = coordinator.hide(1);
      fakeTimers.runAll();
      await hide;
      coordinator.settleCloseRequest(secondGeneration);
      await secondClose;
    });

    it('cancels a pending uninstalled show on close, settles the close request, and sends a trigger for a later close', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();
      const rendererCoordinator = new RendererMenuCoordinator();

      // Main starts Show 1 (generation 1)
      const gen1 = coordinator.startGeneration();
      expect(gen1).to.equal(1);
      coordinator.show();

      // Renderer receives show-menu for generation 1 and begins async preparation
      rendererCoordinator.recordShowRequest(gen1);

      // Close requested for generation 1 while Show 1 is still pending (uninstalled)
      const close1 = coordinator.close();
      expect(host.closed).to.equal(1);
      expect(host.lastCloseGeneration).to.equal(1);

      // Renderer handles close trigger for generation 1
      let ackedGeneration = 0;
      rendererCoordinator.closeFromHost(host.lastCloseGeneration!, {
        hideInstalled: () => {},
        sendAck: (ackGen) => {
          ackedGeneration = ackGen;
        },
      });
      expect(ackedGeneration).to.equal(1);

      // Main receives acknowledgement stamped with generation 1 and settles close request
      coordinator.markHiding();
      const hide1 = coordinator.hide(1);
      fakeTimers.runAll();
      await hide1;
      coordinator.settleCloseRequest(ackedGeneration);
      await close1;

      // Show 1 async preparation completes: it must NOT install
      expect(rendererCoordinator.canInstall(gen1)).to.be.false;

      // Later, main shows a new menu (generation 2)
      const gen2 = coordinator.startGeneration();
      expect(gen2).to.equal(2);
      coordinator.show();
      rendererCoordinator.recordShowRequest(gen2);
      expect(rendererCoordinator.canInstall(gen2)).to.be.true;
      rendererCoordinator.recordInstalled(gen2);

      // Later close() on generation 2 still sends a new trigger with generation 2
      const close2 = coordinator.close();
      expect(host.closed).to.equal(2);
      expect(host.lastCloseGeneration).to.equal(2);

      // Settle second close
      coordinator.markHiding();
      const hide2 = coordinator.hide(1);
      fakeTimers.runAll();
      await hide2;
      coordinator.settleCloseRequest(gen2);
      await close2;
    });

    it('skips the native operation when a show cancels the awaited hide', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      const generation = coordinator.startGeneration();
      coordinator.show();

      const pending = coordinator.close();
      coordinator.markHiding();
      const hide = coordinator.hide(1);
      const awaited = coordinator.awaitHide(generation);

      // A new menu opens during the fade.
      coordinator.startGeneration();
      coordinator.show();

      expect(await hide).to.equal('cancelled');
      expect(await awaited).to.equal('cancelled');
      expect(host.hidden).to.equal(0);

      await pending;
      expect(fakeTimers.pendingCount()).to.equal(0);
    });

    it('fails closed when no hide was ever started for the displayed generation', async () => {
      const { coordinator } = makeCoordinator();
      const generation = coordinator.startGeneration();
      coordinator.show();

      expect(await coordinator.awaitHide(generation)).to.equal('cancelled');
    });

    it('tracks request tokens across deferred awaits and rejects superseded requests', async () => {
      const { coordinator } = makeCoordinator();

      // Request 1 arrives and gets a token
      const token1 = coordinator.allocateRequestToken();
      expect(coordinator.isRequestCurrent(token1)).to.be.true;

      // Request 1 performs an asynchronous await (deferred promise)
      let resolveDeferred!: () => void;
      const deferredPromise = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
      });

      // While Request 1 is awaiting, Request 2 arrives and gets a token
      const token2 = coordinator.allocateRequestToken();
      expect(coordinator.isRequestCurrent(token1)).to.be.false;
      expect(coordinator.isRequestCurrent(token2)).to.be.true;

      // Request 2 commits its generation
      const gen2 = coordinator.startGeneration(token2);
      expect(gen2).to.equal(1);
      coordinator.show();

      // Request 1's await now completes
      resolveDeferred();
      await deferredPromise;

      // Request 1 checks if it was superseded
      expect(coordinator.isRequestCurrent(token1)).to.be.false;
      const gen1 = coordinator.startGeneration(token1);
      expect(gen1).to.be.null;

      // The coordinator's displayed generation is still 1 (committed by Request 2)
      expect(coordinator.displayedGeneration).to.equal(1);
    });

    it('cancels pending hide, settles waiters, and restores truthful visibility when shortcut release fails', async () => {
      const { coordinator } = makeCoordinator();
      const generation = coordinator.startGeneration();
      coordinator.show();

      expect(coordinator.isVisible).to.be.true;

      coordinator.markHiding();
      expect(coordinator.isVisible).to.be.false;

      const awaited = coordinator.awaitHide(generation);

      // Shortcut release fails in hideWindow
      coordinator.cancelPendingHide();

      // Visibility is restored truthfully to true and waiters settle with 'cancelled'
      expect(coordinator.isVisible).to.be.true;
      expect(await awaited).to.equal('cancelled');
    });

    it('settles waiters as cancelled and restores visibility when platform hide throws', async () => {
      const host = {
        hidePlatformWindow: () => {
          throw new Error('Platform hide failed');
        },
        requestClose: () => {},
      };
      const fakeTimers = makeScheduler();
      const coordinator = new MenuHideCoordinator(host, fakeTimers.scheduler);

      const generation = coordinator.startGeneration();
      coordinator.show();

      coordinator.markHiding();
      const hidePromise = coordinator.hide(100);
      const waiterPromise = coordinator.awaitHide(generation);

      // Run fade timer; completeHide invokes throwing platform hide
      fakeTimers.runAll();

      expect(await hidePromise).to.equal('cancelled');
      expect(await waiterPromise).to.equal('cancelled');
      expect(coordinator.isVisible).to.be.true;
    });

    it('ensures hide preparation owns its continuation across replacement and another pending hide', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      // Menu 1 is shown
      const gen1 = coordinator.startGeneration();
      coordinator.show();

      // Menu 1 prepares hide
      const record1 = coordinator.markHiding();
      const waiter1 = coordinator.awaitHide(gen1);

      // While Menu 1 is awaiting shortcut release, Menu 2 opens and also prepares hide
      const gen2 = coordinator.startGeneration();
      coordinator.show();
      const record2 = coordinator.markHiding();
      const waiter2 = coordinator.awaitHide(gen2);

      // Stale continuation of Menu 1 resumes and calls hide with record1
      const hide1 = coordinator.hide(200, record1);
      expect(await hide1).to.equal('cancelled');
      expect(await waiter1).to.equal('cancelled');

      // Menu 2's hide was NOT affected or armed by Menu 1
      expect(host.hidden).to.equal(0);

      // Menu 2's continuation resumes and arms its hide
      const hide2 = coordinator.hide(200, record2);
      fakeTimers.runAll();

      expect(await hide2).to.equal('completed');
      expect(await waiter2).to.equal('completed');
      expect(host.hidden).to.equal(1);
    });

    it('does not cancel newer hide or restore visibility when a stale hide release rejects', async () => {
      const { coordinator, host, fakeTimers } = makeCoordinator();

      // Menu A is shown
      const genA = coordinator.startGeneration();
      coordinator.show();
      expect(coordinator.isVisible).to.be.true;

      // Hide A prepares hide
      const recordA = coordinator.markHiding();
      expect(coordinator.isVisible).to.be.false;
      const waiterA = coordinator.awaitHide(genA);

      // While A is awaiting release, Menu B opens and prepares its own hide
      const genB = coordinator.startGeneration();
      coordinator.show();
      expect(coordinator.isVisible).to.be.true;
      const recordB = coordinator.markHiding();
      expect(coordinator.isVisible).to.be.false;
      const waiterB = coordinator.awaitHide(genB);

      // A's release rejects and triggers cancelPendingHide(recordA)
      coordinator.cancelPendingHide(recordA);

      // A's waiter settles as cancelled
      expect(await waiterA).to.equal('cancelled');

      // B's hide must be untouched and visibility must NOT be restored
      expect(coordinator.isVisible).to.be.false;

      // B arms and completes its hide normally
      const hideB = coordinator.hide(200, recordB);
      fakeTimers.runAll();

      expect(await hideB).to.equal('completed');
      expect(await waiterB).to.equal('completed');
      expect(host.hidden).to.equal(1);
    });
  });

  describe('createAppOpOverride', () => {
    it('closes the menu before invoking the native operation', async () => {
      const events: string[] = [];
      const host: AppOpOverrideHost = {
        isVisible: () => true,
        displayedGeneration: () => 1,
        closeMenu: async () => {
          events.push('close-menu');
        },
        awaitHide: async () => {
          events.push('hide-completed');
          return 'completed';
        },
        controlApp: (target, op) => {
          events.push(`control:${target}:${op}`);
        },
      };

      const override = createAppOpOverride(host, { target: 'Safari', op: 'quit' }, 1);

      await override();
      expect(events).to.deep.equal([
        'close-menu',
        'hide-completed',
        'control:Safari:quit',
      ]);
    });

    it('skips the native operation if a newer menu replaced the selection', async () => {
      const events: string[] = [];
      const host: AppOpOverrideHost = {
        isVisible: () => true,
        displayedGeneration: () => 2, // newer generation
        closeMenu: async () => {
          events.push('close-menu');
        },
        awaitHide: async () => 'completed',
        controlApp: () => {
          events.push('control');
        },
      };

      const override = createAppOpOverride(
        host,
        { target: 'Safari', op: 'quit' },
        1 // captured generation 1
      );

      await override();
      expect(events).to.deep.equal([]);
    });

    it('skips the native operation when the awaited hide is cancelled', async () => {
      const events: string[] = [];
      const host: AppOpOverrideHost = {
        isVisible: () => true,
        displayedGeneration: () => 1,
        closeMenu: async () => {
          events.push('close-menu');
        },
        awaitHide: async () => {
          events.push('hide-cancelled');
          return 'cancelled';
        },
        controlApp: () => {
          events.push('control');
        },
      };

      const override = createAppOpOverride(
        host,
        { target: 'Safari', op: 'close-window' },
        1
      );

      await override();
      expect(events).to.deep.equal(['close-menu', 'hide-cancelled']);
    });
    it('skips the native operation if the generation changes after hide resolves but before override resumes', async () => {
      const events: string[] = [];
      let currentGen = 1;
      let resolveHide!: (res: 'completed' | 'cancelled') => void;
      const hidePromise = new Promise<'completed' | 'cancelled'>((resolve) => {
        resolveHide = resolve;
      });

      const host: AppOpOverrideHost = {
        isVisible: () => false,
        displayedGeneration: () => currentGen,
        closeMenu: async () => {
          events.push('close-menu');
        },
        awaitHide: () => {
          // Simulate concurrent re-open task attached before the override continuation
          hidePromise.then(() => {
            currentGen = 2;
          });
          return hidePromise;
        },
        controlApp: (target, op) => {
          events.push(`control:${target}:${op}`);
        },
      };

      const override = createAppOpOverride(host, { target: 'Safari', op: 'quit' }, 1);
      const overridePromise = override();

      resolveHide('completed');
      await overridePromise;

      expect(events).to.be.empty;
    });

    it('skips the native operation if the generation changes after closeMenu resolves', async () => {
      const events: string[] = [];
      let currentGen = 1;

      const host: AppOpOverrideHost = {
        isVisible: () => true,
        displayedGeneration: () => currentGen,
        closeMenu: async () => {
          events.push('close-menu');
          // Re-open allocates G+1 during closeMenu
          currentGen = 2;
        },
        awaitHide: async () => {
          events.push('await-hide');
          return 'completed';
        },
        controlApp: (target, op) => {
          events.push(`control:${target}:${op}`);
        },
      };

      const override = createAppOpOverride(host, { target: 'Safari', op: 'quit' }, 1);
      await override();

      expect(events).to.deep.equal(['close-menu']);
    });

    it('orders close-menu correctly around the override in workflows', async () => {
      // Tests absent, preceding, and following close-menu actions
      const launchAction = makeExecuteAction('open -a Safari');
      const closeAction: WorkflowAction = { type: 'close-menu' };

      // Case 1: absent close-menu action in workflow
      const absentEvents: string[] = [];
      const absentHost: AppOpOverrideHost = {
        isVisible: () => true,
        displayedGeneration: () => 1,
        closeMenu: async () => {
          absentEvents.push('override-close');
        },
        awaitHide: async () => 'completed',
        controlApp: () => {
          absentEvents.push('native-op');
        },
      };
      const fakeAppAbsent = {
        getBackend: () => ({}),
        getMenuWindow: () => ({
          closeMenu: async () => {
            absentEvents.push('action-close');
          },
        }),
      } as unknown as KandoApp;

      const absentWorkflow: Workflow = { actions: [launchAction] };
      await WorkflowExecutor.getInstance().executeWorkflow(
        absentWorkflow,
        fakeAppAbsent,
        new Map([
          [
            launchAction,
            createAppOpOverride(absentHost, { target: 'Safari', op: 'activate' }, 1),
          ],
        ])
      );
      expect(absentEvents).to.deep.equal(['override-close', 'native-op']);

      // Case 2: preceding close-menu action in workflow
      const precedingEvents: string[] = [];
      let precedingVisible = true;
      const precedingHost: AppOpOverrideHost = {
        isVisible: () => precedingVisible,
        displayedGeneration: () => 1,
        closeMenu: async () => {
          precedingEvents.push('override-close');
          precedingVisible = false;
        },
        awaitHide: async () => 'completed',
        controlApp: () => {
          precedingEvents.push('native-op');
        },
      };
      const fakeAppPreceding = {
        getBackend: () => ({}),
        getMenuWindow: () => ({
          closeMenu: async () => {
            precedingEvents.push('action-close');
            precedingVisible = false;
          },
        }),
      } as unknown as KandoApp;

      const precedingWorkflow: Workflow = { actions: [closeAction, launchAction] };
      await WorkflowExecutor.getInstance().executeWorkflow(
        precedingWorkflow,
        fakeAppPreceding,
        new Map([
          [
            launchAction,
            createAppOpOverride(precedingHost, { target: 'Safari', op: 'activate' }, 1),
          ],
        ])
      );
      expect(precedingEvents).to.deep.equal(['action-close', 'native-op']);

      // Case 3: following close-menu action in workflow
      const followingEvents: string[] = [];
      let followingVisible = true;
      const followingHost: AppOpOverrideHost = {
        isVisible: () => followingVisible,
        displayedGeneration: () => 1,
        closeMenu: async () => {
          followingEvents.push('override-close');
          followingVisible = false;
        },
        awaitHide: async () => 'completed',
        controlApp: () => {
          followingEvents.push('native-op');
        },
      };
      const fakeAppFollowing = {
        getBackend: () => ({}),
        getMenuWindow: () => ({
          closeMenu: async () => {
            followingEvents.push('action-close');
          },
        }),
      } as unknown as KandoApp;

      const followingWorkflow: Workflow = { actions: [launchAction, closeAction] };
      await WorkflowExecutor.getInstance().executeWorkflow(
        followingWorkflow,
        fakeAppFollowing,
        new Map([
          [
            launchAction,
            createAppOpOverride(followingHost, { target: 'Safari', op: 'activate' }, 1),
          ],
        ])
      );
      expect(followingEvents).to.deep.equal([
        'override-close',
        'native-op',
        'action-close',
      ]);
    });
  });
  describe('EnterGestureTracker', () => {
    it('returns captured modifiers for keydown and keyup in the same session', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown({ ctrl: true, meta: false, alt: false, shift: false });

      // Even if modifier is released before keyup, keydown captured modifier is returned
      const modifiers = tracker.onKeyUp();
      expect(modifiers).to.deep.equal({
        ctrl: true,
        meta: false,
        alt: false,
        shift: false,
      });
    });

    it('returns null on keyup when keydown was superseded by a menu replacement', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown({ ctrl: true, meta: false, alt: false, shift: false });

      // A new menu session starts before Enter keyup
      tracker.startSession();

      const modifiers = tracker.onKeyUp();
      expect(modifiers).to.be.null;
    });

    it('returns null on keyup without a prior keydown in the current session', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();

      const modifiers = tracker.onKeyUp();
      expect(modifiers).to.be.null;
    });

    it('returns null on keyup after menu reset or hide', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown({ ctrl: false, meta: true, alt: false, shift: false });

      tracker.reset();

      const modifiers = tracker.onKeyUp();
      expect(modifiers).to.be.null;
    });
    it('does not let a pending modified Enter survive window blur or reset', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown({ ctrl: true, meta: false, alt: false, shift: false });

      // Window blur resets the tracker
      tracker.reset();

      expect(tracker.onKeyUp()).to.be.null;
    });

    const ctrl: Modifiers = { ctrl: true, meta: false, alt: false, shift: false };
    const none: Modifiers = { ctrl: false, meta: false, alt: false, shift: false };

    it('does not let an auto-repeat re-arm the gesture after a menu replacement', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown(ctrl);

      // The menu is replaced while Enter stays held; the key then auto-repeats.
      tracker.startSession();
      tracker.onKeyDown(ctrl, true);

      expect(tracker.onKeyUp()).to.be.null;
    });

    it('does not let an auto-repeat re-arm the gesture after a hide and show', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown(ctrl);

      tracker.reset();
      tracker.startSession();
      tracker.onKeyDown(ctrl, true);

      expect(tracker.onKeyUp()).to.be.null;
    });

    it('keeps the initial snapshot when repeats arrive with other modifiers', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown(none);
      tracker.onKeyDown(ctrl, true);

      expect(tracker.onKeyUp()).to.deep.equal(none);
    });

    it('selects normally for a fresh press after a menu replacement', () => {
      const tracker = new EnterGestureTracker();
      tracker.startSession();
      tracker.onKeyDown(ctrl);
      tracker.startSession();

      tracker.onKeyDown(none);

      expect(tracker.onKeyUp()).to.deep.equal(none);
    });
  });

  describe('modifiersForPointerRelease', () => {
    const held: Modifiers = { ctrl: true, meta: true, alt: false, shift: false };
    const none: Modifiers = { ctrl: false, meta: false, alt: false, shift: false };
    const click = {
      button: 0,
      pointerType: 'mouse',
      pressOwned: true,
      discreteClick: true,
    };

    it('keeps the held modifiers for a discrete primary mouse click', () => {
      expect(modifiersForPointerRelease(click, held)).to.deep.equal(held);
    });

    it('keeps them for a mouse event without a pointer type', () => {
      expect(
        modifiersForPointerRelease({ ...click, pointerType: undefined }, held)
      ).to.deep.equal(held);
    });

    it('never carries modifiers for a right, middle, back or unknown button release', () => {
      for (const button of [1, 2, 3, 4, -1]) {
        expect(modifiersForPointerRelease({ ...click, button }, held)).to.deep.equal(
          none
        );
      }
    });

    it('never carries modifiers when the press was not made in this menu session', () => {
      expect(
        modifiersForPointerRelease({ ...click, pressOwned: false }, held)
      ).to.deep.equal(none);
    });

    it('never carries modifiers for drags such as marking or turbo selections', () => {
      expect(
        modifiersForPointerRelease({ ...click, discreteClick: false }, held)
      ).to.deep.equal(none);
    });

    it('never carries modifiers for touch or pen pointer events', () => {
      for (const pointerType of ['touch', 'pen']) {
        expect(modifiersForPointerRelease({ ...click, pointerType }, held)).to.deep.equal(
          none
        );
      }
    });
  });
});

describe('IPCObserverRegistry', () => {
  type Event = { interaction: MenuInteractionType; path: number[] };

  function makeObserver(): {
    events: Event[];
    callback: (i: MenuInteractionType, p: number[]) => void;
  } {
    const events: Event[] = [];
    return {
      events,
      callback: (interaction, path) => events.push({ interaction, path }),
    };
  }

  const cClose = MenuInteractionType.eCloseMenu;
  const cSelect = MenuInteractionType.eSelectButton;

  it('delivers every generation to persistent observers', () => {
    const registry = new IPCObserverRegistry();
    const persistent = makeObserver();
    registry.add(7, persistent.callback);

    registry.dispatch(cSelect, [1], 3);
    registry.dispatch(cClose, [], 4);

    expect(persistent.events.map((e) => e.interaction)).to.deep.equal([cSelect, cClose]);
  });

  it('delivers nothing to a one-time observer until its menu is shown', () => {
    const registry = new IPCObserverRegistry();
    registry.announceOneTime();
    const oneTime = makeObserver();
    registry.add(IPCObserverRegistry.cOneTimeObserverID, oneTime.callback);

    registry.dispatch(cClose, [], 1);

    expect(oneTime.events).to.have.length(0);
  });

  it('does not let the late close of a replaced menu end the newer one-time observer', () => {
    const registry = new IPCObserverRegistry();

    // Menu A is shown (generation 1), then a custom menu B is requested (generation 2).
    const ticket = registry.announceOneTime();
    const oneTime = makeObserver();
    registry.add(IPCObserverRegistry.cOneTimeObserverID, oneTime.callback);
    registry.bindOneTime(ticket, 2);

    // The acknowledgement of A's close arrives after B's observer was registered.
    registry.dispatch(cClose, [], 1);
    expect(oneTime.events).to.have.length(0);

    // Interactions and the real close of B reach it.
    registry.dispatch(cSelect, [0], 2);
    registry.dispatch(cClose, [], 2);
    expect(oneTime.events.map((e) => e.interaction)).to.deep.equal([cSelect, cClose]);
  });

  it('keeps persistent observers receiving a stale close', () => {
    const registry = new IPCObserverRegistry();
    const persistent = makeObserver();
    registry.add(5, persistent.callback);

    const ticket = registry.announceOneTime();
    registry.add(IPCObserverRegistry.cOneTimeObserverID, makeObserver().callback);
    registry.bindOneTime(ticket, 2);

    registry.dispatch(cClose, [], 1);

    expect(persistent.events).to.have.length(1);
  });

  it('ignores a bind from a request whose observer was replaced', () => {
    const registry = new IPCObserverRegistry();

    const oldTicket = registry.announceOneTime();
    registry.add(IPCObserverRegistry.cOneTimeObserverID, makeObserver().callback);

    // A newer custom-menu request registers its own one-time observer.
    const newTicket = registry.announceOneTime();
    const newer = makeObserver();
    registry.add(IPCObserverRegistry.cOneTimeObserverID, newer.callback);

    // The older request reports its generation late: it must not bind the newer observer.
    registry.bindOneTime(oldTicket, 5);
    registry.dispatch(cClose, [], 5);
    expect(newer.events).to.have.length(0);

    registry.bindOneTime(newTicket, 6);
    registry.dispatch(cClose, [], 6);
    expect(newer.events).to.have.length(1);
  });

  it('stops delivering to a removed observer', () => {
    const registry = new IPCObserverRegistry();
    const persistent = makeObserver();
    registry.add(9, persistent.callback);
    registry.remove(9);

    registry.dispatch(cClose, [], 1);

    expect(persistent.events).to.have.length(0);
  });

  it('does not let an older observer disconnect/stop remove its replacement', () => {
    const registry = new IPCObserverRegistry();

    // Client A registers one-time observer
    registry.announceOneTime();
    const observerA = makeObserver();
    registry.add(IPCObserverRegistry.cOneTimeObserverID, observerA.callback);

    // Client B replaces A with its own one-time observer, bound to generation 2
    const ticketB = registry.announceOneTime();
    const observerB = makeObserver();
    registry.add(IPCObserverRegistry.cOneTimeObserverID, observerB.callback);
    registry.bindOneTime(ticketB, 2);

    // Client A disconnects/stops observing and passes its callback reference
    const removedA = registry.remove(
      IPCObserverRegistry.cOneTimeObserverID,
      observerA.callback
    );
    expect(removedA).to.be.false;

    // Client B must still receive its generation's events and its close
    registry.dispatch(MenuInteractionType.eSelectButton, [0], 2);
    expect(observerB.events).to.deep.equal([
      { interaction: MenuInteractionType.eSelectButton, path: [0] },
    ]);
    expect(observerA.events).to.be.empty;

    registry.dispatch(cClose, [], 2);
    expect(observerB.events).to.have.length(2);
    expect(observerB.events[1]).to.deep.equal({
      interaction: cClose,
      path: [],
    });
    expect(observerA.events).to.be.empty;

    // Client B's own disconnect/stop successfully removes itself
    const removedB = registry.remove(
      IPCObserverRegistry.cOneTimeObserverID,
      observerB.callback
    );
    expect(removedB).to.be.true;

    // Subsequent events are no longer delivered to B
    registry.dispatch(MenuInteractionType.eSelectButton, [0], 2);
    expect(observerB.events).to.have.length(2);
  });
});

describe('PrimaryPressTracker', () => {
  const cThreshold = 15;

  it('reports a release at the press position as a click', () => {
    const tracker = new PrimaryPressTracker();
    tracker.begin(100, 100);

    expect(tracker.release(100, 100, cThreshold)).to.be.true;
  });

  it('tolerates jitter below the drag threshold', () => {
    const tracker = new PrimaryPressTracker();
    tracker.begin(100, 100);
    tracker.move(105, 104, cThreshold);

    expect(tracker.release(106, 103, cThreshold)).to.be.true;
  });

  it('is not a click if one processed move went beyond the threshold, even if released nearby', () => {
    const tracker = new PrimaryPressTracker();
    tracker.begin(100, 100);
    tracker.move(200, 100, cThreshold);

    // The pointer returned to the press position: the excursion is not forgotten.
    expect(tracker.release(100, 100, cThreshold)).to.be.false;
  });

  it('is not a click if the release happens far away without any processed motion', () => {
    const tracker = new PrimaryPressTracker();
    tracker.begin(100, 100);

    expect(tracker.release(180, 100, cThreshold)).to.be.false;
  });

  it('stays invalid after leaving and re-entering the click zone', () => {
    const tracker = new PrimaryPressTracker();
    tracker.begin(100, 100);
    tracker.move(140, 100, cThreshold);
    tracker.move(101, 100, cThreshold);

    expect(tracker.release(101, 100, cThreshold)).to.be.false;
  });

  it('is not a click after the gesture was cancelled', () => {
    const tracker = new PrimaryPressTracker();
    tracker.begin(100, 100);
    tracker.cancel();

    expect(tracker.release(100, 100, cThreshold)).to.be.false;
  });

  it('does not report a release without a press, or a second release for one press', () => {
    const tracker = new PrimaryPressTracker();
    expect(tracker.release(0, 0, cThreshold)).to.be.false;

    tracker.begin(10, 10);
    expect(tracker.release(10, 10, cThreshold)).to.be.true;
    expect(tracker.release(10, 10, cThreshold)).to.be.false;
  });

  it('starts fresh with a new press after an invalidated one', () => {
    const tracker = new PrimaryPressTracker();
    tracker.begin(100, 100);
    tracker.move(300, 300, cThreshold);
    tracker.begin(50, 50);

    expect(tracker.release(50, 50, cThreshold)).to.be.true;
  });
});
