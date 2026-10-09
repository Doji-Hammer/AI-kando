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

import * as classes from './Properties.module.scss';

import { useAppState, useMenuSettings, getSelectedChild, isProposed } from '../../state';
import {
  Accordion,
  AccordionItem,
  Headerbar,
  IconChooserButton,
  SettingsRow,
  TagInput,
  ShortcutPicker,
  Scrollbox,
  TextInput,
} from '../common';
import MenuConditions from './MenuConditions';
import { useProposalActions } from '../assistant/Assistant';
import MenuBehavior from './MenuBehavior';
import WorkflowEditor from './WorkflowEditor';

/**
 * This component shows the properties of the currently selected menu or menu item on the
 * right side of the settings dialog.
 */
export default function Properties() {
  const backend = useAppState((state) => state.backendInfo);
  const menus = useMenuSettings((state) => state.menus);
  const selectedMenu = useAppState((state) => state.selectedMenu);
  const selectedChildPath = useAppState((state) => state.selectedChildPath);

  const editMenu = useMenuSettings((state) => state.editMenu);
  const editMenuItem = useMenuSettings((state) => state.editMenuItem);
  const { proposal, accept, reject } = useProposalActions();
  const [menuTags, setMenuTags] = React.useState([]);
  const [expandedMenuPropertiesIndex, setExpandedMenuPropertiesIndex] = React.useState<
    number | null
  >(null);

  // Update the tag editor whenever the selected menu changes.
  React.useEffect(() => {
    setMenuTags(menus[selectedMenu]?.tags || []);
  }, [selectedMenu, menus]);

  if (selectedMenu === -1 || selectedMenu >= menus.length) {
    return (
      <>
        <Headerbar />
        <div className={classes.container} />
      </>
    );
  }

  // Get the currently selected menu item and whether it is the root item or not.
  const selectedItem = getSelectedChild(menus, selectedMenu, selectedChildPath);
  const isRoot = selectedItem?.type === 'root';

  // Returns a shortcut picker if the current backend supports shortcuts, else it will
  // return a text input for the shortcut ID.
  const getShortcutPicker = () => {
    if (backend.supportsShortcuts) {
      return (
        <ShortcutPicker
          isGrowing
          useModifiers
          info={i18next.t('settings.shortcut-info')}
          initialValue={menus[selectedMenu].shortcut}
          label={i18next.t('settings.shortcut-label')}
          mode="key-names"
          recordingPlaceholder={i18next.t('settings.shortcut-recording')}
          onChange={(shortcut) => {
            editMenu(selectedMenu, (menu) => {
              menu.shortcut = shortcut;
              return menu;
            });
          }}
        />
      );
    }
    return (
      <SettingsRow
        info={backend.shortcutHint}
        label={i18next.t('settings.shortcut-id-label')}>
        <TextInput
          initialValue={menus[selectedMenu].shortcutID}
          placeholder={i18next.t('settings.not-bound')}
          onChange={(shortcutID) => {
            editMenu(selectedMenu, (menu) => {
              menu.shortcutID = shortcutID;
              return menu;
            });
          }}
        />
      </SettingsRow>
    );
  };

  // One-line summaries so the closed sections still say what they do.
  const menu = menus[selectedMenu];
  const behaviorSummary = [
    menu?.useFixedPosition ? 'Fixed position' : 'At pointer',
    menu?.anchored ? 'anchored' : null,
    menu?.hoverMode ? 'hover mode' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const c = menu?.conditions;
  const conditionsSummary =
    [
      c?.appName ? 'Only in ' + c.appName : null,
      c?.windowName ? 'window “' + c.windowName + '”' : null,
      c?.screenArea ? 'screen area' : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Any app';

  return (
    <>
      <Headerbar />
      <div className={classes.container}>
        <div className={classes.icon}>
          <IconChooserButton
            buttonSize="large"
            icon={selectedItem.icon}
            iconSize="4em"
            theme={selectedItem.iconTheme}
            variant="invisible"
            onChange={(icon, theme) => {
              editMenuItem(selectedMenu, selectedChildPath, (item) => {
                item.icon = icon;
                item.iconTheme = theme;
                return item;
              });
            }}
          />
        </div>
        <div className={classes.name}>
          <TextInput
            initialValue={selectedItem.name}
            variant="invisible"
            onChange={(name) => {
              editMenuItem(selectedMenu, selectedChildPath, (item) => {
                item.name = name;
                return item;
              });
            }}
          />
        </div>
        {isProposed(selectedItem) && proposal ? (
          <div aria-live="polite" className={classes.proposalBanner}>
            <span>
              <b>Proposed by the assistant.</b> The fields below show the suggested
              values. Nothing is saved until you accept.
            </span>
            <span className={classes.proposalButtons}>
              <button type="button" onClick={reject}>
                Reject
              </button>
              <button className={classes.accept} type="button" onClick={accept}>
                Accept
              </button>
            </span>
          </div>
        ) : (
          <div className={classes.divider} />
        )}

        <Scrollbox>
          {isRoot ? (
            <div className={classes.menuProperties}>
              {getShortcutPicker()}
              <TagInput
                info={i18next.t('settings.tags-info')}
                label={i18next.t('settings.tags')}
                tags={menuTags}
                onChange={(newTags) => {
                  editMenu(selectedMenu, (menu) => {
                    menu.tags = newTags;
                    return menu;
                  });
                  setMenuTags(newTags);
                }}
              />
              <div style={{ height: 5 }} />
              <Accordion
                expandedIndex={expandedMenuPropertiesIndex}
                onExpandedIndexChange={setExpandedMenuPropertiesIndex}>
                <AccordionItem
                  summary={behaviorSummary}
                  title={i18next.t('settings.menu-behavior')}>
                  <MenuBehavior />
                </AccordionItem>
                <AccordionItem
                  summary={conditionsSummary}
                  title={i18next.t('settings.menu-conditions')}>
                  <MenuConditions />
                </AccordionItem>
              </Accordion>
              <div style={{ height: 2 }} />
            </div>
          ) : null}
          {selectedItem ? <WorkflowEditor /> : null}
        </Scrollbox>
      </div>
    </>
  );
}
