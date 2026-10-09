//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import React from 'react';
import i18next from 'i18next';
import { TbSettingsFilled, TbPaletteFilled } from 'react-icons/tb';
import { IoArrowUndo, IoArrowRedo } from 'react-icons/io5';

import { useAppState, useMenuSettings } from '../../state';
import { Headerbar, Button } from '../common';

/**
 * This is the toolbar at the top of the menu-preview area. It contains some buttons for
 * undo/redo, and for opening the settings dialogs.
 */
export default function PreviewHeader() {
  const setThemesDialogVisible = useAppState((state) => state.setThemesDialogVisible);
  const setSettingsDialogVisible = useAppState((state) => state.setSettingsDialogVisible);

  // Undo/Redo buttons that only re-render when undo/redo state changes.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const UndoRedoButtons = React.memo(() => {
    const { futureStates, pastStates } = useMenuSettings.temporal.getState();
    // Subscribe to any menu change to update buttons.
    useMenuSettings();

    return (
      <>
        <Button
          isGrouped
          icon={<IoArrowUndo />}
          isDisabled={pastStates.length === 0}
          tooltip={i18next.t('settings.undo')}
          variant="tool"
          onClick={() => useMenuSettings.temporal.getState().undo()}
        />
        <Button
          isGrouped
          icon={<IoArrowRedo />}
          isDisabled={futureStates.length === 0}
          tooltip={i18next.t('settings.redo')}
          variant="tool"
          onClick={() => useMenuSettings.temporal.getState().redo()}
        />
      </>
    );
  });

  // About, Introduction and Achievements live in the macOS menu bar (Kando › About,
  // Help › Introduction, Window › Achievements). The toolbar keeps what you use while
  // editing: undo, redo, themes and settings, with text labels.

  return (
    <Headerbar
      center={
        <>
          <span style={{ marginRight: '12px' }}>
            <UndoRedoButtons />
          </span>
          <span style={{ display: 'inline-flex', gap: '4px' }}>
            <Button
              icon={<TbPaletteFilled />}
              label={i18next.t('settings.menu-themes-dialog.title')}
              size="small"
              tooltip="Menu themes"
              variant="tool"
              onClick={() => setThemesDialogVisible(true)}
            />
            <Button
              icon={<TbSettingsFilled />}
              label="Settings"
              size="small"
              tooltip="General settings (⌘,)"
              variant="tool"
              onClick={() => setSettingsDialogVisible(true)}
            />
          </span>
        </>
      }
    />
  );
}
