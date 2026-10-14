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
      apiStyle:
        raw.apiStyle === 'anthropic' || raw.apiStyle === 'openai'
          ? raw.apiStyle
          : typeof raw.endpoint === 'string' && raw.endpoint
            ? detectApiStyle(raw.endpoint)
            : 'openai',
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

export function handleAssistantSetConfig(
  deps: {
    readConfig: () => StoredConfig;
    writeConfig: (config: StoredConfig) => void;
    publicConfig: () => AssistantConfig;
  },
  endpoint: unknown,
  apiStyle: unknown,
  model: unknown
): AssistantConfig {
  if (apiStyle !== 'anthropic' && apiStyle !== 'openai') {
    throw new Error('API format must be either "openai" or "anthropic".');
  }
  const current = deps.readConfig();
  const next: StoredConfig = {
    endpoint: isString(endpoint) ? endpoint.trim() : current.endpoint,
    apiStyle,
    model: isString(model) ? model : current.model,
  };
  deps.writeConfig(next);
  return deps.publicConfig();
}

export async function handleAssistantListModels(
  deps: {
    providerConfig: () => ProviderConfig;
    listModels: (config: ProviderConfig) => Promise<string[]>;
  },
  endpoint: unknown,
  apiStyle: unknown,
  key: unknown
): Promise<{ models?: string[]; error?: string }> {
  const saved = deps.providerConfig();
  const ep = isString(endpoint) && endpoint.trim() ? endpoint.trim() : saved.endpoint;
  if (!ep) {
    return { error: 'Enter an endpoint URL first.' };
  }
  if (apiStyle !== 'anthropic' && apiStyle !== 'openai') {
    return { error: 'Choose an API format first.' };
  }
  try {
    const models = await deps.listModels({
      endpoint: ep,
      apiStyle,
      apiKey: isString(key) && key ? key : saved.apiKey,
    });
    return { models };
  } catch (e) {
    return { error: e instanceof ProviderError ? e.message : String(e) };
  }
}

export function registerAssistantIpc() {
  ipcMain.handle('settings-window.assistant-get-config', () => publicConfig());

  ipcMain.handle(
    'settings-window.assistant-set-config',
    (_e, endpoint: unknown, apiStyle: unknown, model: unknown) =>
      handleAssistantSetConfig(
        { readConfig, writeConfig, publicConfig },
        endpoint,
        apiStyle,
        model
      )
  );

  ipcMain.handle('settings-window.assistant-set-key', (_e, key: unknown) => {
    writeKey(isString(key) ? key.trim() : '');
    return publicConfig();
  });

  // Lists models using the saved setup, optionally overridden by unsaved form values so
  // the user can test before saving. A key typed into the form is used once, not stored.
  ipcMain.handle(
    'settings-window.assistant-list-models',
    (_e, endpoint: unknown, apiStyle: unknown, key: unknown) =>
      handleAssistantListModels({ providerConfig, listModels }, endpoint, apiStyle, key)
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
