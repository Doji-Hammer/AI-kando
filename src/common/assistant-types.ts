//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import type { GeneralSettings, MenuSettings } from './settings-schemata';

/** Types shared by the assistant's main-process code and the settings window. */

export type AssistantApiStyle = 'openai' | 'anthropic';

/** What the settings window may read about the assistant setup. The key never leaves main. */
export type AssistantConfig = {
  endpoint: string;
  apiStyle: AssistantApiStyle;
  model: string;
  hasApiKey: boolean;
  /** False if the OS can't encrypt the key (then it is not stored at all). */
  canStoreKeySecurely: boolean;
};

/** A reference chip the user inserted with @, / or #. */
export type AssistantReference = {
  trigger: '@' | '/' | '#';
  label: string;
  /** For @: which menu and item path the chip points to. */
  menuIndex?: number;
  path?: number[];
  /** For / and #: the action type, workflow or settings key. */
  key?: string;
};

export type AssistantMessagePart = string | AssistantReference;

export type AssistantMessage = {
  role: 'user' | 'assistant';
  parts: AssistantMessagePart[];
};

/** Where a proposed change landed, so the preview can draw it dashed. */
export type AssistantMarker = {
  menuIndex: number;
  path: number[];
  kind: 'add' | 'change';
};

export type AssistantChangeLine = {
  kind: 'add' | 'change' | 'remove';
  text: string;
};

export type AssistantProposal = {
  summary: string;
  changes: AssistantChangeLine[];
  /** The complete menus after the change, already validated. */
  menusAfter: MenuSettings['menus'];
  /** Only the general settings that change, already validated. */
  settingsChanges: Partial<GeneralSettings>;
  markers: AssistantMarker[];
};

export type AssistantReply = {
  text: string;
  proposal?: AssistantProposal;
  /** Set when the request failed; `text` then explains what to do. */
  error?: boolean;
};

export type AssistantRequest = {
  history: AssistantMessage[];
  menus: MenuSettings['menus'];
  settings: GeneralSettings;
  selectedMenu: number;
  selectedPath: number[];
};
