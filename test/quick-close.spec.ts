//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT
/* eslint-disable @typescript-eslint/naming-convention -- assistant operations use snake_case */

import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  DEFAULT_QUICK_CLOSE_BINDINGS,
  Modifiers,
  QuickCloseBindings,
  QuickCloseConfig,
  resolveQuickCloseConfig,
} from '../src/common/app-switcher';
import {
  validateQuickCloseBinding,
  validateQuickCloseConfig,
} from '../src/common/quick-close-validation';
import { GENERAL_SETTINGS_SCHEMA, GeneralSettings } from '../src/common';
import {
  MENU_SCHEMA_V2,
  MENU_SETTINGS_SCHEMA_V2,
  MenuV2,
  RootMenuItemV2,
} from '../src/common/settings-schemata/menu-settings-v2';
import { Settings } from '../src/main/settings';
import { buildProposal } from '../src/main/assistant/operations';

const dummySettings: GeneralSettings = GENERAL_SETTINGS_SCHEMA.parse({});

function makeRootItem(name = 'Test Root'): RootMenuItemV2 {
  return {
    type: 'root',
    name,
    icon: 'star',
    iconTheme: 'material-symbols-rounded',
    children: [],
  };
}

function makeBasicMenu(name = 'Test Menu'): MenuV2 {
  return {
    root: makeRootItem(name),
    shortcut: '',
    shortcutID: '',
    useFixedPosition: false,
    fixedMenuPosition: { x: 0.5, y: 0.5 },
    anchored: false,
    hoverMode: false,
    tags: [],
  };
}

describe('Quick close validation and schema recovery', () => {
  describe('validateQuickCloseBinding', () => {
    const bindings: QuickCloseBindings = {
      quit: { ctrl: true, meta: false, alt: false, shift: false },
      closeWindow: { ctrl: false, meta: true, alt: false, shift: false },
      closeTab: { ctrl: false, meta: false, alt: true, shift: false },
      hide: { ctrl: false, meta: true, alt: true, shift: false },
    };

    it('rejects an empty modifier combination', () => {
      const empty: Modifiers = { ctrl: false, meta: false, alt: false, shift: false };
      const res = validateQuickCloseBinding(bindings, 'quit', empty);
      expect(res.ok).to.be.false;
      if ('reason' in res) {
        expect(res.reason).to.equal('empty');
      }
    });

    it('rejects duplicate combination used by another action', () => {
      const duplicate: Modifiers = { ctrl: false, meta: true, alt: false, shift: false };
      const res = validateQuickCloseBinding(bindings, 'quit', duplicate);
      expect(res.ok).to.be.false;
      if ('reason' in res) {
        expect(res.reason).to.equal('duplicate');
        expect(res.conflictsWith).to.equal('closeWindow');
      }
    });

    it('allows keeping the current combination of the same action', () => {
      const currentQuit: Modifiers = {
        ctrl: true,
        meta: false,
        alt: false,
        shift: false,
      };
      const res = validateQuickCloseBinding(bindings, 'quit', currentQuit);
      expect(res.ok).to.be.true;
    });

    it('accepts an unused valid modifier combination', () => {
      const unused: Modifiers = { ctrl: true, meta: false, alt: false, shift: true };
      const res = validateQuickCloseBinding(bindings, 'quit', unused);
      expect(res.ok).to.be.true;
    });
  });

  describe('validateQuickCloseConfig', () => {
    it('rejects non-object values', () => {
      expect(validateQuickCloseConfig(null).ok).to.be.false;
      expect(validateQuickCloseConfig('string').ok).to.be.false;
      expect(validateQuickCloseConfig([]).ok).to.be.false;
    });

    it('rejects non-boolean enabled', () => {
      const bad = { enabled: 'true', bindings: DEFAULT_QUICK_CLOSE_BINDINGS };
      expect(validateQuickCloseConfig(bad).ok).to.be.false;
    });

    it('rejects missing or empty action bindings', () => {
      const bad = {
        enabled: true,
        bindings: {
          quit: { ctrl: true, meta: false, alt: false, shift: false },
        },
      };
      expect(validateQuickCloseConfig(bad).ok).to.be.false;
    });

    it('rejects empty combination inside an action', () => {
      const bad = {
        enabled: true,
        bindings: {
          ...DEFAULT_QUICK_CLOSE_BINDINGS,
          quit: { ctrl: false, meta: false, alt: false, shift: false },
        },
      };
      expect(validateQuickCloseConfig(bad).ok).to.be.false;
    });

    it('rejects duplicate combinations between actions', () => {
      const bad = {
        enabled: true,
        bindings: {
          ...DEFAULT_QUICK_CLOSE_BINDINGS,
          quit: { ctrl: false, meta: true, alt: false, shift: false },
          closeWindow: { ctrl: false, meta: true, alt: false, shift: false },
        },
      };
      expect(validateQuickCloseConfig(bad).ok).to.be.false;
    });

    it('rejects non-boolean modifier values', () => {
      const bad = {
        enabled: true,
        bindings: {
          ...DEFAULT_QUICK_CLOSE_BINDINGS,
          quit: { ctrl: 'false', meta: false, alt: false, shift: false },
        },
      };
      expect(validateQuickCloseConfig(bad).ok).to.be.false;
    });

    it('accepts valid configuration and normalizes booleans', () => {
      const valid = {
        enabled: true,
        bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
      };
      const res = validateQuickCloseConfig(valid);
      expect(res.ok).to.be.true;
      if (res.ok) {
        expect(res.config.enabled).to.be.true;
        expect(res.config.bindings.quit.ctrl).to.be.true;
      }
    });
  });

  describe('resolveQuickCloseConfig', () => {
    it('applies legacy rule: absent stored config resolves to enabled with default bindings', () => {
      const resolved = resolveQuickCloseConfig(undefined);
      expect(resolved.enabled).to.be.true;
      expect(resolved.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });

    it('preserves explicitly disabled config', () => {
      const resolved = resolveQuickCloseConfig({
        enabled: false,
        bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
      });
      expect(resolved.enabled).to.be.false;
      expect(resolved.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });

    it('preserves explicitly enabled custom bindings', () => {
      const custom: QuickCloseConfig = {
        enabled: true,
        bindings: {
          quit: { ctrl: false, meta: true, alt: false, shift: true },
          closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
          closeTab: { ctrl: false, meta: false, alt: false, shift: true },
          hide: { ctrl: true, meta: true, alt: false, shift: false },
        },
      };
      const resolved = resolveQuickCloseConfig(custom);
      expect(resolved.enabled).to.be.true;
      expect(resolved.bindings.quit).to.deep.equal({
        ctrl: false,
        meta: true,
        alt: false,
        shift: true,
      });
    });

    it('fills default bindings when some actions are missing', () => {
      const partial = {
        enabled: true,
        bindings: {
          quit: { ctrl: true, meta: true, alt: false, shift: false },
        } as unknown as QuickCloseBindings,
      };
      const resolved = resolveQuickCloseConfig(partial);
      expect(resolved.enabled).to.be.true;
      expect(resolved.bindings.quit.meta).to.be.true;
      expect(resolved.bindings.closeWindow).to.deep.equal(
        DEFAULT_QUICK_CLOSE_BINDINGS.closeWindow
      );
    });
  });

  describe('MENU_SCHEMA_V2 parse and recovery', () => {
    it('leaves absent quickClose as undefined', () => {
      const raw = makeBasicMenu('No quick close');
      delete raw.quickClose;
      const parsed = MENU_SCHEMA_V2.parse(raw);
      expect(parsed.quickClose).to.be.undefined;
    });

    it('parses valid explicit disabled config', () => {
      const raw = {
        ...makeBasicMenu('Explicit off'),
        quickClose: {
          enabled: false,
          bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
        },
      };
      const parsed = MENU_SCHEMA_V2.parse(raw);
      expect(parsed.quickClose).to.deep.equal({
        enabled: false,
        bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
      });
    });

    it('parses valid explicit custom config', () => {
      const custom = {
        enabled: true,
        bindings: {
          quit: { ctrl: false, meta: true, alt: false, shift: true },
          closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
          closeTab: { ctrl: false, meta: false, alt: false, shift: true },
          hide: { ctrl: true, meta: true, alt: false, shift: false },
        },
      };
      const raw = {
        ...makeBasicMenu('Custom on'),
        quickClose: custom,
      };
      const parsed = MENU_SCHEMA_V2.parse(raw);
      expect(parsed.quickClose).to.deep.equal(custom);
    });

    it('recovers null quickClose to disabled defaults with warning', () => {
      const raw = {
        ...makeBasicMenu('Null quickClose'),
        quickClose: null as unknown,
      };
      const parsed = MENU_SCHEMA_V2.parse(raw);
      expect(parsed.quickClose).to.not.be.undefined;
      expect(parsed.quickClose?.enabled).to.be.false;
      expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });

    it('recovers wrong type quickClose to disabled defaults', () => {
      const raw = {
        ...makeBasicMenu('String quickClose'),
        quickClose: 'not a valid object',
      };
      const parsed = MENU_SCHEMA_V2.parse(raw);
      expect(parsed.quickClose?.enabled).to.be.false;
      expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });

    it('recovers duplicate binding combination to disabled defaults', () => {
      const raw = {
        ...makeBasicMenu('Duplicate bindings'),
        quickClose: {
          enabled: true,
          bindings: {
            quit: { ctrl: true, meta: false, alt: false, shift: false },
            closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
            closeTab: { ctrl: false, meta: false, alt: true, shift: false },
            hide: { ctrl: false, meta: true, alt: true, shift: false },
          },
        },
      };
      const parsed = MENU_SCHEMA_V2.parse(raw);
      expect(parsed.quickClose?.enabled).to.be.false;
      expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });

    it('recovers empty binding combination to disabled defaults', () => {
      const raw = {
        ...makeBasicMenu('Empty combo'),
        quickClose: {
          enabled: true,
          bindings: {
            quit: { ctrl: false, meta: false, alt: false, shift: false },
            closeWindow: { ctrl: false, meta: true, alt: false, shift: false },
            closeTab: { ctrl: false, meta: false, alt: true, shift: false },
            hide: { ctrl: false, meta: true, alt: true, shift: false },
          },
        },
      };
      const parsed = MENU_SCHEMA_V2.parse(raw);
      expect(parsed.quickClose?.enabled).to.be.false;
      expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
    });

    it('recovers bindings with string modifier values to disabled defaults with warning', () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
      try {
        const raw = {
          ...makeBasicMenu('String modifier'),
          quickClose: {
            enabled: true,
            bindings: {
              ...DEFAULT_QUICK_CLOSE_BINDINGS,
              quit: { ctrl: 'false', meta: false, alt: false, shift: false },
            },
          },
        };
        const parsed = MENU_SCHEMA_V2.parse(raw);
        expect(parsed.quickClose?.enabled).to.be.false;
        expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
        expect(warnings.some((w) => w.includes('Recovered malformed quickClose setting')))
          .to.be.true;
      } finally {
        console.warn = origWarn;
      }
    });

    it('recovers bindings with number modifier values to disabled defaults with warning', () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
      try {
        const raw = {
          ...makeBasicMenu('Number modifier'),
          quickClose: {
            enabled: true,
            bindings: {
              ...DEFAULT_QUICK_CLOSE_BINDINGS,
              quit: { ctrl: 1, meta: false, alt: false, shift: false },
            },
          },
        };
        const parsed = MENU_SCHEMA_V2.parse(raw);
        expect(parsed.quickClose?.enabled).to.be.false;
        expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
        expect(warnings.some((w) => w.includes('Recovered malformed quickClose setting')))
          .to.be.true;
      } finally {
        console.warn = origWarn;
      }
    });

    it('recovers bindings with null modifier values to disabled defaults with warning', () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
      try {
        const raw = {
          ...makeBasicMenu('Null modifier'),
          quickClose: {
            enabled: true,
            bindings: {
              ...DEFAULT_QUICK_CLOSE_BINDINGS,
              quit: { ctrl: null as unknown, meta: false, alt: false, shift: false },
            },
          },
        };
        const parsed = MENU_SCHEMA_V2.parse(raw);
        expect(parsed.quickClose?.enabled).to.be.false;
        expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
        expect(warnings.some((w) => w.includes('Recovered malformed quickClose setting')))
          .to.be.true;
      } finally {
        console.warn = origWarn;
      }
    });

    it('recovers bindings with a missing modifier key to disabled defaults with warning', () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
      try {
        const raw = {
          ...makeBasicMenu('Missing modifier key'),
          quickClose: {
            enabled: true,
            bindings: {
              ...DEFAULT_QUICK_CLOSE_BINDINGS,
              quit: { ctrl: true, meta: false, alt: false },
            },
          },
        };
        const parsed = MENU_SCHEMA_V2.parse(raw);
        expect(parsed.quickClose?.enabled).to.be.false;
        expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
        expect(warnings.some((w) => w.includes('Recovered malformed quickClose setting')))
          .to.be.true;
      } finally {
        console.warn = origWarn;
      }
    });

    it('never recovers a present malformed value to undefined', () => {
      const malformedCases = [null, 42, false, {}, { enabled: 'yes' }, []];
      for (const val of malformedCases) {
        const raw = { ...makeBasicMenu('Test'), quickClose: val };
        const parsed = MENU_SCHEMA_V2.parse(raw);
        expect(parsed.quickClose).to.not.be.undefined;
        expect(parsed.quickClose?.enabled).to.be.false;
      }
    });
  });

  describe('Real settings loader and round-trip persistence', () => {
    let testDir: string;
    const stores: { close(): void }[] = [];
    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kando-qc-test-'));
    });

    afterEach(() => {
      for (const store of stores) {
        store.close();
      }
      stores.length = 0;
      fs.removeSync(testDir);
    });

    it('preserves absence of quickClose across load -> save -> load round-trip', () => {
      const filePath = path.join(testDir, 'menus.json');
      const initialSettings = {
        version: '3.0.0',
        menus: [makeBasicMenu('Legacy Menu')],
      };
      delete initialSettings.menus[0].quickClose;
      fs.writeJSONSync(filePath, initialSettings);

      const store = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(store);

      const loadedMenus = store.get('menus');
      expect(loadedMenus[0].quickClose).to.be.undefined;

      // Trigger a save by mutating tags
      store.set({
        menus: [
          {
            ...makeBasicMenu('Legacy Menu'),
            tags: ['test-tag'],
          },
        ],
      });

      // Read raw file on disk and verify quickClose was not materialized
      const onDisk = fs.readJSONSync(filePath);
      expect(onDisk.menus[0].quickClose).to.be.undefined;
      expect(onDisk.menus[0].tags).to.deep.equal(['test-tag']);

      // Second loader pass: re-read through a fresh Settings loader
      store.close();
      const reloadedStore = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(reloadedStore);

      const reloadedMenus = reloadedStore.get('menus');
      expect(reloadedMenus[0].quickClose).to.be.undefined;
      expect(reloadedMenus[0].tags).to.deep.equal(['test-tag']);
    });

    it('preserves explicit disabled quickClose across load -> save -> load round-trip', () => {
      const filePath = path.join(testDir, 'menus.json');
      const initialSettings = {
        version: '3.0.0',
        menus: [
          {
            ...makeBasicMenu('Disabled Menu'),
            quickClose: {
              enabled: false,
              bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
            },
          },
        ],
      };
      fs.writeJSONSync(filePath, initialSettings);

      const store = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(store);

      const loaded = store.get('menus');
      expect(loaded[0].quickClose).to.deep.equal({
        enabled: false,
        bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
      });

      // Mutate tags and save
      store.set({
        menus: [
          {
            ...makeBasicMenu('Disabled Menu'),
            quickClose: {
              enabled: false,
              bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
            },
            tags: ['disabled-tag'],
          },
        ],
      });

      // Second loader pass
      store.close();
      const reloadedStore = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(reloadedStore);

      const reloaded = reloadedStore.get('menus');
      expect(reloaded[0].quickClose).to.deep.equal({
        enabled: false,
        bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
      });
      expect(reloaded[0].tags).to.deep.equal(['disabled-tag']);
    });

    it('writes full explicit object on first Quick close edit and preserves across second load', () => {
      const filePath = path.join(testDir, 'menus.json');
      const initialSettings = {
        version: '3.0.0',
        menus: [makeBasicMenu('Menu To Edit')],
      };
      delete initialSettings.menus[0].quickClose;
      fs.writeJSONSync(filePath, initialSettings);

      const store = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(store);

      const customConfig: QuickCloseConfig = {
        enabled: true,
        bindings: {
          quit: { ctrl: false, meta: true, alt: false, shift: true },
          closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
          closeTab: { ctrl: false, meta: false, alt: true, shift: false },
          hide: { ctrl: false, meta: true, alt: true, shift: false },
        },
      };

      const loaded = store.get('menus');
      expect(loaded[0].quickClose).to.be.undefined;
      store.set({
        menus: [
          {
            ...makeBasicMenu('Menu To Edit'),
            quickClose: customConfig,
          },
        ],
      });

      const onDisk = fs.readJSONSync(filePath);
      expect(onDisk.menus[0].quickClose).to.deep.equal(customConfig);

      // Second loader pass
      store.close();
      const reloadedStore = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(reloadedStore);

      const reloaded = reloadedStore.get('menus');
      expect(reloaded[0].quickClose).to.deep.equal(customConfig);
    });

    it('loads malformed quickClose without crashing, recovers to disabled defaults, and persists cleanly on reload', () => {
      const filePath = path.join(testDir, 'menus.json');
      const initialSettings = {
        version: '3.0.0',
        menus: [
          {
            ...makeBasicMenu('Broken Menu'),
            quickClose: {
              enabled: true,
              bindings: {
                quit: { ctrl: true, meta: false, alt: false, shift: false },
                closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
              },
            },
          },
        ],
      };
      fs.writeJSONSync(filePath, initialSettings);

      const store = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(store);

      const loaded = store.get('menus');
      expect(loaded[0].quickClose).to.not.be.undefined;
      expect(loaded[0].quickClose?.enabled).to.be.false;
      expect(loaded[0].quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);

      // Save the recovered state back to disk
      store.set({
        menus: [
          {
            ...makeBasicMenu('Broken Menu'),
            quickClose: {
              enabled: false,
              bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
            },
            tags: ['recovered-tag'],
          },
        ],
      });

      // Second loader pass: reloads cleanly without warning
      store.close();
      const reloadedStore = new Settings({
        name: 'menus',
        file: 'menus.json',
        directory: testDir,
        defaults: () => MENU_SETTINGS_SCHEMA_V2.parse({}),
        load: (content) => ({
          settings: MENU_SETTINGS_SCHEMA_V2.parse(content, { reportInput: true }),
          didMigration: false,
        }),
      });
      stores.push(reloadedStore);

      const reloaded = reloadedStore.get('menus');
      expect(reloaded[0].quickClose?.enabled).to.be.false;
      expect(reloaded[0].quickClose?.bindings).to.deep.equal(
        DEFAULT_QUICK_CLOSE_BINDINGS
      );
      expect(reloaded[0].tags).to.deep.equal(['recovered-tag']);
    });
  });

  describe('Assistant menu operations', () => {
    it('forces quickClose to disabled defaults on add_menu', () => {
      const menuProposal = {
        ...makeBasicMenu('New Menu via Assistant'),
        quickClose: {
          enabled: true,
          bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
        },
      };

      const proposal = buildProposal(
        'Add test menu',
        [{ op: 'add_menu', menu_definition: menuProposal }],
        [],
        dummySettings
      );

      const created = proposal.menusAfter[0];
      expect(created.quickClose).to.deep.equal({
        enabled: false,
        bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
      });
    });

    it('strictly rejects add_menu with malformed quickClose in proposal', () => {
      const badMenuProposal = {
        ...makeBasicMenu('Bad Menu'),
        quickClose: {
          enabled: 'invalid-boolean',
          bindings: DEFAULT_QUICK_CLOSE_BINDINGS,
        },
      };

      expect(() =>
        buildProposal(
          'Add bad menu',
          [{ op: 'add_menu', menu_definition: badMenuProposal }],
          [],
          dummySettings
        )
      ).to.throw(/menu_definition.quickClose is invalid/);
    });

    it('rejects modifying quickClose in update_menu', () => {
      const existing = makeBasicMenu('Existing');
      expect(() =>
        buildProposal(
          'Attempt update quickClose',
          [
            {
              op: 'update_menu',
              menu: 0,
              changes: {
                quickClose: { enabled: true, bindings: DEFAULT_QUICK_CLOSE_BINDINGS },
              },
            },
          ],
          [existing],
          dummySettings
        )
      ).to.throw(/"quickClose" is not a menu field/);
    });

    it('rejects deleting quickClose with null in update_menu', () => {
      const existing = makeBasicMenu('Existing');
      expect(() =>
        buildProposal(
          'Attempt delete quickClose',
          [
            {
              op: 'update_menu',
              menu: 0,
              changes: { quickClose: null },
            },
          ],
          [existing],
          dummySettings
        )
      ).to.throw(/"quickClose" is not a menu field/);
    });

    it('preserves existing quickClose on unrelated assistant edit', () => {
      const customConfig: QuickCloseConfig = {
        enabled: true,
        bindings: {
          quit: { ctrl: false, meta: true, alt: false, shift: true },
          closeWindow: { ctrl: true, meta: false, alt: false, shift: false },
          closeTab: { ctrl: false, meta: false, alt: true, shift: false },
          hide: { ctrl: false, meta: true, alt: true, shift: false },
        },
      };
      const existing = {
        ...makeBasicMenu('Existing Menu'),
        quickClose: customConfig,
      };

      const proposal = buildProposal(
        'Update shortcut',
        [
          {
            op: 'update_menu',
            menu: 0,
            changes: { shortcut: 'Control+Alt+Space' },
          },
        ],
        [existing],
        dummySettings
      );

      expect(proposal.menusAfter[0].shortcut).to.equal('Control+Alt+Space');
      expect(proposal.menusAfter[0].quickClose).to.deep.equal(customConfig);
    });
  });

  describe('Shipped example menus', () => {
    it('validates macos.json, linux.json and windows.json have explicit disabled Quick close', () => {
      const exampleDir = path.join(__dirname, '../src/main/example-menus');
      const files = ['macos.json', 'linux.json', 'windows.json'];

      for (const file of files) {
        const fullPath = path.join(exampleDir, file);
        const content = fs.readJSONSync(fullPath);
        const parsed = MENU_SCHEMA_V2.parse(content);
        expect(parsed.quickClose).to.not.be.undefined;
        expect(parsed.quickClose?.enabled).to.be.false;
        expect(parsed.quickClose?.bindings).to.deep.equal(DEFAULT_QUICK_CLOSE_BINDINGS);
      }
    });
  });
});
