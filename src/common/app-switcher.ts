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
