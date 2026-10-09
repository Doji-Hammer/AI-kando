//////////////////////////////////////////////////////////////////////////////////////////
//   _  _ ____ _  _ ___  ____                                                           //
//   |_/  |__| |\ | |  \ |  |    This file belongs to Kando, the cross-platform         //
//   | \_ |  | | \| |__/ |__|    pie menu. Read more on github.com/kando-menu/kando     //
//                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/naming-convention -- provider wire formats and tool arguments use snake_case. */

/**
 * Provider-agnostic access to chat models. Two wire formats cover almost every provider:
 *
 * - "openai": the OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, Ollama, LM
 *   Studio, Groq, Together, Mistral, vLLM, and many more).
 * - "anthropic": Anthropic's Messages API.
 *
 * Only `fetch` is used, so no provider SDK is needed. Nothing here imports Electron,
 * which keeps it testable with plain Node.
 */

export type ApiStyle = 'openai' | 'anthropic';

export type ProviderConfig = {
  /** Base URL, e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1". */
  endpoint: string;
  apiKey: string;
  apiStyle: ApiStyle;
  model?: string;
};

/** A tool the model may call. `parameters` is a JSON Schema object. */
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  /** Parsed JSON arguments. Unparseable arguments arrive as `{ _raw: string }`. */
  arguments: Record<string, unknown>;
};

/** Provider-neutral conversation messages. */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type ChatRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
};

export type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
};

/** An error with a message that is safe and useful to show to the user. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
  }
}

/**
 * Guess the wire format from the endpoint. Anthropic's own host uses the Messages API;
 * everything else is treated as OpenAI-compatible.
 */
export function detectApiStyle(endpoint: string): ApiStyle {
  try {
    return new URL(endpoint).hostname.endsWith('anthropic.com') ? 'anthropic' : 'openai';
  } catch {
    return 'openai';
  }
}

/** Normalises a base URL: no trailing slash, and "/v1" added for Anthropic if missing. */
export function normaliseEndpoint(endpoint: string, apiStyle: ApiStyle): string {
  let url = endpoint.trim().replace(/\/+$/, '');
  if (apiStyle === 'anthropic' && !/\/v1$/.test(url)) {
    url += '/v1';
  }
  return url;
}

function headers(config: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiStyle === 'anthropic') {
    h['x-api-key'] = config.apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else if (config.apiKey) {
    // Local servers such as Ollama accept requests without a key.
    h['authorization'] = 'Bearer ' + config.apiKey;
  }
  return h;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Separated so tests can inject a fake. */
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
export function setFetchForTesting(f: FetchLike) {
  fetchImpl = f;
}

async function request(
  config: ProviderConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<unknown> {
  const url = normaliseEndpoint(config.endpoint, config.apiStyle) + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: headers(config),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new ProviderError(
        `The provider did not answer within ${timeoutMs / 1000} s.`
      );
    }
    throw new ProviderError(`Could not reach ${url}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text);
      detail = body?.error?.message ?? body?.message ?? detail;
    } catch {
      // Not JSON; keep the raw text.
    }
    const hint =
      response.status === 401 || response.status === 403
        ? ' Check the API key.'
        : response.status === 404
          ? ' Check the endpoint URL and the API format.'
          : '';
    throw new ProviderError(`${response.status}: ${detail}.${hint}`, response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('The provider returned something that is not JSON.');
  }
}

/** Returns the model IDs the endpoint offers, sorted. */
export async function listModels(config: ProviderConfig): Promise<string[]> {
  const body = (await request(config, '/models', { method: 'GET' }, 15000)) as {
    data?: { id?: string }[];
    models?: { name?: string; model?: string }[];
  };
  // OpenAI and Anthropic both answer { data: [{ id }] }. Ollama's native route uses
  // { models: [{ name }] }, accepted too in case someone points at it.
  const ids = [
    ...(body.data ?? []).map((m) => m.id),
    ...(body.models ?? []).map((m) => m.name ?? m.model),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) {
    throw new ProviderError('The endpoint answered, but listed no models.');
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : { _raw: raw };
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}

/** Sends one turn and returns the model's text and tool calls. */
export async function chat(
  config: ProviderConfig,
  req: ChatRequest
): Promise<ChatResponse> {
  if (!config.model) {
    throw new ProviderError('No model selected. Choose one in Settings › Assistant.');
  }
  return config.apiStyle === 'anthropic'
    ? chatAnthropic(config, req)
    : chatOpenAI(config, req);
}

async function chatOpenAI(
  config: ProviderConfig,
  req: ChatRequest
): Promise<ChatResponse> {
  const messages: unknown[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  const body = (await request(
    config,
    '/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: req.maxTokens ?? 4096,
        tools: req.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
      }),
    },
    120000
  )) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
      };
    }[];
  };

  const message = body.choices?.[0]?.message;
  if (!message) {
    throw new ProviderError('The provider returned no answer.');
  }
  return {
    text: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? 'call_' + i,
      name: c.function?.name ?? '',
      arguments: parseArguments(c.function?.arguments),
    })),
  };
}

async function chatAnthropic(
  config: ProviderConfig,
  req: ChatRequest
): Promise<ChatResponse> {
  // Anthropic wants tool results as user turns and consecutive same-role turns merged.
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      messages.push({ role, content: [block] });
    }
  };
  for (const m of req.messages) {
    if (m.role === 'tool') {
      push('user', {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      });
    } else if (m.role === 'assistant') {
      if (m.content) {
        push('assistant', { type: 'text', text: m.content });
      }
      for (const c of m.toolCalls ?? []) {
        push('assistant', {
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: c.arguments,
        });
      }
    } else {
      push('user', { type: 'text', text: m.content });
    }
  }

  const body = (await request(
    config,
    '/messages',
    {
      method: 'POST',
      body: JSON.stringify({
        model: config.model,
        system: req.system,
        messages,
        max_tokens: req.maxTokens ?? 4096,
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }),
    },
    120000
  )) as {
    content?: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }[];
  };

  const blocks = body.content ?? [];
  return {
    text: blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    toolCalls: blocks
      .filter((b) => b.type === 'tool_use')
      .map((b, i) => ({
        id: b.id ?? 'toolu_' + i,
        name: b.name ?? '',
        arguments: parseArguments(b.input),
      })),
  };
}
