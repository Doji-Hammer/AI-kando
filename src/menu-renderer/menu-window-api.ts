//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import { ipcRenderer, webFrame } from 'electron';

import { COMMON_WINDOW_API } from '../common/common-window-api';
import {
  Vec2,
  ShowMenuOptions,
  SelectionSource,
  MenuInteractionType,
  RootMenuItem,
} from '../common';
import { Modifiers, NO_MODIFIERS } from '../common/app-switcher';
import {
  parseShowMenuArgs,
  parseTriggerInteractionArgs,
  stampInteraction,
  normalizeMenuGeneration,
} from '../common/app-switcher-logic';
/**
 * The displayed-menu generation of the menu which the host last sent. The host bumps it
 * on every show, and the main process drops interactions which belong to an older menu,
 * so that a click in a menu which is already being replaced cannot select a different
 * item.
 */
let displayedMenuGeneration = 0;

/**
 * These functions are available in the menu window's renderer process. They are available
 * on the window object as `window.menuAPI.<method>`. In addition, the common window API
 * functions are also be available as `window.commonAPI.<method>`.
 */
export const MENU_WINDOW_API = {
  /**
   * This will be called by the renderer process when it is fully loaded. This is used to
   * notify the host process that the renderer process is ready to receive messages.
   */
  menuWindowReady: () => {
    ipcRenderer.send('menu-window.ready');
  },

  /**
   * This can be used to warp the mouse pointer to a different position.
   *
   * @param dist The distance to move the mouse pointer.
   */
  movePointer: (dist: Vec2) => {
    ipcRenderer.send('menu-window.move-pointer', dist);
  },

  /**
   * This will be triggered by the host process when a new menu should be shown.
   *
   * @param callback This callback will be called when a new menu should be shown.
   */
  onShowMenu: (
    func: (
      root: RootMenuItem,
      menuOptions: ShowMenuOptions,
      environmentInfo: unknown,
      generation: number
    ) => void
  ) => {
    ipcRenderer.on(
      'menu-window.show-menu',
      (event, root, menuOptions, environmentInfo, generation) => {
        const parsed = parseShowMenuArgs(root, menuOptions, environmentInfo, generation);
        func(parsed.root, parsed.menuOptions, parsed.environmentInfo, parsed.generation);
      }
    );
  },

  /**
   * Publishes the displayed-menu generation to the preload. The renderer calls this when
   * it installs the menu tree with menu.show(), so that interactions are stamped with the
   * generation of the tree which is really on screen.
   */
  setDisplayedMenuGeneration: (generation: number) => {
    displayedMenuGeneration = normalizeMenuGeneration(generation);
  },

  /**
   * The host can request the renderer process to initiate several menu interactions, such
   * as closing the menu or closing the current submenu. The renderer process will act
   * accordingly and call the finalizeInteraction callback afterwards.
   *
   * For close triggers, the host passes the generation of the menu tree to close, so that
   * pending shows can be cancelled and the close interaction can be stamped with the
   * requested generation.
   *
   * @param func This callback will be called when the host process requests a menu
   *   interaction.
   */
  onTriggerInteraction: (
    func: (
      type: MenuInteractionType.eCloseMenu | MenuInteractionType.eCloseSubmenu,
      generation: number
    ) => void
  ) => {
    ipcRenderer.on('menu-window.trigger-interaction', (event, type, rawGeneration) => {
      const parsed = parseTriggerInteractionArgs(type, rawGeneration);
      func(parsed.type, parsed.generation);
    });
  },

  /**
   * Menu interactions can be triggered by the user in the renderer process, for example
   * by clicking a menu item or hovering over a submenu. They can also be triggered by the
   * host process using the onTriggerInteraction function.
   *
   * In both cases, the renderer process will call this finalizeInteraction function to
   * notify the host process about the interaction. The host process will then execute the
   * corresponding workflow, track achievements, etc.
   *
   * The time and source parameters are used for achievement tracking. They are only
   * relevant for selection interactions like "selectButton".
   *
   * The displayed-menu generation of the menu which produced the interaction is appended
   * as the last argument. The host drops interactions of a menu which it has already
   * replaced.
   *
   * @param type The type of the interaction, e.g. opening a menu, hovering a button, etc.
   * @param path The path of the selected menu item.
   * @param time The time it took to select the item in milliseconds. This is used for
   *   achievement tracking.
   * @param source The source used to make the selection. Also used for achievement
   *   tracking.
   */
  finalizeInteraction: (
    type: MenuInteractionType,
    path: number[],
    time: number,
    source: SelectionSource,
    modifiers: Modifiers = NO_MODIFIERS,
    generation?: number
  ) => {
    const genToStamp =
      generation !== undefined
        ? normalizeMenuGeneration(generation)
        : displayedMenuGeneration;
    ipcRenderer.send(
      'menu-window.finalize-interaction',
      ...stampInteraction(type, path, time, source, modifiers, genToStamp)
    );
  },

  /** This will be called by the render process to show the settings window. */
  showSettings: () => {
    ipcRenderer.send('menu-window.show-settings');
  },

  /**
   * This will be called by the host process when the menu theme should be reloaded.
   *
   * @param callback This callback will be called when the menu theme should be reloaded.
   */
  onReloadMenuTheme: (func: () => void) => {
    ipcRenderer.on('menu-window.reload-menu-theme', func);
  },

  /**
   * This will be called by the host process when the sound theme should be reloaded.
   *
   * @param callback This callback will be called when the sound theme should be reloaded.
   */
  onReloadSoundTheme: (func: () => void) => {
    ipcRenderer.on('menu-window.reload-sound-theme', func);
  },

  /**
   * This will be called by the host process when the icon themes should be reloaded.
   *
   * @param callback This callback will be called when the icon themes should be reloaded.
   */
  onReloadIconThemes: (func: () => void) => {
    webFrame.clearCache();
    ipcRenderer.on('menu-window.reload-icon-themes', func);
  },
};

/**
 * This type extends the global window object with the `api` objects. These `api` objects
 * contain all functions that can be called by the renderer process.
 */
export type WindowWithAPIs = {
  readonly commonAPI: typeof COMMON_WINDOW_API;
  readonly menuAPI: typeof MENU_WINDOW_API;
} & Window;
