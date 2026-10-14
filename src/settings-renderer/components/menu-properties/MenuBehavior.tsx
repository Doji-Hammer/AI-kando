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
import classNames from 'classnames/bind';

import * as classes from './MenuBehavior.module.scss';
const cx = classNames.bind(classes);

import { useAppState, useMenuSettings } from '../../state';
import { Button, Checkbox, ModifierRecorder, Note } from '../common';
import {
  Modifiers,
  QuickCloseAction,
  resolveQuickCloseConfig,
} from '../../../common/app-switcher';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import ScreenPositionPicker from './ScreenPositionPicker';
import { BiTargetLock } from 'react-icons/bi';
import { clamp, isNaN, toNumber } from 'lodash';

/** This component shows the behavior options for the currently selected menu. */
export default function MenuBehavior() {
  const menus = useMenuSettings((state) => state.menus);
  const selectedMenu = useAppState((state) => state.selectedMenu);
  const editMenu = useMenuSettings((state) => state.editMenu);
  const backend = useAppState((state) => state.backendInfo);
  const tabCloseAvailable = Boolean(backend?.quickCloseTabAvailable);
  const [fixedPositionInputVisible, setFixedPositionInputVisible] = React.useState(false);
  const [fixedPositionPickerVisible, setFixedPositionPickerVisible] =
    React.useState(false);
  const [fixedPositionValueX, setFixedPositionValueX] = React.useState('');
  const [fixedPositionValueY, setFixedPositionValueY] = React.useState('');

  React.useEffect(() => {
    setFixedPositionInputVisible(menus[selectedMenu].useFixedPosition);
    setFixedPositionValueX(menus[selectedMenu].fixedMenuPosition.x.toFixed(4));
    setFixedPositionValueY(menus[selectedMenu].fixedMenuPosition.y.toFixed(4));
  }, [selectedMenu, menus]);

  const [menuPositionBehaviorRef] = useAutoAnimate({ duration: 250 });
  const [quickCloseActionsRef] = useAutoAnimate({ duration: 250 });

  const currentMenu = menus[selectedMenu];
  const quickCloseConfig = resolveQuickCloseConfig(currentMenu?.quickClose);

  const handleToggleQuickClose = (enabled: boolean) => {
    editMenu(selectedMenu, (menu) => {
      const resolved = resolveQuickCloseConfig(menu.quickClose);
      menu.quickClose = {
        enabled,
        bindings: {
          quit: { ...resolved.bindings.quit },
          closeWindow: { ...resolved.bindings.closeWindow },
          closeTab: { ...resolved.bindings.closeTab },
          hide: { ...resolved.bindings.hide },
        },
      };
      return menu;
    });
  };

  const handleChangeBinding = (action: QuickCloseAction, combo: Modifiers) => {
    editMenu(selectedMenu, (menu) => {
      const resolved = resolveQuickCloseConfig(menu.quickClose);
      menu.quickClose = {
        enabled: resolved.enabled,
        bindings: {
          quit: { ...resolved.bindings.quit },
          closeWindow: { ...resolved.bindings.closeWindow },
          closeTab: { ...resolved.bindings.closeTab },
          hide: { ...resolved.bindings.hide },
          [action]: combo,
        },
      };
      return menu;
    });
  };
  return (
    <div className={classes.container}>
      <Note useMarkdown marginBottom={-5} marginTop={-5}>
        {i18next.t('settings.menu-behavior-info', {
          link: 'https://kando.menu/usage/',
        })}
      </Note>
      <Checkbox
        info={i18next.t('settings.fixed-position-mode-info')}
        initialValue={menus[selectedMenu].useFixedPosition}
        label={i18next.t('settings.fixed-position-mode')}
        onChange={(enableFixedPosition) => {
          setFixedPositionInputVisible(enableFixedPosition);
          editMenu(selectedMenu, (menu) => {
            menu.useFixedPosition = enableFixedPosition;
            return menu;
          });
        }}
      />
      <div
        ref={menuPositionBehaviorRef}
        className={cx(classes.behaviorInput, classes.fixedPositionCondition)}>
        {fixedPositionInputVisible ? (
          <>
            {[
              {
                value: fixedPositionValueX,
                setValue: setFixedPositionValueX,
                label: i18next.t('settings.fixed-position-x-placeholder'),
              },
              {
                value: fixedPositionValueY,
                setValue: setFixedPositionValueY,
                label: i18next.t('settings.fixed-position-y-placeholder'),
              },
            ].map(({ value, setValue, label }, index) => (
              <input
                key={`list-${String(index)}`}
                placeholder={label}
                type="text"
                value={value}
                onBlur={() => {
                  editMenu(selectedMenu, (menu) => {
                    let xVal = toNumber(fixedPositionValueX);
                    let yVal = toNumber(fixedPositionValueY);

                    // Default to center of the screen.
                    if (isNaN(xVal)) {
                      xVal = 0.5;
                    }
                    if (isNaN(yVal)) {
                      yVal = 0.5;
                    }

                    menu.fixedMenuPosition = {
                      x: clamp(xVal, 0, 1),
                      y: clamp(yVal, 0, 1),
                    };
                    return menu;
                  });
                }}
                onChange={(event) => {
                  if (!event.target.value || event.target.value.match(/^\d*\.?\d*$/)) {
                    setValue(event.target.value);
                  }
                }}
              />
            ))}
            <Button
              isGrouped
              icon={<BiTargetLock />}
              tooltip={i18next.t('settings.fixed-position-tooltip')}
              variant="secondary"
              onClick={() => {
                setFixedPositionPickerVisible(true);
              }}
            />
          </>
        ) : null}
      </div>
      <Checkbox
        info={i18next.t('settings.anchored-mode-info')}
        initialValue={menus[selectedMenu].anchored}
        label={i18next.t('settings.anchored-mode')}
        onChange={(anchored) => {
          editMenu(selectedMenu, (menu) => {
            menu.anchored = anchored;
            return menu;
          });
        }}
      />
      <Checkbox
        info={i18next.t('settings.hover-mode-info')}
        initialValue={menus[selectedMenu].hoverMode}
        label={i18next.t('settings.hover-mode')}
        onChange={(hoverMode) => {
          editMenu(selectedMenu, (menu) => {
            menu.hoverMode = hoverMode;
            return menu;
          });
        }}
      />
      <div className={classes.sub}>
        <div className={classes.subT}>{i18next.t('settings.quick-close')}</div>
        <div
          className={cx({
            toggleRow: true,
            noBorder: !quickCloseConfig.enabled,
          })}>
          <div className={classes.lab}>
            {i18next.t('settings.quick-close-toggle')}
            <span className={classes.hint}>
              {i18next.t('settings.quick-close-toggle-info')}
            </span>
          </div>
          <input
            aria-label={i18next.t('settings.quick-close-toggle')}
            checked={quickCloseConfig.enabled}
            className={classes.checkbox}
            type="checkbox"
            onChange={(e) => handleToggleQuickClose(e.target.checked)}
          />
        </div>
        <div ref={quickCloseActionsRef}>
          {quickCloseConfig.enabled ? (
            <>
              <ModifierRecorder
                action="quit"
                allBindings={quickCloseConfig.bindings}
                label={i18next.t('settings.quick-close-action-quit')}
                selectedMenu={selectedMenu}
                value={quickCloseConfig.bindings.quit}
                onChange={(combo) => handleChangeBinding('quit', combo)}
              />
              <ModifierRecorder
                action="closeWindow"
                allBindings={quickCloseConfig.bindings}
                label={i18next.t('settings.quick-close-action-close-window')}
                selectedMenu={selectedMenu}
                value={quickCloseConfig.bindings.closeWindow}
                onChange={(combo) => handleChangeBinding('closeWindow', combo)}
              />
              <ModifierRecorder
                isExperimental
                action="closeTab"
                allBindings={quickCloseConfig.bindings}
                hint={
                  tabCloseAvailable
                    ? i18next.t('settings.quick-close-tab-supported-browsers')
                    : i18next.t('settings.quick-close-tab-disabled')
                }
                isDimmed={!tabCloseAvailable}
                isReadOnly={!tabCloseAvailable}
                label={i18next.t('settings.quick-close-action-close-tab')}
                selectedMenu={selectedMenu}
                value={quickCloseConfig.bindings.closeTab}
                onChange={(combo) => handleChangeBinding('closeTab', combo)}
              />
              <ModifierRecorder
                action="hide"
                allBindings={quickCloseConfig.bindings}
                label={i18next.t('settings.quick-close-action-hide')}
                selectedMenu={selectedMenu}
                value={quickCloseConfig.bindings.hide}
                onChange={(combo) => handleChangeBinding('hide', combo)}
              />
              <div className={classes.permissionNote}>
                {i18next.t('settings.quick-close-permission-hint')}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <ScreenPositionPicker
        isVisible={fixedPositionPickerVisible}
        onClose={() => setFixedPositionPickerVisible(false)}
        onSelect={(newPosition) => {
          setFixedPositionValueX(newPosition.x.toFixed(4));
          setFixedPositionValueY(newPosition.y.toFixed(4));
          editMenu(selectedMenu, (menu) => {
            menu.fixedMenuPosition = newPosition;
            return menu;
          });
        }}
      />
    </div>
  );
}
