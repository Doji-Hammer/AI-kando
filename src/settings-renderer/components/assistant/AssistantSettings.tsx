//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import React from 'react';

import { WindowWithAPIs } from '../../settings-window-api';
declare const window: WindowWithAPIs;

import type { AssistantApiStyle } from '../../../common/assistant-types';
import { useAssistant } from '../../state';

import * as classes from './AssistantSettings.module.scss';

/** Common endpoints, to save typing. Any OpenAI-compatible URL works. */
const PRESETS: { label: string; endpoint: string; apiStyle: AssistantApiStyle | '' }[] = [
  { label: 'Anthropic', endpoint: 'https://api.anthropic.com/v1', apiStyle: 'anthropic' },
  { label: 'OpenAI', endpoint: 'https://api.openai.com/v1', apiStyle: 'openai' },
  { label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', apiStyle: 'openai' },
  { label: 'Ollama (local)', endpoint: 'http://localhost:11434/v1', apiStyle: 'openai' },
  {
    label: 'LM Studio (local)',
    endpoint: 'http://localhost:1234/v1',
    apiStyle: 'openai',
  },
  {
    label: 'Custom endpoint',
    endpoint: '',
    apiStyle: '',
  },
];

const guessStyle = (endpoint: string): AssistantApiStyle => {
  try {
    return new URL(endpoint).hostname.endsWith('anthropic.com') ? 'anthropic' : 'openai';
  } catch {
    return 'openai';
  }
};

/**
 * Settings › Assistant: endpoint, API format, key and model. The key is sent to the main
 * process once and stored there encrypted; this page only learns whether one is saved.
 */
export default function AssistantSettings() {
  const config = useAssistant((s) => s.config);
  const setConfig = useAssistant((s) => s.setConfig);

  const [selectedProvider, setSelectedProvider] =
    React.useState<string>('Custom endpoint');
  const [endpoint, setEndpoint] = React.useState('');
  const [apiStyle, setApiStyle] = React.useState<AssistantApiStyle | ''>('openai');
  const [key, setKey] = React.useState('');
  const [models, setModels] = React.useState<string[]>([]);
  const [model, setModel] = React.useState('');
  const [status, setStatus] = React.useState<{ text: string; isError?: boolean } | null>(
    null
  );
  const [isLoading, setIsLoading] = React.useState(false);

  React.useEffect(() => {
    window.settingsAPI.assistantGetConfig().then((c) => {
      setConfig(c);
      setEndpoint(c.endpoint);
      setApiStyle(c.apiStyle);
      setModel(c.model);
      if (c.model) {
        setModels([c.model]);
      }
      const matched = PRESETS.find(
        (p) =>
          p.label !== 'Custom endpoint' &&
          p.endpoint === c.endpoint &&
          p.apiStyle === c.apiStyle
      );
      setSelectedProvider(matched ? matched.label : 'Custom endpoint');
    });
  }, [setConfig]);

  const loadModels = async () => {
    if (!apiStyle) {
      return;
    }
    const trimmed = endpoint.trim();
    if (!trimmed) {
      return;
    }
    setIsLoading(true);
    setStatus(null);
    const result = await window.settingsAPI.assistantListModels(trimmed, apiStyle, key);
    setIsLoading(false);
    if (result.error) {
      setStatus({ text: result.error, isError: true });
      return;
    }
    const list = result.models ?? [];
    setModels(list);
    if (!list.includes(model)) {
      setModel(list[0] ?? '');
    }
    setStatus({ text: `${list.length} models found.` });
  };

  const save = async () => {
    if (!apiStyle) {
      return;
    }
    const trimmed = endpoint.trim();
    if (!trimmed) {
      return;
    }
    let c = await window.settingsAPI.assistantSetConfig(trimmed, apiStyle, model);
    if (key) {
      c = await window.settingsAPI.assistantSetKey(key);
      setKey('');
    }
    setConfig(c);
    const matched = PRESETS.find(
      (p) =>
        p.label !== 'Custom endpoint' &&
        p.endpoint === c.endpoint &&
        p.apiStyle === c.apiStyle
    );
    setSelectedProvider(matched ? matched.label : 'Custom endpoint');
    setStatus({ text: 'Saved.' });
  };

  const clearKey = async () => {
    setConfig(await window.settingsAPI.assistantSetKey(''));
    setStatus({ text: 'API key removed.' });
  };

  const isDirty =
    !config ||
    endpoint.trim() !== config.endpoint ||
    apiStyle !== config.apiStyle ||
    model !== config.model ||
    key !== '';

  return (
    <div className={classes.page}>
      <p className={classes.intro}>
        The assistant works with any provider that offers an OpenAI-compatible API or
        Anthropic&apos;s API. It sends your menu configuration and your messages to that
        provider.
      </p>

      <div className={classes.presets}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className={`${classes.preset} ${selectedProvider === p.label ? classes.active : ''}`}
            type="button"
            onClick={() => {
              setSelectedProvider(p.label);
              setEndpoint(p.endpoint);
              setApiStyle(p.apiStyle);
              setModels([]);
              setModel('');
            }}>
            {p.label}
          </button>
        ))}
      </div>

      <label className={classes.field}>
        <span>Endpoint URL</span>
        <input
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          type="url"
          value={endpoint}
          onChange={(e) => {
            const val = e.target.value;
            setEndpoint(val);
            if (selectedProvider !== 'Custom endpoint') {
              setApiStyle(guessStyle(val));
            }
          }}
        />
      </label>

      <label className={classes.field}>
        <span>API format</span>
        <select
          value={apiStyle}
          onChange={(e) => setApiStyle(e.target.value as AssistantApiStyle)}>
          <option disabled value="">
            Choose a format…
          </option>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>

      <label className={classes.field}>
        <span>API key</span>
        <input
          autoComplete="off"
          placeholder={
            config?.hasApiKey ? 'Saved. Type a new key to replace it.' : 'Paste your key'
          }
          spellCheck={false}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <div className={classes.keyNote}>
        {config && !config.canStoreKeySecurely
          ? 'This Mac cannot encrypt the key, so it is kept only until Kando quits.'
          : 'Stored encrypted with the macOS Keychain. Local servers usually need no key.'}
        {config?.hasApiKey ? (
          <button className={classes.link} type="button" onClick={clearKey}>
            Remove key
          </button>
        ) : null}
      </div>

      <div className={classes.field}>
        <span>Model</span>
        <div className={classes.modelRow}>
          <select
            aria-label="Model"
            disabled={models.length === 0}
            value={model}
            onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 ? <option value="">Load the list first</option> : null}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className={classes.secondary}
            disabled={!endpoint.trim() || !apiStyle || isLoading}
            type="button"
            onClick={loadModels}>
            {isLoading ? 'Loading…' : 'Load models'}
          </button>
        </div>
      </div>

      <div className={classes.footer}>
        <span
          aria-live="polite"
          className={status?.isError ? classes.error : classes.status}>
          {status?.text}
        </span>
        <button
          className={classes.primary}
          disabled={!isDirty || !endpoint.trim() || !apiStyle || !model}
          type="button"
          onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
