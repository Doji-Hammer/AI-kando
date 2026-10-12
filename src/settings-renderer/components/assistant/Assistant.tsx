//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

// Strings are English only for now; they move to the locale files once the wording is
// settled.

import React from 'react';
import classNames from 'classnames/bind';
import { TbPlus, TbArrowUp, TbChevronUp, TbCheck, TbX } from 'react-icons/tb';

import { WindowWithAPIs } from '../../settings-window-api';
declare const window: WindowWithAPIs;

import * as classes from './Assistant.module.scss';
const cx = classNames.bind(classes);

import { ActionTypeRegistry, ChildMenuItem, SubmenuMenuItem } from '../../../common';
import {
  useAppState,
  useMenuSettings,
  useGeneralSettings,
  useAssistant,
  previewProposal,
  acceptProposal,
  rejectProposal,
  currentCleanMenus,
  threadKey,
  useCurrentThread,
  getSelectedChild,
  MessagePart,
  Reference,
  ReferenceTrigger,
} from '../../state';
import { ThemedIcon } from '../common';

/** Renders text interleaved with reference chips. */
export function Parts(props: { readonly parts: MessagePart[] }) {
  return (
    <>
      {props.parts.map((part, i) =>
        typeof part === 'string' ? (
          <React.Fragment key={'t' + String(i)}>{part}</React.Fragment>
        ) : (
          <span key={'r' + String(i)} className={classes.chip}>
            <span className={classes.chipTrigger}>{part.trigger}</span>
            {part.label}
          </span>
        )
      )}
    </>
  );
}

/** Accept and reject the pending proposal. Shared by the panel and the properties. */
export function useProposalActions() {
  const proposal = useAssistant((s) => s.proposal);
  return { proposal, accept: acceptProposal, reject: rejectProposal };
}

type PickerRow = {
  key: string;
  label: string;
  detail?: string;
  icon?: string;
  iconTheme?: string;
  reference: Reference;
};

type PickerGroup = { name: string; rows: PickerRow[] };

const WORKFLOWS: { key: string; label: string; detail: string }[] = [
  {
    key: 'selectWorkflow',
    label: 'Select workflow',
    detail: 'Runs when an item is chosen',
  },
  {
    key: 'hoverWorkflow',
    label: 'Hover workflow',
    detail: 'Runs when the pointer rests on an item',
  },
  { key: 'openWorkflow', label: 'Open workflow', detail: 'Runs when a submenu opens' },
  {
    key: 'activateWorkflow',
    label: 'Center-click workflow',
    detail: 'Runs on a click in the centre',
  },
];

/** Readable names for the settings people ask about most. Other keys use their name. */
const SETTING_LABELS: Record<string, string> = {
  menuTheme: 'Menu theme',
  zoomFactor: 'Menu scale',
  fadeInDuration: 'Fade-in time',
  fadeOutDuration: 'Fade-out time',
  enableMarkingMode: 'Marking mode',
  enableTurboMode: 'Turbo mode',
  hoverModeNeedsConfirmation: 'Hover mode needs confirmation',
  centerDeadZone: 'Center dead zone',
  soundTheme: 'Sound theme',
  soundVolume: 'Sound volume',
  enableMenuAnimations: 'Menu animations',
  warpMouse: 'Warp pointer',
};

const matches = (q: string, ...texts: (string | undefined)[]) =>
  !q || texts.some((t) => t?.toLowerCase().includes(q.toLowerCase()));

/** Builds the picker rows from the real configuration, filtered by the typed query. */
function usePickerGroups(trigger: ReferenceTrigger | null, query: string): PickerGroup[] {
  const menus = useMenuSettings((s) => s.menus);
  const general = useGeneralSettings();

  if (trigger === '@') {
    return menus
      .map((menu, menuIndex) => {
        const rows: PickerRow[] = [];
        const walk = (
          item: ChildMenuItem | typeof menu.root,
          path: number[],
          trail: string
        ) => {
          const label = path.length === 0 ? item.name : trail + ' › ' + item.name;
          if (matches(query, item.name, label)) {
            rows.push({
              key: menuIndex + ':' + path.join(','),
              label: item.name,
              detail:
                path.length === 0 ? 'Menu · ' + (menu.shortcut || 'no shortcut') : label,
              icon: item.icon,
              iconTheme: item.iconTheme,
              reference: { trigger: '@' as const, label, menuIndex, path },
            });
          }
          if ('children' in item) {
            item.children.forEach((c, i) => walk(c, [...path, i], label));
          }
        };
        walk(menu.root, [], '');
        return { name: menu.root.name, rows: rows.slice(0, 8) };
      })
      .filter((g) => g.rows.length > 0);
  }

  if (trigger === '/') {
    const meta = ActionTypeRegistry.getInstance().getAllMetadata();
    return [
      {
        name: 'Workflows',
        rows: WORKFLOWS.filter((w) => matches(query, w.label)).map((w) => ({
          key: w.key,
          label: w.label,
          detail: w.detail,
          reference: { trigger: '/' as const, label: w.label, key: w.key },
        })),
      },
      {
        name: 'Actions',
        rows: (Object.keys(meta) as Array<keyof typeof meta>)
          .filter((k) => matches(query, meta[k].name, k))
          .map((k) => ({
            key: k,
            label: meta[k].name,
            detail: meta[k].description,
            icon: meta[k].icon,
            iconTheme: meta[k].iconTheme,
            reference: { trigger: '/' as const, label: meta[k].name, key: k },
          })),
      },
    ].filter((g) => g.rows.length > 0);
  }

  if (trigger === '#') {
    const hidden = new Set(['version', 'menuThemeColors', 'darkMenuThemeColors']);
    const rows = Object.entries(general)
      .filter(([k]) => !hidden.has(k))
      .map(([k, v]) => ({ k, v, label: SETTING_LABELS[k] ?? k }))
      .filter(({ k, label }) => matches(query, k, label))
      .sort((a, b) => Number(!(a.k in SETTING_LABELS)) - Number(!(b.k in SETTING_LABELS)))
      .slice(0, 10)
      .map(({ k, v, label }) => ({
        key: k,
        label,
        detail: typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v),
        reference: { trigger: '#' as const, label, key: k },
      }));
    return rows.length ? [{ name: 'General settings', rows }] : [];
  }

  return [];
}

const pickerTitle = (trigger: ReferenceTrigger) =>
  trigger === '@'
    ? 'Menus and items'
    : trigger === '/'
      ? 'Actions and workflows'
      : 'Settings';

function ReferencePicker(props: {
  readonly trigger: ReferenceTrigger;
  readonly groups: PickerGroup[];
  readonly activeIndex: number;
  readonly onPick: (row: PickerRow) => void;
}) {
  const query = useAssistant((s) => s.pickerQuery);
  let n = -1;

  return (
    <div
      aria-label={pickerTitle(props.trigger)}
      className={classes.popover}
      role="listbox">
      <div className={classes.popoverTitle}>
        <span className={classes.chipTrigger}>{props.trigger}</span>
        {pickerTitle(props.trigger)}
        {query ? <span className={classes.query}>“{query}”</span> : null}
      </div>
      {props.groups.length === 0 ? <div className={classes.empty}>No matches</div> : null}
      {props.groups.map((group) => (
        <div key={group.name} className={classes.group}>
          <div className={classes.groupName}>{group.name}</div>
          {group.rows.map((row) => {
            n++;
            const isActive = n === props.activeIndex;
            return (
              <div
                key={row.key}
                aria-selected={isActive}
                className={cx({ row: true, active: isActive })}
                role="option"
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the composer
                  props.onPick(row);
                }}>
                <span className={classes.rowIcon}>
                  {row.icon ? (
                    <ThemedIcon name={row.icon} size={18} theme={row.iconTheme} />
                  ) : null}
                </span>
                <span className={classes.rowLabel}>{row.label}</span>
                <span className={classes.rowDetail}>{row.detail}</span>
              </div>
            );
          })}
        </div>
      ))}
      <div className={classes.popoverFooter}>↑↓ move · ↵ insert · esc close</div>
    </div>
  );
}

/** "+ Add item": every item type by name; clicking adds it to the current ring. */
function AddItemList(props: { readonly onDone: () => void }) {
  const selectedMenu = useAppState((s) => s.selectedMenu);
  const selectedChildPath = useAppState((s) => s.selectedChildPath);
  const selectChildPath = useAppState((s) => s.selectChildPath);
  const menus = useMenuSettings((s) => s.menus);
  const editMenuItem = useMenuSettings((s) => s.editMenuItem);

  const meta = ActionTypeRegistry.getInstance().getAllMetadata();
  const types = [
    {
      key: 'submenu',
      name: 'Submenu',
      description: 'A nested ring of items',
      icon: 'submenu-item.svg',
      iconTheme: 'kando',
    },
    ...(Object.keys(meta) as Array<keyof typeof meta>)
      .filter((k) =>
        [
          'execute-command',
          'simulate-hotkey',
          'execute-macro',
          'open-file',
          'open-uri',
          'open-settings',
          'set-clipboard',
          'open-menu',
        ].includes(k)
      )
      .map((key) => ({ key, ...meta[key] })),
  ];

  const add = async (typeKey: string) => {
    // Same creation path as dragging a type onto the preview.
    const transfer = new DataTransfer();
    transfer.setData('kando/new-item-type', typeKey);
    const item = await ActionTypeRegistry.getInstance().createItem(transfer);
    if (!item || selectedMenu < 0) {
      return;
    }
    // Add to the ring that is open: the selected submenu (or root), else the parent of
    // the selected button, right after it.
    const selected = getSelectedChild(menus, selectedMenu, selectedChildPath);
    const isRing = selectedChildPath.length === 0 || selected?.type === 'submenu';
    const parentPath = isRing ? selectedChildPath : selectedChildPath.slice(0, -1);
    let newIndex = 0;
    editMenuItem(selectedMenu, parentPath, (parent) => {
      const ring = parent as SubmenuMenuItem;
      newIndex = isRing
        ? ring.children.length
        : selectedChildPath[selectedChildPath.length - 1] + 1;
      ring.children.splice(newIndex, 0, item);
      return parent;
    });
    selectChildPath([...parentPath, newIndex]);
    window.commonAPI.incrementAchievementStats(['addedItems']);
    props.onDone();
  };

  return (
    <div aria-label="Add item" className={classes.popover} role="dialog">
      <div className={classes.popoverTitle}>Add to the open ring</div>
      <ul className={classes.typeGrid}>
        {types.map((t) => (
          <li key={t.key}>
            <button
              className={classes.typeButton}
              type="button"
              onClick={() => add(t.key)}>
              <ThemedIcon name={t.icon} size={20} theme={t.iconTheme} />
              <span>
                <span className={classes.typeName}>{t.name}</span>
                <span className={classes.typeDetail}>{t.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className={classes.popoverFooter}>
        Adds after the selected item. You can also drag files and links onto the preview.
      </div>
    </div>
  );
}

/**
 * The assistant sits at the bottom of the centre column, under the preview: you ask, and
 * the preview shows the proposed change in the same eye-line.
 */
export default function Assistant() {
  const config = useAssistant((s) => s.config);
  const setConfig = useAssistant((s) => s.setConfig);
  const isBusy = useAssistant((s) => s.isBusy);
  const setBusy = useAssistant((s) => s.setBusy);
  const setLeftTab = useAssistant((s) => s.setLeftTab);
  const leftTab = useAssistant((s) => s.leftTab);
  const picker = useAssistant((s) => s.picker);
  const pickerQuery = useAssistant((s) => s.pickerQuery);
  const openPicker = useAssistant((s) => s.openPicker);
  const setPickerQuery = useAssistant((s) => s.setPickerQuery);
  const isAddItemOpen = useAssistant((s) => s.isAddItemOpen);
  const setAddItemOpen = useAssistant((s) => s.setAddItemOpen);
  const draft = useAssistant((s) => s.draft);
  const setDraft = useAssistant((s) => s.setDraft);
  const { messages } = useCurrentThread();
  const setThread = useAssistant((s) => s.setThread);
  const proposal = useAssistant((s) => s.proposal);
  const setSettingsDialogVisible = useAppState((s) => s.setSettingsDialogVisible);

  const [text, setText] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  // Where in `text` the trigger character was typed, while the picker is open.
  const triggerAt = React.useRef(-1);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const groups = usePickerGroups(picker, pickerQuery);
  const rows = groups.flatMap((g) => g.rows);

  React.useEffect(() => {
    window.settingsAPI.assistantGetConfig().then(setConfig);
  }, [setConfig]);

  // ⌘K focuses the composer; ⌘↵ accepts a pending proposal.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.metaKey && e.key === 'Enter' && useAssistant.getState().proposal) {
        e.preventDefault();
        acceptProposal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isReady = Boolean(config?.endpoint && config?.model);

  const closePicker = () => {
    triggerAt.current = -1;
    openPicker(null);
  };

  const pick = (row: PickerRow) => {
    const before = text.slice(0, triggerAt.current);
    setDraft([...draft, ...(before ? [before] : []), row.reference, ' ']);
    setText('');
    closePicker();
    inputRef.current?.focus();
  };

  const openSetup = () => {
    setSettingsDialogVisible(true);
    setTimeout(() => window.dispatchEvent(new Event('kando/open-assistant-settings')), 0);
  };

  const send = async () => {
    const parts = [...draft, ...(text.trim() ? [text] : [])];
    if (parts.length === 0 || isBusy) {
      return;
    }
    if (!isReady) {
      openSetup();
      return;
    }
    if (proposal) {
      // A new request replaces a proposal that was neither accepted nor rejected.
      rejectProposal();
    }

    // The conversation belongs to the menu that was selected when it was sent.
    const app = useAppState.getState();
    const key = threadKey(app.selectedMenu);
    const history = [
      ...messages.filter((m) => !m.isError),
      { role: 'user' as const, parts },
    ];
    setThread(key, [...messages, { role: 'user', parts }]);
    setDraft([]);
    setText('');
    setBusy(true);
    setLeftTab('chat');

    const reply = await window.settingsAPI.assistantSend({
      history,
      menus: currentCleanMenus(),
      settings: useGeneralSettings.getState(),
      selectedMenu: app.selectedMenu,
      selectedPath: app.selectedChildPath,
    });

    setBusy(false);
    setThread(key, [
      ...(useAssistant.getState().threads[key] ?? []),
      { role: 'assistant', parts: [reply.text], isError: reply.error },
    ]);
    if (reply.proposal) {
      previewProposal(reply.proposal);
    }
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <section aria-label="Assistant" className={classes.assistant}>
      {proposal ? (
        <div aria-live="polite" className={classes.proposal}>
          <p className={classes.proposalSummary}>{proposal.summary}</p>
          <ul className={classes.changes}>
            {proposal.changes.map((c, i) => (
              <li
                key={'c' + String(i) + c.text}
                className={cx({ change: true, [c.kind]: true })}>
                <span aria-hidden className={classes.changeMark}>
                  {c.kind === 'add' ? '+' : c.kind === 'remove' ? '−' : '~'}
                </span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
          <div className={classes.proposalActions}>
            <span className={classes.hint}>
              Shown dashed in the preview. Nothing is saved yet.
            </span>
            <button className={classes.secondary} type="button" onClick={rejectProposal}>
              <TbX /> Reject
            </button>
            <button className={classes.primary} type="button" onClick={acceptProposal}>
              <TbCheck /> Accept <kbd>⌘↵</kbd>
            </button>
          </div>
        </div>
      ) : leftTab !== 'chat' && (lastAssistant || isBusy) ? (
        // The full conversation lives in the left column's Chat tab.
        <button
          className={classes.lastReply}
          type="button"
          onClick={() => setLeftTab('chat')}>
          <TbChevronUp />
          <span className={classes.lastReplyText}>
            {isBusy ? 'Thinking…' : <Parts parts={lastAssistant!.parts} />}
          </span>
        </button>
      ) : null}

      {config && !isReady ? (
        <div className={classes.setup}>
          <span>Connect a model to use the assistant.</span>
          <button className={classes.textButton} type="button" onClick={openSetup}>
            Set up…
          </button>
        </div>
      ) : null}

      <div className={classes.composerWrap}>
        {picker ? (
          <ReferencePicker
            activeIndex={Math.min(activeIndex, Math.max(rows.length - 1, 0))}
            groups={groups}
            trigger={picker}
            onPick={pick}
          />
        ) : null}
        {isAddItemOpen ? <AddItemList onDone={() => setAddItemOpen(false)} /> : null}

        <div className={classes.composer}>
          <button
            aria-expanded={isAddItemOpen}
            className={classes.addItem}
            type="button"
            onClick={() => setAddItemOpen(!isAddItemOpen)}>
            <TbPlus /> Add item
          </button>
          <div className={classes.field} onClick={() => inputRef.current?.focus()}>
            <Parts parts={draft} />
            <input
              ref={inputRef}
              aria-autocomplete="list"
              aria-expanded={picker !== null}
              aria-label="Ask the assistant"
              className={classes.input}
              disabled={isBusy}
              placeholder={
                draft.length
                  ? ''
                  : isBusy
                    ? 'Thinking…'
                    : 'Ask to build or change a menu…'
              }
              role="combobox"
              value={text}
              onChange={(e) => {
                const value = e.target.value;
                setText(value);
                if (picker) {
                  // Close if the trigger was deleted or a space ends the query.
                  const q = value.slice(triggerAt.current + 1);
                  if (value.length <= triggerAt.current || /\s{2}$/.test(q)) {
                    closePicker();
                  } else {
                    setPickerQuery(q);
                    setActiveIndex(0);
                  }
                }
              }}
              onKeyDown={(e) => {
                if (picker) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const d = e.key === 'ArrowDown' ? 1 : -1;
                    setActiveIndex(
                      (i) => (i + d + rows.length) % Math.max(rows.length, 1)
                    );
                    return;
                  }
                  if ((e.key === 'Enter' || e.key === 'Tab') && rows.length > 0) {
                    e.preventDefault();
                    pick(rows[Math.min(activeIndex, rows.length - 1)]);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    closePicker();
                    return;
                  }
                }
                if (e.key === '@' || e.key === '/' || e.key === '#') {
                  const caret = e.currentTarget.selectionStart ?? text.length;
                  if (caret === 0 || /\s/.test(text[caret - 1])) {
                    triggerAt.current = caret;
                    setActiveIndex(0);
                    openPicker(e.key);
                  }
                }
                if (e.key === 'Backspace' && text === '' && draft.length > 0) {
                  // Remove the last chip or text fragment, like a token field.
                  e.preventDefault();
                  setDraft(draft.slice(0, -1));
                }
                if (e.key === 'Enter' && !e.metaKey && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>
          <button
            aria-label="Send"
            className={classes.send}
            disabled={isBusy}
            type="button"
            onClick={send}>
            <TbArrowUp />
          </button>
        </div>
        <div className={classes.triggers}>
          <span>
            <b>@</b> menus and items
          </span>
          <span>
            <b>/</b> actions and workflows
          </span>
          <span>
            <b>#</b> settings
          </span>
          <span className={classes.shortcut}>⌘K</span>
        </div>
      </div>
    </section>
  );
}
