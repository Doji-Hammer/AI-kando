//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import { create } from 'zustand';

/**
 * PROTOTYPE. State for the built-in assistant panel. Nothing here talks to a model yet;
 * the conversation and proposals are placeholders so the layout can be reviewed.
 */

/** The three reference triggers the composer understands. */
export type ReferenceTrigger = '@' | '/' | '#';

/** A reference chip inside a message: a menu or item, an action or workflow, a setting. */
export type Reference = {
  trigger: ReferenceTrigger;
  label: string;
};

/** A message is plain text interleaved with reference chips. */
export type MessagePart = string | Reference;

export type Message = {
  role: 'user' | 'assistant';
  parts: MessagePart[];
};

/** One line in a proposal's change list. */
export type ProposedChange = {
  kind: 'add' | 'change' | 'remove';
  parts: MessagePart[];
};

/** A pending set of changes the user can accept or reject as one undo step. */
export type Proposal = {
  summary: MessagePart[];
  changes: ProposedChange[];
  /** Where the proposed item lives, so the preview and properties can show it. */
  menuIndex: number;
  itemPath: number[];
};

type AssistantState = {
  /** Whether the conversation drawer is expanded over the preview. */
  isDrawerOpen: boolean;

  /** The reference picker that is open above the composer, if any. */
  picker: ReferenceTrigger | null;

  /** Whether the labelled "Add item" list is open. */
  isAddItemOpen: boolean;

  /** Text typed after the trigger character; filters the picker. */
  pickerQuery: string;

  /** Current draft in the composer. */
  draft: MessagePart[];

  messages: Message[];

  proposal: Proposal | null;

  setDrawerOpen: (isOpen: boolean) => void;
  openPicker: (trigger: ReferenceTrigger | null, query?: string) => void;
  setAddItemOpen: (isOpen: boolean) => void;
  setDraft: (draft: MessagePart[]) => void;
  setMessages: (messages: Message[]) => void;
  setProposal: (proposal: Proposal | null) => void;
};

export const useAssistant = create<AssistantState>((set) => ({
  isDrawerOpen: false,
  picker: null,
  isAddItemOpen: false,
  pickerQuery: '',
  draft: [],
  messages: [],
  proposal: null,
  setDrawerOpen: (isDrawerOpen) => set({ isDrawerOpen }),
  openPicker: (picker, pickerQuery = '') => set({ picker, pickerQuery, isAddItemOpen: false }),
  setAddItemOpen: (isAddItemOpen) => set({ isAddItemOpen, picker: null }),
  setDraft: (draft) => set({ draft }),
  setMessages: (messages) => set({ messages }),
  setProposal: (proposal) => set({ proposal }),
}));
