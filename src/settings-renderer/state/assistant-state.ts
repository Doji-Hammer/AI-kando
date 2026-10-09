//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import { create } from 'zustand';

import type {
  AssistantConfig,
  AssistantMessage,
  AssistantMessagePart,
  AssistantProposal,
  AssistantReference,
} from '../../common/assistant-types';
import type { Menu, MenuItem } from '../../common';
import { useMenuSettings } from './menu-settings';
import { useGeneralSettings } from './general-settings';
import { useAppState } from './app-state';

export type ReferenceTrigger = AssistantReference['trigger'];
export type Reference = AssistantReference;
export type MessagePart = AssistantMessagePart;
export type Message = AssistantMessage & { isError?: boolean };

/** A proposal being previewed, with what to restore if the user rejects it. */
export type Proposal = AssistantProposal & { menusBefore: Menu[] };

type AssistantState = {
  config: AssistantConfig | null;
  isBusy: boolean;
  isDrawerOpen: boolean;
  picker: ReferenceTrigger | null;
  pickerQuery: string;
  isAddItemOpen: boolean;
  draft: MessagePart[];
  messages: Message[];
  proposal: Proposal | null;

  setConfig: (config: AssistantConfig) => void;
  setBusy: (isBusy: boolean) => void;
  setDrawerOpen: (isOpen: boolean) => void;
  openPicker: (trigger: ReferenceTrigger | null, query?: string) => void;
  setPickerQuery: (query: string) => void;
  setAddItemOpen: (isOpen: boolean) => void;
  setDraft: (draft: MessagePart[]) => void;
  setMessages: (messages: Message[]) => void;
  setProposal: (proposal: Proposal | null) => void;
};

export const useAssistant = create<AssistantState>((set) => ({
  config: null,
  isBusy: false,
  isDrawerOpen: false,
  picker: null,
  pickerQuery: '',
  isAddItemOpen: false,
  draft: [],
  messages: [],
  proposal: null,
  setConfig: (config) => set({ config }),
  setBusy: (isBusy) => set({ isBusy }),
  setDrawerOpen: (isDrawerOpen) => set({ isDrawerOpen }),
  openPicker: (picker, pickerQuery = '') =>
    set({ picker, pickerQuery, isAddItemOpen: false }),
  setPickerQuery: (pickerQuery) => set({ pickerQuery }),
  setAddItemOpen: (isAddItemOpen) => set({ isAddItemOpen, picker: null }),
  setDraft: (draft) => set({ draft }),
  setMessages: (messages) => set({ messages }),
  setProposal: (proposal) => set({ proposal }),
}));

/** Flags on items that only exist while a proposal is previewed. Never saved. */
type Flagged = { proposed?: boolean; proposedChange?: boolean; children?: Flagged[] };

function itemAt(menu: Menu, path: number[]): Flagged | undefined {
  let node = menu.root as unknown as Flagged;
  for (const i of path) {
    node = node?.children?.[i] as Flagged;
  }
  return node;
}

/** Deep copy without the preview flags. */
export function stripFlags(menus: Menu[]): Menu[] {
  const copy = structuredClone(menus);
  const walk = (node: Flagged) => {
    delete node.proposed;
    delete node.proposedChange;
    node.children?.forEach(walk);
  };
  copy.forEach((m) => walk(m.root as unknown as Flagged));
  return copy;
}

/** The menus as they are on disk: without any preview flags. */
export function currentCleanMenus(): Menu[] {
  return stripFlags(useMenuSettings.getState().menus);
}

/**
 * Shows a proposal in the editor without recording it in the undo history and without
 * saving it (the settings window does not save while a proposal is pending).
 */
export function previewProposal(proposal: AssistantProposal) {
  const menusBefore = currentCleanMenus();
  const menus = structuredClone(proposal.menusAfter) as Menu[];
  for (const m of proposal.markers) {
    const node = menus[m.menuIndex] && itemAt(menus[m.menuIndex], m.path);
    if (node) {
      if (m.kind === 'add') {
        node.proposed = true;
      } else {
        node.proposedChange = true;
      }
    }
  }

  // Set the proposal first so the save subscription already skips this state.
  useAssistant.getState().setProposal({ ...proposal, menusBefore });
  const temporal = useMenuSettings.temporal.getState();
  temporal.pause();
  useMenuSettings.setState({ menus });
  temporal.resume();

  // Show the first changed item, so the right panel shows its fields.
  const first = proposal.markers[0];
  if (first) {
    const app = useAppState.getState();
    app.selectMenu(first.menuIndex);
    if (first.path.length > 0) {
      app.selectChildPath(first.path);
    }
  }
}

/** Keeps the proposal: one undo step, then saved like any other edit. */
export function acceptProposal() {
  const proposal = useAssistant.getState().proposal;
  if (!proposal) {
    return;
  }
  const after = stripFlags(useMenuSettings.getState().menus);

  // Restore "before" silently (still pending, so not saved), then set "after" with
  // history on: exactly one undo step and exactly one save.
  const temporal = useMenuSettings.temporal.getState();
  temporal.pause();
  useMenuSettings.setState({ menus: proposal.menusBefore });
  temporal.resume();
  useAssistant.getState().setProposal(null);
  useMenuSettings.setState({ menus: after });

  if (Object.keys(proposal.settingsChanges).length > 0) {
    useGeneralSettings.setState(proposal.settingsChanges);
  }
}

/** Drops the proposal and puts the menus back exactly as they were. */
export function rejectProposal() {
  const proposal = useAssistant.getState().proposal;
  if (!proposal) {
    return;
  }
  useAssistant.getState().setProposal(null);
  const temporal = useMenuSettings.temporal.getState();
  temporal.pause();
  useMenuSettings.setState({ menus: proposal.menusBefore });
  temporal.resume();
  useAppState.getState().selectParent();
}

/** True if the item is drawn as part of a pending proposal. */
export function isProposed(item: MenuItem | undefined): boolean {
  const f = item as Flagged | undefined;
  return Boolean(f?.proposed || f?.proposedChange);
}
