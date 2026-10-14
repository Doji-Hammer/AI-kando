//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import {
  Modifiers,
  QuickCloseAction,
  QuickCloseBindings,
  QuickCloseConfig,
} from './app-switcher';

const ALL_ACTIONS: readonly QuickCloseAction[] = [
  'quit',
  'closeWindow',
  'closeTab',
  'hide',
];

/** Checks if two modifier combinations are identical on all four keys. */
export function sameModifiers(a: Modifiers, b: Modifiers): boolean {
  return (
    Boolean(a.ctrl) === Boolean(b.ctrl) &&
    Boolean(a.meta) === Boolean(b.meta) &&
    Boolean(a.alt) === Boolean(b.alt) &&
    Boolean(a.shift) === Boolean(b.shift)
  );
}

/**
 * Validates a candidate modifier combination for a single action against existing
 * bindings.
 *
 * Rules:
 *
 * - Empty combinations (all false) are rejected with reason 'empty'.
 * - Combinations that match any OTHER action's binding are rejected with reason
 *   'duplicate'.
 */
export function validateQuickCloseBinding(
  bindings: QuickCloseBindings,
  action: QuickCloseAction,
  combo: Modifiers
):
  | { ok: true }
  | { ok: false; reason: 'empty' | 'duplicate'; conflictsWith?: QuickCloseAction } {
  if (!combo.ctrl && !combo.meta && !combo.alt && !combo.shift) {
    return { ok: false, reason: 'empty' };
  }

  for (const otherAction of ALL_ACTIONS) {
    if (otherAction === action) {
      continue;
    }
    const otherBinding = bindings[otherAction];
    if (otherBinding && sameModifiers(otherBinding, combo)) {
      return { ok: false, reason: 'duplicate', conflictsWith: otherAction };
    }
  }

  return { ok: true };
}

/**
 * Strict validation of an entire Quick close configuration object.
 *
 * Rules:
 *
 * - Must be an object with boolean `enabled` and object `bindings`.
 * - All four actions ('quit', 'closeWindow', 'closeTab', 'hide') must be present.
 * - Every modifier (ctrl, meta, alt, shift) must be an explicit boolean value.
 * - Every action binding must have at least one modifier key true.
 * - No two actions may have identical modifier combinations.
 */
export function validateQuickCloseConfig(
  config: unknown
): { ok: true; config: QuickCloseConfig } | { ok: false; reason: string } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, reason: 'Quick close configuration must be an object.' };
  }

  const candidate = config as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean') {
    return { ok: false, reason: 'Property "enabled" must be a boolean.' };
  }

  if (
    !candidate.bindings ||
    typeof candidate.bindings !== 'object' ||
    Array.isArray(candidate.bindings)
  ) {
    return { ok: false, reason: 'Property "bindings" must be an object.' };
  }

  const rawBindings = candidate.bindings as Record<string, unknown>;
  const normalizedBindings: Partial<QuickCloseBindings> = {};
  const seenCombos = new Map<string, QuickCloseAction>();

  for (const action of ALL_ACTIONS) {
    const rawActionBinding = rawBindings[action];
    if (
      !rawActionBinding ||
      typeof rawActionBinding !== 'object' ||
      Array.isArray(rawActionBinding)
    ) {
      return {
        ok: false,
        reason: `Missing or invalid binding for action "${action}".`,
      };
    }

    const b = rawActionBinding as Record<string, unknown>;
    if (
      typeof b.ctrl !== 'boolean' ||
      typeof b.meta !== 'boolean' ||
      typeof b.alt !== 'boolean' ||
      typeof b.shift !== 'boolean'
    ) {
      return {
        ok: false,
        reason: `Modifiers for action "${action}" must be boolean values.`,
      };
    }

    const { ctrl, meta, alt, shift } = b;
    if (!ctrl && !meta && !alt && !shift) {
      return {
        ok: false,
        reason: `Modifier combination for action "${action}" cannot be empty.`,
      };
    }

    const combo: Modifiers = { ctrl, meta, alt, shift };
    const key = `${ctrl},${meta},${alt},${shift}`;
    const duplicate = seenCombos.get(key);
    if (duplicate) {
      return {
        ok: false,
        reason: `Actions "${duplicate}" and "${action}" share the same modifier combination.`,
      };
    }

    seenCombos.set(key, action);
    normalizedBindings[action] = combo;
  }

  return {
    ok: true,
    config: {
      enabled: candidate.enabled,
      bindings: normalizedBindings as QuickCloseBindings,
    },
  };
}
