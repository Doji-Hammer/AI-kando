//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/naming-convention -- provider wire formats and tool arguments use snake_case. */

import { expect } from 'chai';

import {
  GENERAL_SETTINGS_SCHEMA,
  MENU_SCHEMA,
  Menu,
} from '../src/common/settings-schemata';
import type { AssistantRequest } from '../src/common/assistant-types';
import { buildProposal, OperationError } from '../src/main/assistant/operations';
import {
  handleAssistantListModels,
  handleAssistantSetConfig,
} from '../src/main/assistant/ipc';
import {
  chat,
  detectApiStyle,
  listModels,
  setFetchForTesting,
} from '../src/main/assistant/providers';
import { describeMenus, renderMessage, runAssistant } from '../src/main/assistant/agent';

const menu = (): Menu =>
  MENU_SCHEMA.parse({
    shortcut: 'Control+Space',
    root: {
      type: 'root',
      name: 'Example',
      icon: 'star',
      iconTheme: 'material-symbols-rounded',
      children: [
        {
          type: 'submenu',
          name: 'Apps',
          icon: 'apps',
          iconTheme: 'material-symbols-rounded',
          children: [
            {
              type: 'button',
              name: 'Browser',
              icon: 'public',
              iconTheme: 'material-symbols-rounded',
              selectWorkflow: {
                actions: [{ type: 'execute-command', command: 'open -a Safari' }],
              },
            },
          ],
        },
      ],
    },
  }) as Menu;

const settings = () => GENERAL_SETTINGS_SCHEMA.parse({});

const figma = {
  type: 'button',
  name: 'Figma',
  icon: 'draw',
  iconTheme: 'material-symbols-rounded',
  selectWorkflow: {
    quickSelectKey: 'F',
    actions: [
      { type: 'execute-command', command: 'open -a Figma' },
      { type: 'close-menu' },
    ],
  },
};

/** A fake fetch that answers from a queue and records requests. */
function fakeFetch(answers: { status?: number; body: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  setFetchForTesting(async (url, init) => {
    calls.push({ url, init });
    const a = answers.shift() ?? {
      status: 500,
      body: { error: { message: 'no answer queued' } },
    };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  });
  return calls;
}

describe('assistant: buildProposal', () => {
  it('adds an item, fills schema defaults and marks it', () => {
    const before = [menu()];
    const p = buildProposal(
      'Add Figma',
      [{ op: 'add_item', menu: 0, parent_path: [0], item: figma }],
      before,
      settings()
    );
    const added = (
      p.menusAfter[0].root.children[0] as {
        children: {
          name: string;
          selectWorkflow: { actions: { detached?: boolean }[] };
        }[];
      }
    ).children[1];
    expect(added.name).to.equal('Figma');
    expect(added.selectWorkflow.actions[0].detached).to.equal(true); // default filled in
    expect(p.markers).to.deep.equal([{ menuIndex: 0, path: [0, 1], kind: 'add' }]);
    expect(p.changes[0].text).to.equal('Add “Figma” to Example › Apps');
    // The input is never modified.
    expect(
      (before[0].root.children[0] as { children: unknown[] }).children
    ).to.have.length(1);
  });

  it('applies operations in order, so later paths see earlier changes', () => {
    const p = buildProposal(
      'Two',
      [
        { op: 'add_item', menu: 0, parent_path: [0], index: 0, item: figma },
        { op: 'update_item', menu: 0, path: [0, 1], changes: { name: 'Safari' } },
      ],
      [menu()],
      settings()
    );
    const apps = p.menusAfter[0].root.children[0] as { children: { name: string }[] };
    expect(apps.children.map((c) => c.name)).to.deep.equal(['Figma', 'Safari']);
    expect(p.markers.map((m) => m.kind)).to.deep.equal(['add', 'change']);
  });

  it('rejects an invalid item with a message the model can act on', () => {
    expect(() =>
      buildProposal(
        'Bad',
        [
          {
            op: 'add_item',
            menu: 0,
            parent_path: [0],
            item: { type: 'button', name: 'X' },
          },
        ],
        [menu()],
        settings()
      )
    ).to.throw(OperationError, /item is invalid: icon: .*iconTheme/);
  });

  it('rejects paths that do not exist', () => {
    expect(() =>
      buildProposal(
        'Bad',
        [{ op: 'remove_item', menu: 0, path: [3, 1] }],
        [menu()],
        settings()
      )
    ).to.throw(OperationError, /Path \[3, 1\] does not exist/);
  });

  it('refuses protected settings and unknown keys', () => {
    expect(() =>
      buildProposal(
        'x',
        [{ op: 'update_settings', changes: { hardwareAcceleration: false } }],
        [menu()],
        settings()
      )
    ).to.throw(/only be changed by the user/);
    expect(() =>
      buildProposal(
        'x',
        [{ op: 'update_settings', changes: { notASetting: 1 } }],
        [menu()],
        settings()
      )
    ).to.throw(/not a Kando setting/);
  });

  it('validates setting values', () => {
    const ok = buildProposal(
      'Turbo',
      [{ op: 'update_settings', changes: { enableTurboMode: false } }],
      [menu()],
      settings()
    );
    expect(ok.settingsChanges).to.deep.equal({ enableTurboMode: false });
    expect(() =>
      buildProposal(
        'x',
        [{ op: 'update_settings', changes: { enableTurboMode: 'yes' } }],
        [menu()],
        settings()
      )
    ).to.throw(/Invalid settings/);
  });

  it('only lets update_menu touch menu fields', () => {
    const p = buildProposal(
      'Cond',
      [{ op: 'update_menu', menu: 0, changes: { conditions: { appName: 'Figma' } } }],
      [menu()],
      settings()
    );
    expect(p.menusAfter[0].conditions).to.deep.equal({ appName: 'Figma' });
    expect(() =>
      buildProposal(
        'x',
        [{ op: 'update_menu', menu: 0, changes: { root: {} } }],
        [menu()],
        settings()
      )
    ).to.throw(/not a menu field/);
  });
});

describe('assistant: prompt material', () => {
  it('describes menus with paths and workflows', () => {
    const text = describeMenus([menu()]);
    expect(text).to.contain('Menu 0: "Example" (shortcut Control+Space)');
    expect(text).to.contain('[0,0] button "Browser"');
    expect(text).to.contain('"command":"open -a Safari"');
  });

  it('renders reference chips unambiguously', () => {
    expect(
      renderMessage({
        role: 'user',
        parts: [
          'Add to ',
          { trigger: '@', label: 'Example › Apps', menuIndex: 0, path: [0] },
          ' using ',
          { trigger: '/', label: 'Execute Command', key: 'execute-command' },
        ],
      })
    ).to.equal(
      'Add to @[Example › Apps](menu 0, path [0]) using /[Execute Command](execute-command)'
    );
  });
});

describe('assistant: providers', () => {
  after(() => setFetchForTesting((url, init) => fetch(url, init)));

  it('detects the API format from the endpoint', () => {
    expect(detectApiStyle('https://api.anthropic.com/v1')).to.equal('anthropic');
    expect(detectApiStyle('http://localhost:11434/v1')).to.equal('openai');
    expect(detectApiStyle('not a url')).to.equal('openai');
  });

  it('lists models from OpenAI-style and Ollama-style answers', async () => {
    const calls = fakeFetch([
      { body: { data: [{ id: 'b-model' }, { id: 'a-model' }] } },
      { body: { models: [{ name: 'llama3.1' }] } },
    ]);
    expect(
      await listModels({
        endpoint: 'https://x.test/v1/',
        apiKey: 'k',
        apiStyle: 'openai',
      })
    ).to.deep.equal(['a-model', 'b-model']);
    expect(calls[0].url).to.equal('https://x.test/v1/models');
    expect((calls[0].init!.headers as Record<string, string>).authorization).to.equal(
      'Bearer k'
    );
    expect(
      await listModels({
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        apiStyle: 'openai',
      })
    ).to.deep.equal(['llama3.1']);
  });

  it('sends Anthropic headers and adds /v1', async () => {
    const calls = fakeFetch([{ body: { data: [{ id: 'claude-x' }] } }]);
    await listModels({
      endpoint: 'https://api.anthropic.com',
      apiKey: 'sk',
      apiStyle: 'anthropic',
    });
    expect(calls[0].url).to.equal('https://api.anthropic.com/v1/models');
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h['x-api-key']).to.equal('sk');
    expect(h['anthropic-version']).to.equal('2023-06-01');
  });

  it('turns HTTP errors into readable messages', async () => {
    fakeFetch([{ status: 401, body: { error: { message: 'invalid x-api-key' } } }]);
    let message = '';
    try {
      await listModels({
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'bad',
        apiStyle: 'anthropic',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.equal('401: invalid x-api-key. Check the API key.');
  });

  it('parses OpenAI tool calls and maps tool results', async () => {
    const calls = fakeFetch([
      {
        body: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    function: {
                      name: 'propose_changes',
                      arguments: '{"summary":"s","operations":[]}',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const r = await chat(
      { endpoint: 'https://x.test/v1', apiKey: 'k', apiStyle: 'openai', model: 'm' },
      {
        system: 'sys',
        tools: [],
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c0', name: 'propose_changes', arguments: {} }],
          },
          { role: 'tool', toolCallId: 'c0', content: 'Error' },
        ],
      }
    );
    expect(r.toolCalls[0]).to.deep.equal({
      id: 'c1',
      name: 'propose_changes',
      arguments: { summary: 's', operations: [] },
    });
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.messages[0]).to.deep.equal({ role: 'system', content: 'sys' });
    expect(sent.messages[3]).to.deep.equal({
      role: 'tool',
      tool_call_id: 'c0',
      content: 'Error',
    });
  });

  it('parses Anthropic tool use and merges tool results into a user turn', async () => {
    const calls = fakeFetch([
      {
        body: {
          content: [
            { type: 'text', text: 'Here.' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'propose_changes',
              input: { summary: 's' },
            },
          ],
        },
      },
    ]);
    const r = await chat(
      {
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'k',
        apiStyle: 'anthropic',
        model: 'm',
      },
      {
        system: 'sys',
        tools: [
          { name: 'propose_changes', description: 'd', parameters: { type: 'object' } },
        ],
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't0', name: 'propose_changes', arguments: {} }],
          },
          { role: 'tool', toolCallId: 't0', content: 'Error' },
        ],
      }
    );
    expect(r.text).to.equal('Here.');
    expect(r.toolCalls[0].arguments).to.deep.equal({ summary: 's' });
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.system).to.equal('sys');
    expect(sent.tools[0].input_schema).to.deep.equal({ type: 'object' });
    expect(sent.messages[2]).to.deep.equal({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't0', content: 'Error' }],
    });
  });
});

describe('assistant: runAssistant', () => {
  after(() => setFetchForTesting((url, init) => fetch(url, init)));

  const request = (): AssistantRequest => ({
    history: [
      {
        role: 'user',
        parts: [
          'Add Figma to ',
          { trigger: '@', label: 'Example › Apps', menuIndex: 0, path: [0] },
        ],
      },
    ],
    menus: [menu()],
    settings: settings(),
    selectedMenu: 0,
    selectedPath: [],
  });
  const config = {
    endpoint: 'https://x.test/v1',
    apiKey: 'k',
    apiStyle: 'openai' as const,
    model: 'm',
  };
  const toolAnswer = (args: unknown) => ({
    body: {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'c',
                function: { name: 'propose_changes', arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
  });

  it('feeds validation errors back and returns the corrected proposal', async () => {
    const calls = fakeFetch([
      toolAnswer({
        summary: 'Add',
        operations: [
          {
            op: 'add_item',
            menu: 0,
            parent_path: [0],
            item: { type: 'button', name: 'Figma' },
          },
        ],
      }),
      toolAnswer({
        summary: 'Add Figma',
        operations: [{ op: 'add_item', menu: 0, parent_path: [0], item: figma }],
      }),
    ]);
    const reply = await runAssistant(config, request());
    expect(reply.error).to.equal(undefined);
    expect(reply.proposal?.markers).to.deep.equal([
      { menuIndex: 0, path: [0, 1], kind: 'add' },
    ]);
    const second = JSON.parse(calls[1].init!.body as string);
    const last = second.messages[second.messages.length - 1];
    expect(last.role).to.equal('tool');
    expect(last.content).to.match(/^Error: .*icon.*call propose_changes again/);
    // The system prompt carries the real configuration and the reference syntax.
    expect(second.messages[0].content).to.contain('[0,0] button "Browser"');
    expect(second.messages[1].content).to.contain('@[Example › Apps](menu 0, path [0])');
  });

  it('returns plain answers without a proposal', async () => {
    fakeFetch([
      {
        body: {
          choices: [
            { message: { content: 'Hover runs on rest; select runs on choose.' } },
          ],
        },
      },
    ]);
    const reply = await runAssistant(config, request());
    expect(reply).to.deep.equal({ text: 'Hover runs on rest; select runs on choose.' });
  });

  it('gives up after repeated invalid proposals', async () => {
    const bad = toolAnswer({
      summary: 'x',
      operations: [{ op: 'remove_item', menu: 0, path: [9] }],
    });
    fakeFetch([bad, bad, bad, bad]);
    const reply = await runAssistant(config, request());
    expect(reply.error).to.equal(true);
    expect(reply.text).to.match(/could not build a valid change/);
  });

  it('reports provider errors as a readable reply', async () => {
    fakeFetch([{ status: 404, body: { error: { message: 'model not found' } } }]);
    const reply = await runAssistant(config, request());
    expect(reply).to.deep.equal({
      text: '404: model not found. Check the endpoint URL and the API format.',
      error: true,
    });
  });
});

describe('assistant: IPC handlers', () => {
  const baseConfig = {
    endpoint: 'https://api.example.com/v1',
    apiStyle: 'openai' as const,
    model: 'gpt-4o',
  };
  const publicConfig = {
    ...baseConfig,
    hasApiKey: true,
    canStoreKeySecurely: true,
  };

  describe('handleAssistantSetConfig', () => {
    it('rejects missing, empty, or unknown apiStyle instead of inferring', () => {
      let written = false;
      const deps = {
        readConfig: () => ({ ...baseConfig }),
        writeConfig: () => {
          written = true;
        },
        publicConfig: () => ({ ...publicConfig }),
      };

      expect(() =>
        handleAssistantSetConfig(deps, 'https://api.example.com/v1', undefined, 'm')
      ).to.throw(/API format/);
      expect(() =>
        handleAssistantSetConfig(deps, 'https://api.example.com/v1', '', 'm')
      ).to.throw(/API format/);
      expect(() =>
        handleAssistantSetConfig(deps, 'https://api.example.com/v1', 'custom', 'm')
      ).to.throw(/API format/);
      expect(written).to.equal(false);
    });

    it('saves and trims endpoint when apiStyle is valid', () => {
      let saved: unknown = null;
      const deps = {
        readConfig: () => ({ ...baseConfig }),
        writeConfig: (c: unknown) => {
          saved = c;
        },
        publicConfig: () => ({ ...publicConfig }),
      };

      handleAssistantSetConfig(
        deps,
        '  https://api.anthropic.com/v1  ',
        'anthropic',
        'claude-3'
      );
      expect(saved).to.deep.equal({
        endpoint: 'https://api.anthropic.com/v1',
        apiStyle: 'anthropic',
        model: 'claude-3',
      });
    });
  });

  describe('handleAssistantListModels', () => {
    it('rejects missing, empty, or unknown apiStyle with an explicit error', async () => {
      let called = false;
      const deps = {
        providerConfig: () => ({
          endpoint: 'https://api.example.com/v1',
          apiStyle: 'openai' as const,
          model: 'm',
          apiKey: 'key',
        }),
        listModels: async () => {
          called = true;
          return ['m1'];
        },
      };

      const resEmpty = await handleAssistantListModels(
        deps,
        'https://api.example.com/v1',
        '',
        'key'
      );
      expect(resEmpty).to.deep.equal({ error: 'Choose an API format first.' });

      const resUndefined = await handleAssistantListModels(
        deps,
        'https://api.example.com/v1',
        undefined,
        'key'
      );
      expect(resUndefined).to.deep.equal({ error: 'Choose an API format first.' });

      const resUnknown = await handleAssistantListModels(
        deps,
        'https://api.example.com/v1',
        'invalid',
        'key'
      );
      expect(resUnknown).to.deep.equal({ error: 'Choose an API format first.' });

      expect(called).to.equal(false);
    });

    it('calls listModels with trimmed endpoint when apiStyle is valid', async () => {
      let passedConfig: unknown = null;
      const deps = {
        providerConfig: () => ({
          endpoint: '',
          apiStyle: 'openai' as const,
          model: '',
          apiKey: '',
        }),
        listModels: async (cfg: unknown) => {
          passedConfig = cfg;
          return ['model-a'];
        },
      };

      const res = await handleAssistantListModels(
        deps,
        '  https://api.example.com/v1  ',
        'openai',
        'k'
      );
      expect(res).to.deep.equal({ models: ['model-a'] });
      expect(passedConfig).to.deep.equal({
        endpoint: 'https://api.example.com/v1',
        apiStyle: 'openai',
        apiKey: 'k',
      });
    });
  });
});
