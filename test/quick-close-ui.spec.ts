//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

// Register empty mock for SCSS files so Node can load components that import stylesheets.
require.extensions['.scss'] = () => ({});
require.extensions['.css'] = () => ({});

import { expect } from 'chai';
import {
  DEFAULT_QUICK_CLOSE_BINDINGS,
  Modifiers,
  QuickCloseBindings,
} from '../src/common/app-switcher';
import {
  formatModifierChips,
  getModifierFromEvent,
  ModifierRecorderSession,
} from '../src/settings-renderer/components/common/ModifierRecorder';
import { validateQuickCloseBinding } from '../src/common/quick-close-validation';
import { resolveQuickCloseConfig } from '../src/common/app-switcher';
import { useMenuSettings } from '../src/settings-renderer/state/menu-settings';

describe('Quick close settings UI pure logic', () => {
  describe('getModifierFromEvent', () => {
    it('detects standard modifier keys', () => {
      expect(getModifierFromEvent('Control')).to.equal('ctrl');
      expect(getModifierFromEvent('Meta')).to.equal('meta');
      expect(getModifierFromEvent('Alt')).to.equal('alt');
      expect(getModifierFromEvent('Shift')).to.equal('shift');
    });

    it('detects modifier keys by code when key differs', () => {
      expect(getModifierFromEvent('', 'ControlLeft')).to.equal('ctrl');
      expect(getModifierFromEvent('', 'MetaRight')).to.equal('meta');
      expect(getModifierFromEvent('', 'AltLeft')).to.equal('alt');
      expect(getModifierFromEvent('', 'ShiftRight')).to.equal('shift');
    });

    it('returns null for non-modifier keys', () => {
      expect(getModifierFromEvent('Enter')).to.be.null;
      expect(getModifierFromEvent(' ')).to.be.null;
      expect(getModifierFromEvent('Escape')).to.be.null;
      expect(getModifierFromEvent('q', 'KeyQ')).to.be.null;
      expect(getModifierFromEvent('Tab')).to.be.null;
    });
  });

  describe('formatModifierChips', () => {
    it('formats single modifiers on macOS', () => {
      expect(
        formatModifierChips({ ctrl: true, meta: false, alt: false, shift: false }, true)
      ).to.deep.equal(['Ctrl']);
      expect(
        formatModifierChips({ ctrl: false, meta: true, alt: false, shift: false }, true)
      ).to.deep.equal(['Cmd']);
      expect(
        formatModifierChips({ ctrl: false, meta: false, alt: true, shift: false }, true)
      ).to.deep.equal(['Option']);
      expect(
        formatModifierChips({ ctrl: false, meta: false, alt: false, shift: true }, true)
      ).to.deep.equal(['Shift']);
    });

    it('formats single modifiers on non-macOS', () => {
      expect(
        formatModifierChips({ ctrl: false, meta: true, alt: false, shift: false }, false)
      ).to.deep.equal(['Super']);
      expect(
        formatModifierChips({ ctrl: false, meta: false, alt: true, shift: false }, false)
      ).to.deep.equal(['Alt']);
    });

    it('formats multiple modifiers in canonical order', () => {
      const combo: Modifiers = { ctrl: true, meta: true, alt: true, shift: true };
      expect(formatModifierChips(combo, true)).to.deep.equal([
        'Ctrl',
        'Cmd',
        'Option',
        'Shift',
      ]);
    });

    it('formats Hide app default combo (Cmd + Option on macOS)', () => {
      const hideCombo = DEFAULT_QUICK_CLOSE_BINDINGS.hide;
      expect(formatModifierChips(hideCombo, true)).to.deep.equal(['Cmd', 'Option']);
    });

    it('returns empty array when no modifiers are set', () => {
      const empty: Modifiers = { ctrl: false, meta: false, alt: false, shift: false };
      expect(formatModifierChips(empty, true)).to.deep.equal([]);
    });
  });

  describe('ModifierRecorderSession state machine', () => {
    it('commits single modifier when pressed and released', () => {
      const session = new ModifierRecorderSession();

      const down = session.handleKeyDown({ key: 'Control' });
      expect(down.type).to.equal('continue');

      const up = session.handleKeyUp({ key: 'Control' });
      expect(up.type).to.equal('commit');
      if (up.type === 'commit') {
        expect(up.combo).to.deep.equal({
          ctrl: true,
          meta: false,
          alt: false,
          shift: false,
        });
      }
    });

    it('commits largest held set across staggered key releases', () => {
      const session = new ModifierRecorderSession();

      // Press Meta, then Alt
      session.handleKeyDown({ key: 'Meta', metaKey: true });
      session.handleKeyDown({ key: 'Alt', metaKey: true, altKey: true });

      // Release Meta while Alt is still held
      const partialUp = session.handleKeyUp({
        key: 'Meta',
        metaKey: false,
        altKey: true,
      });
      expect(partialUp.type).to.equal('continue');

      // Release Alt: now all modifiers released -> commits Meta + Alt
      const finalUp = session.handleKeyUp({
        key: 'Alt',
        metaKey: false,
        altKey: false,
      });
      expect(finalUp.type).to.equal('commit');
      if (finalUp.type === 'commit') {
        expect(finalUp.combo).to.deep.equal({
          ctrl: false,
          meta: true,
          alt: true,
          shift: false,
        });
      }
    });

    it('commits largest simultaneously-held set rather than a union of rolling chord keys', () => {
      const session = new ModifierRecorderSession();

      // Press Ctrl, then Shift (active: Ctrl+Shift; size 2 > 0 -> largest: Ctrl+Shift)
      session.handleKeyDown({ key: 'Control', ctrlKey: true });
      session.handleKeyDown({ key: 'Shift', ctrlKey: true, shiftKey: true });

      // Release Shift while retaining Ctrl (active: Ctrl; largest: Ctrl+Shift)
      const releaseShift = session.handleKeyUp({
        key: 'Shift',
        ctrlKey: true,
        shiftKey: false,
      });
      expect(releaseShift.type).to.equal('continue');

      // Press Alt while Ctrl is held (active: Ctrl+Alt; size 2 == largest size 2; tie keeps earlier Ctrl+Shift)
      const pressAlt = session.handleKeyDown({
        key: 'Alt',
        ctrlKey: true,
        altKey: true,
      });
      expect(pressAlt.type).to.equal('continue');

      // Release Alt
      session.handleKeyUp({
        key: 'Alt',
        ctrlKey: true,
        altKey: false,
      });

      // Release Ctrl: all released -> commits Ctrl+Shift, NOT Ctrl+Shift+Alt
      const finalCommit = session.handleKeyUp({
        key: 'Control',
        ctrlKey: false,
        altKey: false,
      });
      expect(finalCommit.type).to.equal('commit');
      if (finalCommit.type === 'commit') {
        expect(finalCommit.combo).to.deep.equal({
          ctrl: true,
          meta: false,
          alt: false,
          shift: true,
        });
      }
    });

    it('commits immediately when a non-modifier key is pressed with held modifiers', () => {
      const session = new ModifierRecorderSession();

      session.handleKeyDown({ key: 'Meta', metaKey: true });
      const nonMod = session.handleKeyDown({ key: 'q', metaKey: true });

      expect(nonMod.type).to.equal('commit');
      if (nonMod.type === 'commit') {
        expect(nonMod.combo.meta).to.be.true;
        expect(nonMod.combo.ctrl).to.be.false;
      }
    });

    it('ignores plain keys alone without any modifier held', () => {
      const session = new ModifierRecorderSession();

      const res = session.handleKeyDown({ key: 'a' });
      expect(res.type).to.equal('ignore');
    });

    it('cancels when Escape is pressed', () => {
      const session = new ModifierRecorderSession();

      session.handleKeyDown({ key: 'Control', ctrlKey: true });
      const cancel = session.handleKeyDown({ key: 'Escape' });
      expect(cancel.type).to.equal('cancel');
    });

    it('ignores Enter and Space before any modifier is seen', () => {
      // Blanket rule covers the Enter or Space key that activated the Change button
      const session = new ModifierRecorderSession();

      expect(session.handleKeyDown({ key: 'Enter' }).type).to.equal('ignore');
      expect(session.handleKeyUp({ key: 'Enter' }).type).to.equal('ignore');
      expect(session.handleKeyDown({ key: ' ' }).type).to.equal('ignore');
      expect(session.handleKeyUp({ key: ' ' }).type).to.equal('ignore');

      // Subsequent modifier keys are handled normally
      session.handleKeyDown({ key: 'Shift', shiftKey: true });
      const commit = session.handleKeyUp({ key: 'Shift', shiftKey: false });
      expect(commit.type).to.equal('commit');
      if (commit.type === 'commit') {
        expect(commit.combo.shift).to.be.true;
      }
    });
  });

  describe('Validation integration for UI bindings', () => {
    const bindings: QuickCloseBindings = {
      quit: { ctrl: true, meta: false, alt: false, shift: false },
      closeWindow: { ctrl: false, meta: true, alt: false, shift: false },
      closeTab: { ctrl: false, meta: false, alt: true, shift: false },
      hide: { ctrl: false, meta: true, alt: true, shift: false },
    };

    it('reports duplicate conflict with the specific action', () => {
      // Trying to set closeWindow to Ctrl (already used by quit)
      const res = validateQuickCloseBinding(bindings, 'closeWindow', bindings.quit);
      expect(res.ok).to.be.false;
      if ('reason' in res) {
        expect(res.reason).to.equal('duplicate');
        expect(res.conflictsWith).to.equal('quit');
      }
    });

    it('reports empty error when modifier combo is empty', () => {
      const empty: Modifiers = { ctrl: false, meta: false, alt: false, shift: false };
      const res = validateQuickCloseBinding(bindings, 'quit', empty);
      expect(res.ok).to.be.false;
      if ('reason' in res) {
        expect(res.reason).to.equal('empty');
      }
    });

    it('permits setting an unused modifier combination', () => {
      const newCombo: Modifiers = {
        ctrl: true,
        meta: false,
        alt: false,
        shift: true,
      };
      const res = validateQuickCloseBinding(bindings, 'quit', newCombo);
      expect(res.ok).to.be.true;
    });
  });

  describe('Menu creation and duplication paths in settings-renderer state', () => {
    it('creates new menu with explicit disabled Quick close config', () => {
      const store = useMenuSettings.getState();
      const initialCount = store.menus.length;

      store.addMenu(['test-tag']);

      const updated = useMenuSettings.getState();
      expect(updated.menus.length).to.equal(initialCount + 1);

      const created = updated.menus[updated.menus.length - 1];
      expect(created.quickClose).to.not.be.undefined;
      expect(created.quickClose?.enabled).to.be.false;
      expect(created.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });

    it('duplicates existing menu preserving its quickClose setting', () => {
      const store = useMenuSettings.getState();
      const targetIndex = store.menus.length - 1;
      const original = store.menus[targetIndex];

      store.duplicateMenu(targetIndex);

      const updated = useMenuSettings.getState();
      const duplicated = updated.menus[targetIndex + 1];

      expect(duplicated.quickClose).to.deep.equal(original.quickClose);
    });

    it('treats legacy menu without quickClose as enabled with defaults when resolved', () => {
      const resolved = resolveQuickCloseConfig(undefined);
      expect(resolved.enabled).to.be.true;
      expect(resolved.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });
  });
});
