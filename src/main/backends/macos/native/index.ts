//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import type { AppState, AppOp } from '../../../../common/app-switcher';

export type Native = {
  /**
   * This simulates a mouse movement.
   *
   * @param dx The horizontal movement in pixels.
   * @param dy The vertical movement in pixels.
   */
  movePointer(dx: number, dy: number): void;

  /**
   * This simulates a key press or release.
   *
   * @param keycode The X11 scan code to simulate.
   * @param down If true, a key press is simulated. Otherwise, a key release is simulated.
   */
  simulateKey(keycode: number, down: boolean): void;

  /**
   * This retrieves the app and class of the currently focused window.
   *
   * @returns The app and class of the currently focused window.
   */
  getActiveWindow(): { app: string; name: string };

  /**
   * This retrieves all currently open windows.
   *
   * @returns An array containing app and window names.
   */
  getOpenWindows(): { app: string; window: string }[];

  /**
   * This focuses a currently open window.
   *
   * @param windowName The window title to focus.
   * @param appName The app name or bundle identifier owning the window.
   */
  focusWindow(windowName: string, appName: string): void;

  /**
   * This lists all installed applications.
   *
   * @returns An array of objects containing the application's ID, name, and
   *   base64-encoded icon.
   */
  listInstalledApplications(): {
    name: string;
    id: string;
    base64Icon: string;
  }[];
  /**
   * Retrieves the running state and window information for the given application targets,
   * bounded by a single shared 150 ms best-effort deadline (not a guaranteed completion
   * time).
   *
   * @param targets Array of application targets (app name, bundle name, bundle ID).
   * @returns Array of AppState objects matching the order of input targets.
   */
  getAppStates(targets: string[]): AppState[];

  /**
   * Performs an operation on a running application or one of its windows.
   *
   * Operations run against an enforced best-effort deadline of 500 ms (not a guaranteed
   * completion time); a query or operation that cannot complete within the remaining
   * budget aborts instead of blocking.
   *
   * `'close-tab'` is gated: the per-browser tab-strip rules are unverified, so the
   * operation logs and does nothing unless the process was started with the environment
   * variable `KANDO_UNVERIFIED_TAB_CLOSE=1`. See Native.mm's kTabStripRules.
   *
   * @param target Application target.
   * @param op Operation to perform ('activate', 'quit', 'hide', 'close-window',
   *   'close-tab').
   * @param windowId Optional window identity (CGWindowID).
   * @param pid Optional process identifier.
   */
  controlApp(target: string, op: AppOp, windowId?: number, pid?: number): void;
};

const native: Native = require('./../../../../../build/Release/NativeMacOS.node');

export { native };
