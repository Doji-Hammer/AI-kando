//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/naming-convention -- provider wire formats and tool arguments use snake_case. */

import {
  GENERAL_SETTINGS_SCHEMA,
  MENU_SCHEMA,
  GeneralSettings,
  Menu,
} from '../../common/settings-schemata';
import {
  BUTTON_MENU_ITEM_SCHEMA_V2,
  SUBMENU_MENU_ITEM_SCHEMA_V2,
} from '../../common/settings-schemata/menu-settings-v2';
import type {
  AssistantChangeLine,
  AssistantMarker,
  AssistantProposal,
} from '../../common/assistant-types';
import { DEFAULT_QUICK_CLOSE_BINDINGS } from '../../common/app-switcher';
import { validateQuickCloseConfig } from '../../common/quick-close-validation';

/**
 * Applies the operations the model proposed to a COPY of the configuration and checks the
 * result with Kando's own settings schemas. Nothing here touches the live settings: the
 * user still has to accept the proposal in the settings window.
 */

export type Operation =
  | { op: 'add_item'; menu: number; parent_path: number[]; index?: number; item: unknown }
  | { op: 'update_item'; menu: number; path: number[]; changes: Record<string, unknown> }
  | { op: 'remove_item'; menu: number; path: number[] }
  | { op: 'update_menu'; menu: number; changes: Record<string, unknown> }
  | { op: 'add_menu'; menu_definition: unknown }
  | { op: 'remove_menu'; menu: number }
  | { op: 'update_settings'; changes: Record<string, unknown> };

/** Menu-level fields the model may change with update_menu. `root` is changed via items. */
const MENU_FIELDS = [
  'shortcut',
  'shortcutID',
  'tags',
  'useFixedPosition',
  'fixedMenuPosition',
  'anchored',
  'hoverMode',
  'conditions',
];

/** Settings the assistant must never change: they affect the app, not menus. */
const PROTECTED_SETTINGS = new Set([
  'version',
  'ignoreWriteProtectedConfigFiles',
  'hardwareAcceleration',
  'settingsWindowFlavor',
]);

const MARK = '__assistantMark';

type Node = Record<string, unknown> & { children?: Node[]; name?: string };

export class OperationError extends Error {}

function itemAt(menu: Menu, path: number[]): Node {
  let node = menu.root as unknown as Node;
  for (let i = 0; i < path.length; i++) {
    const child = node.children?.[path[i]];
    if (!child) {
      throw new OperationError(
        `Path [${path.join(', ')}] does not exist in menu "${menu.root.name}" (stopped at step ${i}).`
      );
    }
    node = child;
  }
  return node;
}

function label(menu: Menu, path: number[]): string {
  const names = [menu.root.name];
  let node = menu.root as unknown as Node;
  for (const i of path) {
    node = node.children?.[i] as Node;
    names.push(node?.name ?? '?');
  }
  return names.join(' › ');
}

function checkIndex(n: unknown, what: string, max: number) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= max) {
    throw new OperationError(
      `${what} must be an index from 0 to ${max - 1}, got ${JSON.stringify(n)}.`
    );
  }
}

function checkPath(p: unknown, what: string) {
  if (!Array.isArray(p) || !p.every((x) => Number.isInteger(x) && x >= 0)) {
    throw new OperationError(
      `${what} must be an array of item indices, got ${JSON.stringify(p)}.`
    );
  }
}

function mark(node: Node, kind: 'add' | 'change') {
  if (node[MARK] !== 'add') {
    node[MARK] = kind;
  }
}

/** Collects the marked items and strips the marks. */
function collectMarkers(menus: Menu[]): AssistantMarker[] {
  const markers: AssistantMarker[] = [];
  menus.forEach((menu, menuIndex) => {
    const walk = (node: Node, path: number[]) => {
      if (node[MARK]) {
        markers.push({ menuIndex, path, kind: node[MARK] as 'add' | 'change' });
        delete node[MARK];
      }
      node.children?.forEach((c, i) => walk(c, [...path, i]));
    };
    walk(menu.root as unknown as Node, []);
  });
  return markers;
}

/** Validates a new item against its own type, so errors name the exact field. */
function checkItem(item: Node) {
  const schema =
    item.type === 'button'
      ? BUTTON_MENU_ITEM_SCHEMA_V2
      : item.type === 'submenu'
        ? SUBMENU_MENU_ITEM_SCHEMA_V2
        : null;
  if (!schema) {
    throw new OperationError(
      `item.type must be "button" or "submenu", got ${JSON.stringify(item.type)}.`
    );
  }
  const parsed = schema.safeParse(item);
  if (!parsed.success) {
    throw new OperationError('item is invalid: ' + formatZodIssues(parsed.error));
  }
}

function formatZodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return error.issues
    .slice(0, 6)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Applies the operations in order (each path refers to the state after the previous
 * operations) and returns a validated proposal, or throws an OperationError whose message
 * is sent back to the model so it can correct itself.
 */
export function buildProposal(
  summary: string,
  operations: Operation[],
  menusBefore: Menu[],
  settingsBefore: GeneralSettings
): AssistantProposal {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new OperationError('operations must be a non-empty array.');
  }

  const menus: Menu[] = structuredClone(menusBefore);
  const settingsChanges: Record<string, unknown> = {};
  const changes: AssistantChangeLine[] = [];

  operations.forEach((op, n) => {
    const where = `Operation ${n + 1} (${(op as { op?: string })?.op ?? 'unknown'}): `;
    try {
      switch (op.op) {
        case 'add_item': {
          checkIndex(op.menu, 'menu', menus.length);
          checkPath(op.parent_path, 'parent_path');
          const parent = itemAt(menus[op.menu], op.parent_path);
          if (!Array.isArray(parent.children)) {
            throw new OperationError('parent_path must point to the root or a submenu.');
          }
          if (!op.item || typeof op.item !== 'object') {
            throw new OperationError('item must be an object.');
          }
          const item = structuredClone(op.item) as Node;
          checkItem(item);
          const index =
            op.index === undefined
              ? parent.children.length
              : Math.min(op.index, parent.children.length);
          parent.children.splice(index, 0, item);
          mark(item, 'add');
          changes.push({
            kind: 'add',
            text: `Add “${String(item.name)}” to ${label(menus[op.menu], op.parent_path)}`,
          });
          break;
        }
        case 'update_item': {
          checkIndex(op.menu, 'menu', menus.length);
          checkPath(op.path, 'path');
          const node = itemAt(menus[op.menu], op.path);
          if (!op.changes || typeof op.changes !== 'object') {
            throw new OperationError('changes must be an object.');
          }
          const before = label(menus[op.menu], op.path);
          for (const [key, value] of Object.entries(op.changes)) {
            if (key === 'children' || key === 'type') {
              throw new OperationError(
                `"${key}" can't be changed with update_item; add or remove items instead.`
              );
            }
            if (value === null) {
              delete node[key];
            } else {
              node[key] = value;
            }
          }
          mark(node, 'change');
          changes.push({
            kind: 'change',
            text: `Change ${Object.keys(op.changes).join(', ')} of ${before}`,
          });
          break;
        }
        case 'remove_item': {
          checkIndex(op.menu, 'menu', menus.length);
          checkPath(op.path, 'path');
          if (op.path.length === 0) {
            throw new OperationError(
              'The root item can only be removed with remove_menu.'
            );
          }
          itemAt(menus[op.menu], op.path); // throws if it doesn't exist
          const text = `Remove ${label(menus[op.menu], op.path)}`;
          const parent = itemAt(menus[op.menu], op.path.slice(0, -1));
          parent.children!.splice(op.path[op.path.length - 1], 1);
          changes.push({ kind: 'remove', text });
          break;
        }
        case 'update_menu': {
          checkIndex(op.menu, 'menu', menus.length);
          const menu = menus[op.menu] as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(op.changes ?? {})) {
            if (!MENU_FIELDS.includes(key)) {
              throw new OperationError(
                `"${key}" is not a menu field. Allowed: ${MENU_FIELDS.join(', ')}.`
              );
            }
            if (value === null) {
              delete menu[key];
            } else {
              menu[key] = value;
            }
          }
          mark(menus[op.menu].root as unknown as Node, 'change');
          changes.push({
            kind: 'change',
            text: `Change ${Object.keys(op.changes ?? {}).join(', ')} of menu “${menus[op.menu].root.name}”`,
          });
          break;
        }
        case 'add_menu': {
          if (
            op.menu_definition &&
            typeof op.menu_definition === 'object' &&
            'quickClose' in op.menu_definition &&
            (op.menu_definition as Record<string, unknown>).quickClose !== undefined
          ) {
            const qc = (op.menu_definition as Record<string, unknown>).quickClose;
            const validation = validateQuickCloseConfig(qc);
            if (!validation.ok) {
              const reason = 'reason' in validation ? validation.reason : 'invalid';
              throw new OperationError(
                `menu_definition.quickClose is invalid: ${reason}`
              );
            }
          }
          const parsed = MENU_SCHEMA.safeParse(op.menu_definition);
          if (!parsed.success) {
            throw new OperationError(
              'menu_definition is invalid: ' + formatZodIssues(parsed.error)
            );
          }
          const newMenu = parsed.data as Menu;
          newMenu.quickClose = {
            enabled: false,
            bindings: { ...DEFAULT_QUICK_CLOSE_BINDINGS },
          };
          menus.push(newMenu);
          mark(menus[menus.length - 1].root as unknown as Node, 'add');
          changes.push({ kind: 'add', text: `Add menu “${parsed.data.root.name}”` });
          break;
        }
        case 'remove_menu': {
          checkIndex(op.menu, 'menu', menus.length);
          changes.push({
            kind: 'remove',
            text: `Remove menu “${menus[op.menu].root.name}”`,
          });
          menus.splice(op.menu, 1);
          break;
        }
        case 'update_settings': {
          for (const [key, value] of Object.entries(op.changes ?? {})) {
            if (!(key in settingsBefore)) {
              throw new OperationError(`"${key}" is not a Kando setting.`);
            }
            if (PROTECTED_SETTINGS.has(key)) {
              throw new OperationError(
                `"${key}" can only be changed by the user in Settings.`
              );
            }
            settingsChanges[key] = value;
            changes.push({
              kind: 'change',
              text: `Set ${key} to ${JSON.stringify(value)}`,
            });
          }
          break;
        }
        default:
          throw new OperationError(
            'Unknown op. Use add_item, update_item, remove_item, update_menu, add_menu, remove_menu or update_settings.'
          );
      }
    } catch (e) {
      if (e instanceof OperationError) {
        throw new OperationError(where + e.message);
      }
      throw e;
    }
  });

  const markers = collectMarkers(menus);

  // Validate every menu with the real schema. This also fills in defaults (for example
  // "detached: true" on commands) exactly as loading the settings file would.
  const menusAfter = menus.map((menu, i) => {
    const parsed = MENU_SCHEMA.safeParse(menu);
    if (!parsed.success) {
      throw new OperationError(
        `The result is not a valid menu (menu ${i}, “${menu.root?.name}”): ${formatZodIssues(parsed.error)}`
      );
    }
    return parsed.data as Menu;
  });

  const parsedSettings = GENERAL_SETTINGS_SCHEMA.safeParse({
    ...settingsBefore,
    ...settingsChanges,
  });
  if (!parsedSettings.success) {
    throw new OperationError(
      'Invalid settings: ' + formatZodIssues(parsedSettings.error)
    );
  }
  const validSettingsChanges: Partial<GeneralSettings> = {};
  for (const key of Object.keys(settingsChanges) as (keyof GeneralSettings)[]) {
    (validSettingsChanges as Record<string, unknown>)[key] = parsedSettings.data[key];
  }

  return {
    summary: String(summary ?? '').trim() || 'Proposed changes',
    changes,
    menusAfter,
    settingsChanges: validSettingsChanges,
    markers,
  };
}
