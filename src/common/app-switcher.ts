//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/menu/kando           //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import type {
  RootMenuItem,
  SubmenuMenuItem,
  ButtonMenuItem,
  Workflow,
} from './settings-schemata';

/**
 * Shared types of the macOS "app switcher" behaviour: menu items that launch an
 * application know at show time whether the application is running and which windows it
 * has, and react to modifier keys held while they are selected.
 *
 * Everything here is runtime-only. None of it is part of the persisted menu settings.
 */

/** The modifier keys held while a menu item was selected. */
export type Modifiers = {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

/** Selections that did not come from a pointer click or Enter key report no modifiers. */
export const NO_MODIFIERS: Readonly<Modifiers> = {
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
};

/** The four things Quick close can do to an app, window or tab under the pointer. */
export type QuickCloseAction = 'quit' | 'closeWindow' | 'closeTab' | 'hide';

/** Which modifier combination triggers each Quick close action. */
export type QuickCloseBindings = Record<QuickCloseAction, Modifiers>;

/** The per-menu Quick close setting (stored with the menu, see MENU_SCHEMA_V2). */
export type QuickCloseConfig = {
  enabled: boolean;
  bindings: QuickCloseBindings;
};

/**
 * The combinations used before they became configurable: ⌃ quit, ⌘ window, ⌥ tab, ⌘⌥
 * hide.
 */
export const DEFAULT_QUICK_CLOSE_BINDINGS: Readonly<QuickCloseBindings> = {
  quit: { ctrl: true, meta: false, alt: false, shift: false },
  closeWindow: { ctrl: false, meta: true, alt: false, shift: false },
  closeTab: { ctrl: false, meta: false, alt: true, shift: false },
  hide: { ctrl: false, meta: true, alt: true, shift: false },
};
/** The default Quick close configuration for newly created menus (explicitly disabled). */
export const DEFAULT_QUICK_CLOSE_CONFIG: Readonly<QuickCloseConfig> = {
  enabled: false,
  bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
};

/** Runtime context required to evaluate Quick close operations. */
export type QuickCloseContext = {
  tabCloseAvailable: boolean;
};

/** Stored representation of the per-menu Quick close setting. */
export type StoredQuickClose = QuickCloseConfig;

/**
 * Browsers that support structural tab closing via accessibility. Case-insensitive match
 * on target.
 */
export const TAB_CLOSE_SUPPORTED_APPS: readonly string[] = [
  'Vivaldi',
  'Google Chrome',
  'Brave Browser',
  'Safari',
  'Firefox',
];

/**
 * Returns true if the target application name matches one of the tab-close-supported
 * browsers.
 */
export function isTabCloseSupportedApp(target: string): boolean {
  const normalized = target.trim().toLowerCase();
  return TAB_CLOSE_SUPPORTED_APPS.some((app) => app.toLowerCase() === normalized);
}

/**
 * Pure function resolving QuickCloseConfig from stored configuration.
 *
 * Rules:
 *
 * - Absent (`undefined`): legacy rule applies -> `{ enabled: true, bindings: DEFAULT }`
 * - Present: as stored with defaults filled for missing actions or keys
 */
export function resolveQuickCloseConfig(
  stored: StoredQuickClose | undefined
): QuickCloseConfig {
  if (stored === undefined) {
    return {
      enabled: true,
      bindings: {
        quit: { ...DEFAULT_QUICK_CLOSE_BINDINGS.quit },
        closeWindow: { ...DEFAULT_QUICK_CLOSE_BINDINGS.closeWindow },
        closeTab: { ...DEFAULT_QUICK_CLOSE_BINDINGS.closeTab },
        hide: { ...DEFAULT_QUICK_CLOSE_BINDINGS.hide },
      },
    };
  }

  const fillModifiers = (mod?: Partial<Modifiers>, fallback?: Modifiers): Modifiers => ({
    ctrl: Boolean(mod?.ctrl ?? fallback?.ctrl ?? false),
    meta: Boolean(mod?.meta ?? fallback?.meta ?? false),
    alt: Boolean(mod?.alt ?? fallback?.alt ?? false),
    shift: Boolean(mod?.shift ?? fallback?.shift ?? false),
  });

  return {
    enabled: Boolean(stored.enabled),
    bindings: {
      quit: fillModifiers(stored.bindings?.quit, DEFAULT_QUICK_CLOSE_BINDINGS.quit),
      closeWindow: fillModifiers(
        stored.bindings?.closeWindow,
        DEFAULT_QUICK_CLOSE_BINDINGS.closeWindow
      ),
      closeTab: fillModifiers(
        stored.bindings?.closeTab,
        DEFAULT_QUICK_CLOSE_BINDINGS.closeTab
      ),
      hide: fillModifiers(stored.bindings?.hide, DEFAULT_QUICK_CLOSE_BINDINGS.hide),
    },
  };
}

/** What can be done to a running application or one of its windows. */
export type AppOp = 'activate' | 'quit' | 'hide' | 'close-window' | 'close-tab';

/** One window of a running application, as reported by the native backend. */
export type AppWindowInfo = {
  /** Stable window identity (CGWindowID). */
  windowId: number;
  title: string;
};

/** The state of an application at the time the menu is shown. */
export type AppState = {
  running: boolean;
  /** Only set if running. */
  pid?: number;
  /** Standard windows (including minimized ones). Empty if `windowsKnown` is false. */
  windows: AppWindowInfo[];
  /**
   * False if the windows could not be enumerated (no Accessibility permission, the
   * application did not answer in time, ...). A running application whose windows are not
   * known is still `running: true`.
   */
  windowsKnown: boolean;
};

/**
 * Attached to items of the displayed menu tree that were recognised as application
 * launchers. Created by the main process when a menu is shown.
 */
export type RuntimeAppBinding = {
  /** The application name as `open -a` resolves it, e.g. "Google Chrome". */
  target: string;
  running: boolean;
  pid?: number;
  /** Set for the window children of a converted multi-window application. */
  windowId?: number;
  /** Whether the application windows could be enumerated. */
  windowsKnown: boolean;
  /** The item's original selection workflow, including its launch command. */
  originalWorkflow: Workflow;
};

/**
 * Displayed menu items in the resolved menu tree. They may have an `app` binding attached
 * if recognised as an application launcher. Renderer themes read `item.app?.running` to
 * draw a running indicator.
 */
export type DisplayedButtonMenuItem = ButtonMenuItem & {
  app?: RuntimeAppBinding;
};

export type DisplayedSubmenuMenuItem = Omit<SubmenuMenuItem, 'children'> & {
  app?: RuntimeAppBinding;
  children: DisplayedChildMenuItem[];
};

export type DisplayedRootMenuItem = Omit<RootMenuItem, 'children'> & {
  app?: RuntimeAppBinding;
  children: DisplayedChildMenuItem[];
};

export type DisplayedChildMenuItem = DisplayedButtonMenuItem | DisplayedSubmenuMenuItem;

export type { DisplayedPathInfo } from './app-switcher-logic';
export type DisplayedMenuItem = DisplayedRootMenuItem | DisplayedChildMenuItem;
