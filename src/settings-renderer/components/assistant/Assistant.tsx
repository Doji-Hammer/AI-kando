//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

// PROTOTYPE: layout and interaction only. No model is connected; strings are not yet
// translated.

import React from 'react';
import classNames from 'classnames/bind';
import {
  TbPlus,
  TbArrowUp,
  TbChevronUp,
  TbChevronDown,
  TbCheck,
  TbX,
} from 'react-icons/tb';

import * as classes from './Assistant.module.scss';
const cx = classNames.bind(classes);

import { ActionTypeRegistry } from '../../../common';
import {
  useAppState,
  useMenuSettings,
  useGeneralSettings,
  useAssistant,
  MessagePart,
  ReferenceTrigger,
} from '../../state';
import { ThemedIcon } from '../common';

/** Renders text interleaved with reference chips. */
export function Parts(props: { readonly parts: MessagePart[] }) {
  return (
    <>
      {props.parts.map((part, i) =>
        typeof part === 'string' ? (
          <React.Fragment key={i}>{part}</React.Fragment>
        ) : (
          <span key={i} className={classes.chip}>
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
  const setProposal = useAssistant((s) => s.setProposal);
  const setMessages = useAssistant((s) => s.setMessages);
  const editMenuItem = useMenuSettings((s) => s.editMenuItem);
  const deleteMenuItem = useMenuSettings((s) => s.deleteMenuItem);
  const selectParent = useAppState((s) => s.selectParent);

  const accept = () => {
    if (!proposal) {
      return;
    }
    // One edit, so one Cmd+Z undoes the whole proposal.
    editMenuItem(proposal.menuIndex, proposal.itemPath, (item) => {
      delete (item as { proposed?: boolean }).proposed;
      return item;
    });
    setMessages([
      ...useAssistant.getState().messages,
      { role: 'assistant', parts: ['Done. Press ⌘Z to undo.'] },
    ]);
    setProposal(null);
  };

  const reject = () => {
    if (!proposal) {
      return;
    }
    deleteMenuItem(proposal.menuIndex, proposal.itemPath);
    selectParent();
    setProposal(null);
  };

  return { proposal, accept, reject };
}

type PickerRow = {
  key: string;
  label: string;
  detail?: string;
  icon?: string;
  iconTheme?: string;
};

/** Builds the rows for one reference picker from the real configuration. */
function usePickerRows(trigger: ReferenceTrigger | null): {
  title: string;
  groups: { name: string; rows: PickerRow[] }[];
} {
  const menus = useMenuSettings((s) => s.menus);
  const general = useGeneralSettings();

  if (trigger === '@') {
    const groups = menus.map((menu) => ({
      name: menu.root.name,
      rows: [
        {
          key: menu.root.name,
          label: menu.root.name,
          detail: 'Menu · ' + (menu.shortcut || 'no shortcut'),
          icon: menu.root.icon,
          iconTheme: menu.root.iconTheme,
        },
        ...(menu.root.children || []).slice(0, 4).map((child) => ({
          key: menu.root.name + child.name,
          label: child.name,
          detail: menu.root.name + ' › ' + child.name,
          icon: child.icon,
          iconTheme: child.iconTheme,
        })),
      ],
    }));
    return { title: 'Menus and items', groups: groups.slice(0, 2) };
  }

  if (trigger === '/') {
    const meta = ActionTypeRegistry.getInstance().getAllMetadata();
    const actions = (Object.keys(meta) as Array<keyof typeof meta>).map((key) => ({
      key,
      label: meta[key].name,
      detail: meta[key].description,
      icon: meta[key].icon,
      iconTheme: meta[key].iconTheme,
    }));
    return {
      title: 'Actions and workflows',
      groups: [
        {
          name: 'Workflows',
          rows: [
            { key: 'select', label: 'Select workflow', detail: 'Runs when an item is selected' },
            { key: 'hover', label: 'Hover workflow', detail: 'Runs when the pointer rests on an item' },
            { key: 'open', label: 'Open workflow', detail: 'Runs when a submenu opens' },
          ],
        },
        { name: 'Actions', rows: actions.slice(0, 5) },
      ],
    };
  }

  if (trigger === '#') {
    return {
      title: 'Settings',
      groups: [
        {
          name: 'Menu behavior',
          rows: [
            { key: 'marking', label: 'Marking mode', detail: general.enableMarkingMode ? 'On' : 'Off' },
            { key: 'turbo', label: 'Turbo mode', detail: general.enableTurboMode ? 'On' : 'Off' },
            { key: 'deadzone', label: 'Center dead zone', detail: String(general.centerDeadZone) + ' px' },
          ],
        },
        {
          name: 'Appearance',
          rows: [
            { key: 'theme', label: 'Menu theme', detail: general.menuTheme },
            { key: 'scale', label: 'Menu scale', detail: String(general.zoomFactor) + '×' },
          ],
        },
      ],
    };
  }

  return { title: '', groups: [] };
}

/** The "+ Add item" list: every item type with its name, instead of a row of glyphs. */
function AddItemList() {
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
        ['execute-command', 'simulate-hotkey', 'execute-macro', 'open-file', 'open-uri', 'open-settings', 'set-clipboard', 'open-menu'].includes(k)
      )
      .map((key) => ({ key, ...meta[key] })),
  ];

  return (
    <div aria-label="Add item" className={classes.popover} role="dialog">
      <div className={classes.popoverTitle}>Add item to the selected ring</div>
      <ul className={classes.typeGrid}>
        {types.map((t) => (
          <li key={t.key}>
            <button className={classes.typeButton} type="button">
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
        Click to add after the selected item, or drag onto the preview.
      </div>
    </div>
  );
}

function ReferencePicker(props: { readonly trigger: ReferenceTrigger }) {
  const { title, groups } = usePickerRows(props.trigger);
  const query = useAssistant((s) => s.pickerQuery);
  let first = true;

  return (
    <div aria-label={title} className={classes.popover} role="listbox">
      <div className={classes.popoverTitle}>
        <span className={classes.chipTrigger}>{props.trigger}</span>
        {title}
        {query ? <span className={classes.query}>“{query}”</span> : null}
      </div>
      {groups.map((group) => (
        <div key={group.name} className={classes.group}>
          <div className={classes.groupName}>{group.name}</div>
          {group.rows.map((row) => {
            const isActive = first;
            first = false;
            return (
              <div
                key={row.key}
                aria-selected={isActive}
                className={cx({ row: true, active: isActive })}
                role="option">
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

/**
 * The assistant sits at the bottom of the centre column, under the preview: you ask,
 * and the preview shows the proposed change in the same eye-line.
 */
export default function Assistant() {
  const isDrawerOpen = useAssistant((s) => s.isDrawerOpen);
  const setDrawerOpen = useAssistant((s) => s.setDrawerOpen);
  const picker = useAssistant((s) => s.picker);
  const openPicker = useAssistant((s) => s.openPicker);
  const isAddItemOpen = useAssistant((s) => s.isAddItemOpen);
  const setAddItemOpen = useAssistant((s) => s.setAddItemOpen);
  const draft = useAssistant((s) => s.draft);
  const setDraft = useAssistant((s) => s.setDraft);
  const messages = useAssistant((s) => s.messages);
  const setMessages = useAssistant((s) => s.setMessages);
  const { proposal, accept, reject } = useProposalActions();
  const [text, setText] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  // ⌘K focuses the composer from anywhere in the window.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = () => {
    const parts = text ? [...draft, text] : draft;
    if (parts.length === 0) {
      return;
    }
    setMessages([
      ...messages,
      { role: 'user', parts },
      { role: 'assistant', parts: ['(Prototype: no model is connected yet.)'] },
    ]);
    setDraft([]);
    setText('');
    setDrawerOpen(true);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <section aria-label="Assistant" className={classes.assistant}>
      {isDrawerOpen ? (
        <div className={classes.drawer}>
          <div className={classes.drawerHeader}>
            <span>Conversation</span>
            <button
              aria-label="Collapse conversation"
              className={classes.iconButton}
              type="button"
              onClick={() => setDrawerOpen(false)}>
              <TbChevronDown />
            </button>
          </div>
          <ol className={classes.thread}>
            {messages.map((m, i) => (
              <li key={i} className={cx({ message: true, user: m.role === 'user' })}>
                <Parts parts={m.parts} />
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {proposal ? (
        <div aria-live="polite" className={classes.proposal}>
          <p className={classes.proposalSummary}>
            <Parts parts={proposal.summary} />
          </p>
          <ul className={classes.changes}>
            {proposal.changes.map((c, i) => (
              <li key={i} className={cx({ change: true, [c.kind]: true })}>
                <span aria-hidden className={classes.changeMark}>
                  {c.kind === 'add' ? '+' : c.kind === 'remove' ? '−' : '~'}
                </span>
                <span>
                  <Parts parts={c.parts} />
                </span>
              </li>
            ))}
          </ul>
          <div className={classes.proposalActions}>
            <span className={classes.hint}>Shown dashed in the preview</span>
            <button className={classes.secondary} type="button" onClick={reject}>
              <TbX /> Reject
            </button>
            <button className={classes.primary} type="button" onClick={accept}>
              <TbCheck /> Accept <kbd>⌘↵</kbd>
            </button>
          </div>
        </div>
      ) : !isDrawerOpen && lastAssistant ? (
        <button className={classes.lastReply} type="button" onClick={() => setDrawerOpen(true)}>
          <TbChevronUp />
          <span className={classes.lastReplyText}>
            <Parts parts={lastAssistant.parts} />
          </span>
        </button>
      ) : null}

      <div className={classes.composerWrap}>
        {picker ? <ReferencePicker trigger={picker} /> : null}
        {isAddItemOpen ? <AddItemList /> : null}

        <div className={classes.composer}>
          <button
            aria-expanded={isAddItemOpen}
            className={classes.addItem}
            type="button"
            onClick={() => setAddItemOpen(!isAddItemOpen)}>
            <TbPlus /> Add item
          </button>
          <div
            className={classes.field}
            onClick={() => inputRef.current?.focus()}>
            <Parts parts={draft} />
            <input
              ref={inputRef}
              aria-label="Ask the assistant"
              className={classes.input}
              placeholder={
                draft.length ? '' : 'Ask to build or change a menu…'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === '@' || e.key === '/' || e.key === '#') {
                  if (text === '' || text.endsWith(' ')) {
                    openPicker(e.key);
                  }
                }
                if (e.key === 'Escape') {
                  openPicker(null);
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>
          <button aria-label="Send" className={classes.send} type="button" onClick={send}>
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
