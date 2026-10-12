//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import React from 'react';
import classNames from 'classnames/bind';

import * as classes from './LeftPanel.module.scss';
const cx = classNames.bind(classes);

import { MenuList } from '../menu-list';
import { Scrollbox } from '../common';
import {
  useAssistant,
  useCurrentThread,
  useAppState,
  useMenuSettings,
} from '../../state';
import { Parts } from './Assistant';

/** The selected menu's conversation with the assistant. */
function ChatHistory() {
  const { key, messages } = useCurrentThread();
  const isBusy = useAssistant((s) => s.isBusy);
  const setThread = useAssistant((s) => s.setThread);
  const end = React.useRef<HTMLLIElement>(null);

  // Keep the newest message in view.
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, isBusy]);

  return (
    <div className={classes.chat}>
      <div className={classes.chatHeader}>
        <span className={classes.chatTitle}>{key || 'No menu selected'}</span>
        {messages.length > 0 ? (
          <button
            className={classes.clear}
            type="button"
            onClick={() => setThread(key, [])}>
            Clear
          </button>
        ) : null}
      </div>
      <Scrollbox>
        {messages.length === 0 && !isBusy ? (
          <p className={classes.empty}>
            No conversation about this menu yet. Ask below the preview, and the answers
            appear here.
          </p>
        ) : (
          <ol aria-live="polite" className={classes.thread}>
            {messages.map((m, i) => (
              <li
                // eslint-disable-next-line react/no-array-index-key -- append-only list
                key={i}
                className={cx({
                  message: true,
                  user: m.role === 'user',
                  error: m.isError,
                })}>
                <Parts parts={m.parts} />
              </li>
            ))}
            {isBusy ? <li className={classes.thinking}>Thinking…</li> : null}
            <li ref={end} aria-hidden className={classes.end} />
          </ol>
        )}
      </Scrollbox>
    </div>
  );
}

/**
 * The left column: all menus, or the conversation about the selected menu. The menu list
 * keeps its own collection strip, search and add buttons unchanged.
 */
export default function LeftPanel() {
  const leftTab = useAssistant((s) => s.leftTab);
  const setLeftTab = useAssistant((s) => s.setLeftTab);
  const { messages } = useCurrentThread();
  const selectedMenu = useAppState((s) => s.selectedMenu);
  const menuName = useMenuSettings((s) => s.menus[selectedMenu]?.root.name ?? '');

  const tabs: { id: 'menus' | 'chat'; label: string; count?: number }[] = [
    { id: 'menus', label: 'Menus' },
    { id: 'chat', label: 'Chat', count: messages.length },
  ];

  return (
    <div className={classes.panel}>
      <div aria-label="Left panel" className={classes.tabs} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            aria-controls={'left-panel-' + t.id}
            aria-selected={leftTab === t.id}
            className={cx({ tab: true, active: leftTab === t.id })}
            id={'left-tab-' + t.id}
            role="tab"
            title={
              t.id === 'chat' && menuName ? 'Conversation about ' + menuName : undefined
            }
            type="button"
            onClick={() => setLeftTab(t.id)}>
            {t.label}
            {t.count ? <span className={classes.count}>{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={'left-tab-' + leftTab}
        className={classes.content}
        id={'left-panel-' + leftTab}
        role="tabpanel">
        {leftTab === 'menus' ? <MenuList /> : <ChatHistory />}
      </div>
    </div>
  );
}
