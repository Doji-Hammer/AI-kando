//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

import type { GeneralSettings, Menu } from '../../common/settings-schemata';
import type {
  AssistantMessage,
  AssistantReply,
  AssistantRequest,
} from '../../common/assistant-types';
import {
  chat,
  ChatMessage,
  ProviderConfig,
  ProviderError,
  ToolDefinition,
} from './providers';
import { buildProposal, Operation, OperationError } from './operations';

/** How many times the model may retry after its proposal failed validation. */
const MAX_ROUNDS = 4;

/** Settings that are noise for the model (large colour maps, internal bookkeeping). */
const HIDDEN_SETTINGS = new Set(['menuThemeColors', 'darkMenuThemeColors', 'version']);

type ItemLike = {
  type: string;
  name: string;
  icon: string;
  iconTheme: string;
  children?: ItemLike[];
  [workflow: string]: unknown;
};

const WORKFLOW_KEYS = [
  'selectWorkflow',
  'hoverWorkflow',
  'openWorkflow',
  'activateWorkflow',
];

/** One line per item: path, type, name, icon, then each workflow as compact JSON. */
export function describeMenus(menus: Menu[]): string {
  const lines: string[] = [];
  menus.forEach((menu, m) => {
    const extras = [
      menu.shortcut ? `shortcut ${menu.shortcut}` : 'no shortcut',
      menu.shortcutID ? `shortcutID ${menu.shortcutID}` : null,
      menu.tags?.length ? `tags ${JSON.stringify(menu.tags)}` : null,
      menu.conditions && Object.keys(menu.conditions).length
        ? `conditions ${JSON.stringify(menu.conditions)}`
        : null,
      menu.useFixedPosition ? `fixed at ${JSON.stringify(menu.fixedMenuPosition)}` : null,
      menu.anchored ? 'anchored' : null,
      menu.hoverMode ? 'hoverMode' : null,
    ].filter(Boolean);
    lines.push(`Menu ${m}: "${menu.root.name}" (${extras.join(', ')})`);
    const walk = (item: ItemLike, path: number[], depth: number) => {
      const flows = WORKFLOW_KEYS.filter((k) => item[k])
        .map((k) => `${k}=${JSON.stringify(item[k])}`)
        .join(' ');
      lines.push(
        `${'  '.repeat(depth + 1)}[${path.join(',')}] ${item.type} "${item.name}" icon=${item.icon}/${item.iconTheme}${flows ? ' ' + flows : ''}`
      );
      item.children?.forEach((c, i) => walk(c, [...path, i], depth + 1));
    };
    walk(menu.root as unknown as ItemLike, [], 0);
  });
  return lines.join('\n');
}

function describeSettings(settings: GeneralSettings): string {
  return Object.entries(settings)
    .filter(([k]) => !HIDDEN_SETTINGS.has(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n');
}

/** Turns chips into text the model can resolve unambiguously. */
export function renderMessage(message: AssistantMessage): string {
  return message.parts
    .map((p) => {
      if (typeof p === 'string') {
        return p;
      }
      if (p.trigger === '@' && p.menuIndex !== undefined) {
        return `@[${p.label}](menu ${p.menuIndex}, path [${(p.path ?? []).join(',')}])`;
      }
      return `${p.trigger}[${p.label}]${p.key ? `(${p.key})` : ''}`;
    })
    .join('');
}

export function buildSystemPrompt(req: AssistantRequest): string {
  return `You are the assistant inside the settings window of Kando, a pie menu for macOS. You help power users build and change their menus, and you answer questions about what Kando can do.

# How you change things
You never change anything directly. To change menus or settings, call propose_changes ONCE with every operation needed. The user sees your proposal drawn in the editor and accepts or rejects it. If the tool returns an error, fix the operations and call it again. If you only answer a question, reply in text and don't call the tool.
Keep replies short and plain: one to three sentences. No emoji. Don't repeat the change list; the user sees it.

# References
The user's message may contain references:
- @[Name](menu M, path [a,b]) is a menu or item; use exactly that menu index and path.
- /[Name](type) is an action type or workflow.
- #[Name](key) is a general setting key.

# Data model
A menu has a root item. Items are "button" or "submenu"; submenus and the root have "children". Every item has name, icon and iconTheme.
Paths are child indices from the root: [] is the root, [0] its first child, [0,2] the third child of that.
Workflows are { "quickSelectKey"?: string (one key, e.g. "F"), "actions": Action[] }:
- button: selectWorkflow (runs when the item is chosen), hoverWorkflow (runs when the pointer rests on it)
- submenu: openWorkflow (runs when it opens), hoverWorkflow, activateWorkflow
- root: activateWorkflow (runs on a click in the centre)
A button that does something normally ends its selectWorkflow with {"type":"close-menu"}.

Actions:
- {"type":"execute-command","command":string,"detached":true,"isolated":false} runs a shell command. On macOS open apps with: open -a "App Name"
- {"type":"open-uri","uri":string} opens a URL, file:// path or app URL scheme
- {"type":"open-file","path":string}
- {"type":"simulate-hotkey","hotkey":string} uses DOM key codes joined by "+", e.g. "MetaLeft+KeyC", "ControlLeft+AltLeft+ArrowRight"
- {"type":"execute-macro","macro":[{"type":"keyDown"|"keyUp","key":string,"delay":number}]}
- {"type":"set-clipboard","text":string}
- {"type":"open-menu","menu":string (menu name)}
- {"type":"focus-window","appName"?:string,"windowName"?:string}
- {"type":"send-websocket-message","url":string,"message":string}
- {"type":"delay","duration":number (ms)}
- {"type":"close-menu"}, {"type":"close-submenu"}, {"type":"open-settings"}, {"type":"inhibit-shortcuts"}

Icons: iconTheme "material-symbols-rounded" with a Material Symbols name (e.g. "public", "terminal", "draw", "music_note"); "simple-icons" for brand logos by slug (e.g. "figma", "firefox"); "emoji" with one emoji character.
Menu fields (update_menu): shortcut (Electron accelerator, e.g. "CommandOrControl+Space"), shortcutID, tags, useFixedPosition, fixedMenuPosition {x,y} 0..1, anchored, hoverMode, conditions {appName?: regex, windowName?: regex, screenArea?: {xMin,xMax,yMin,yMax}}.

# Current configuration
${describeMenus(req.menus as Menu[])}

The user has selected menu ${req.selectedMenu}, path [${req.selectedPath.join(',')}]. "This item" or "here" means that.

# General settings (key=value)
${describeSettings(req.settings)}`;
}

const OPERATION_DOC = `Operations are applied in order; each path refers to the state after the previous operations.
- {"op":"add_item","menu":number,"parent_path":number[],"index"?:number,"item":Item} (item is a full button or submenu, children included)
- {"op":"update_item","menu":number,"path":number[],"changes":{field: value}} (null removes a field; e.g. replace selectWorkflow)
- {"op":"remove_item","menu":number,"path":number[]}
- {"op":"update_menu","menu":number,"changes":{field: value}}
- {"op":"add_menu","menu_definition":Menu} (a complete menu with root)
- {"op":"remove_menu","menu":number}
- {"op":"update_settings","changes":{key: value}}`;

export const TOOLS: ToolDefinition[] = [
  {
    name: 'propose_changes',
    description:
      "Propose changes to the user's menus or settings. They are validated, then shown for the user to accept or reject. " +
      OPERATION_DOC,
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One sentence describing the change, shown above the change list.',
        },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'add_item',
                  'update_item',
                  'remove_item',
                  'update_menu',
                  'add_menu',
                  'remove_menu',
                  'update_settings',
                ],
              },
            },
            required: ['op'],
            additionalProperties: true,
          },
        },
      },
      required: ['summary', 'operations'],
    },
  },
];

/** Runs one user turn: may loop while the model fixes invalid proposals. */
export async function runAssistant(
  config: ProviderConfig,
  req: AssistantRequest
): Promise<AssistantReply> {
  const system = buildSystemPrompt(req);
  const messages: ChatMessage[] = req.history.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: renderMessage(m) }
      : { role: 'assistant', content: renderMessage(m) }
  );

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await chat(config, { system, messages, tools: TOOLS });
      const call = response.toolCalls.find((c) => c.name === 'propose_changes');
      if (!call) {
        return { text: response.text.trim() || 'I have no answer for that.' };
      }

      messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
      });
      try {
        const proposal = buildProposal(
          String(call.arguments.summary ?? ''),
          call.arguments.operations as Operation[],
          req.menus as Menu[],
          req.settings
        );
        return { text: response.text.trim() || proposal.summary, proposal };
      } catch (e) {
        if (!(e instanceof OperationError)) {
          throw e;
        }
        // Tell the model what went wrong and let it try again. Other tool calls in the
        // same turn get a short answer so the conversation stays well-formed.
        for (const c of response.toolCalls) {
          messages.push({
            role: 'tool',
            toolCallId: c.id,
            content:
              c === call
                ? `Error: ${e.message} Fix the operations and call propose_changes again.`
                : 'Ignored: only propose_changes is available.',
          });
        }
      }
    }
    return {
      text: 'I could not build a valid change after several tries. Try describing it in smaller steps.',
      error: true,
    };
  } catch (e) {
    if (e instanceof ProviderError) {
      return { text: e.message, error: true };
    }
    return { text: 'Something went wrong: ' + (e as Error).message, error: true };
  }
}
