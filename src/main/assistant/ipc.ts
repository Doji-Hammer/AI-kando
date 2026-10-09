//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import fs from 'fs';
import path from 'path';
import { ipcMain, safeStorage } from 'electron';

import { getConfigDirectory } from '../settings';
import type {
  AssistantApiStyle,
  AssistantConfig,
  AssistantReply,
  AssistantRequest,
} from '../../common/assistant-types';
import { detectApiStyle, listModels, ProviderConfig, ProviderError } from './providers';
import { runAssistant } from './agent';

/**
 * Stores the assistant setup and answers the settings window. The endpoint and model live
 * in assistant.json; the API key is encrypted with Electron's safeStorage (backed by the
 * macOS Keychain) in assistant-key.bin, and it never leaves the main process.
 */

type StoredConfig = { endpoint: string; apiStyle: AssistantApiStyle; model: string };

const DEFAULTS: StoredConfig = { endpoint: '', apiStyle: 'openai', model: '' };

const configFile = () => path.join(getConfigDirectory(), 'assistant.json');
const keyFile = () => path.join(getConfigDirectory(), 'assistant-key.bin');

function readConfig(): StoredConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return {
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
      apiStyle: raw.apiStyle === 'anthropic' ? 'anthropic' : 'openai',
      model: typeof raw.model === 'string' ? raw.model : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(config: StoredConfig) {
  fs.mkdirSync(getConfigDirectory(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

/** If the OS can't encrypt, the key is kept in memory for this session only. */
let sessionOnlyKey = '';

function readKey(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return sessionOnlyKey;
  }
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return '';
  }
}

function writeKey(key: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    sessionOnlyKey = key;
    return;
  }
  if (!key) {
    fs.rmSync(keyFile(), { force: true });
    return;
  }
  fs.mkdirSync(getConfigDirectory(), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
}

function publicConfig(): AssistantConfig {
  const c = readConfig();
  return {
    ...c,
    hasApiKey: readKey().length > 0,
    canStoreKeySecurely: safeStorage.isEncryptionAvailable(),
  };
}

function providerConfig(): ProviderConfig {
  const c = readConfig();
  return {
    endpoint: c.endpoint,
    apiStyle: c.apiStyle,
    model: c.model,
    apiKey: readKey(),
  };
}

const isString = (v: unknown): v is string => typeof v === 'string';

export function registerAssistantIpc() {
  ipcMain.handle('settings-window.assistant-get-config', () => publicConfig());

  ipcMain.handle(
    'settings-window.assistant-set-config',
    (_e, endpoint: unknown, apiStyle: unknown, model: unknown) => {
      const current = readConfig();
      const next: StoredConfig = {
        endpoint: isString(endpoint) ? endpoint.trim() : current.endpoint,
        apiStyle:
          apiStyle === 'anthropic' || apiStyle === 'openai'
            ? apiStyle
            : isString(endpoint)
              ? detectApiStyle(endpoint)
              : current.apiStyle,
        model: isString(model) ? model : current.model,
      };
      writeConfig(next);
      return publicConfig();
    }
  );

  ipcMain.handle('settings-window.assistant-set-key', (_e, key: unknown) => {
    writeKey(isString(key) ? key.trim() : '');
    return publicConfig();
  });

  // Lists models using the saved setup, optionally overridden by unsaved form values so
  // the user can test before saving. A key typed into the form is used once, not stored.
  ipcMain.handle(
    'settings-window.assistant-list-models',
    async (_e, endpoint: unknown, apiStyle: unknown, key: unknown) => {
      const saved = providerConfig();
      const ep = isString(endpoint) && endpoint ? endpoint : saved.endpoint;
      if (!ep) {
        return { error: 'Enter an endpoint URL first.' };
      }
      try {
        const models = await listModels({
          endpoint: ep,
          apiStyle:
            apiStyle === 'anthropic' || apiStyle === 'openai' ? apiStyle : saved.apiStyle,
          apiKey: isString(key) && key ? key : saved.apiKey,
        });
        return { models };
      } catch (e) {
        return { error: e instanceof ProviderError ? e.message : String(e) };
      }
    }
  );

  ipcMain.handle(
    'settings-window.assistant-send',
    async (_e, request: AssistantRequest): Promise<AssistantReply> => {
      const config = providerConfig();
      if (!config.endpoint || !config.model) {
        return {
          text: 'The assistant is not set up yet. Open Settings › Assistant, enter an endpoint and key, and pick a model.',
          error: true,
        };
      }
      if (!request || !Array.isArray(request.history) || !Array.isArray(request.menus)) {
        return { text: 'Invalid request.', error: true };
      }
      return runAssistant(config, request);
    }
  );
}
