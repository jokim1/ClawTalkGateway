/**
 * Anthropic Format Adapter
 *
 * Bidirectional translation between OpenAI chat completions format
 * and Anthropic Messages API format. Used by the direct provider
 * router to bypass OpenClaw for Anthropic models.
 *
 * Three entry points:
 *   - translateRequestToAnthropic()  — request body conversion
 *   - translateAnthropicStream()     — async generator for SSE stream
 *   - translateAnthropicResponse()   — non-streaming response JSON
 */

// ---------------------------------------------------------------------------
// Request translation: OpenAI → Anthropic
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }> | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAITool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: string; text: string }>;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  stream: boolean;
}

/**
 * Translate an OpenAI chat completions request body to Anthropic Messages API format.
 */
export function translateRequestToAnthropic(
  openaiBody: {
    messages: OpenAIMessage[];
    tools?: OpenAITool[];
    tool_choice?: string;
    stream?: boolean;
  },
  providerModelId: string,
  maxTokens: number,
): AnthropicRequest {
  let systemText = '';
  const rawMessages: Array<{ role: string; content: unknown }> = [];

  for (const msg of openaiBody.messages) {
    if (msg.role === 'system') {
      // Collect system messages into top-level system param
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) systemText += (systemText ? '\n\n' : '') + text;
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Assistant with tool calls → content blocks
      const content: Array<Record<string, unknown>> = [];
      const textContent = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (textContent) {
        content.push({ type: 'text', text: textContent });
      }
      for (const tc of msg.tool_calls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      rawMessages.push({ role: 'assistant', content });
      continue;
    }

    if (msg.role === 'tool') {
      // Tool result → user message with tool_result block
      rawMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content: typeof msg.content === 'string' ? msg.content : String(msg.content ?? ''),
        }],
      });
      continue;
    }

    if (msg.role === 'user') {
      // User message — wrap string in content block array
      if (typeof msg.content === 'string') {
        rawMessages.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        // Multimodal content — pass through with format adaptation
        const blocks = msg.content.map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text ?? '' };
          if (part.type === 'image_url') {
            const url = (part.image_url as Record<string, unknown>)?.url as string ?? '';
            const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
            if (dataMatch) {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: dataMatch[1],
                  data: dataMatch[2],
                },
              };
            }
            return { type: 'text', text: `[image: ${url}]` };
          }
          return { type: 'text', text: '[unsupported content]' };
        });
        rawMessages.push({ role: 'user', content: blocks });
      } else {
        rawMessages.push({ role: 'user', content: [{ type: 'text', text: String(msg.content ?? '') }] });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
      rawMessages.push({ role: 'assistant', content: [{ type: 'text', text }] });
      continue;
    }

    // Unknown role — skip
  }

  // Merge adjacent same-role messages (Anthropic requires strict alternation)
  const merged: Array<{ role: string; content: unknown }> = [];
  for (const msg of rawMessages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge content arrays
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content ?? '') }];
      const currContent = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }];
      prev.content = [...prevContent, ...currContent];
    } else {
      merged.push({ ...msg });
    }
  }

  // Translate tools
  const tools = openaiBody.tools?.map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: t.function.parameters ?? { type: 'object' as const, properties: {} },
  }));

  const request: AnthropicRequest = {
    model: providerModelId,
    max_tokens: maxTokens,
    messages: merged,
    stream: openaiBody.stream !== false,
  };

  if (systemText) {
    request.system = systemText;
  }
  if (tools && tools.length > 0) {
    request.tools = tools;
  }

  return request;
}

// ---------------------------------------------------------------------------
// Streaming translation: Anthropic SSE → OpenAI SSE lines
// ---------------------------------------------------------------------------

/**
 * Async generator that reads an Anthropic SSE stream and yields
 * OpenAI-format `data: {...}\n\n` lines that the existing tool-loop
 * SSE parser can consume directly.
 */
export async function* translateAnthropicStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentToolIndex = -1;
  let responseModel: string | undefined;
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      const eventType = event.type as string;

      if (eventType === 'message_start') {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.model) responseModel = message.model as string;
        const usage = message?.usage as Record<string, number> | undefined;
        if (usage?.input_tokens) promptTokens = usage.input_tokens;
      }

      if (eventType === 'content_block_start') {
        const contentBlock = event.content_block as Record<string, unknown> | undefined;
        if (contentBlock?.type === 'tool_use') {
          currentToolIndex++;
          const toolId = contentBlock.id as string ?? '';
          const toolName = contentBlock.name as string ?? '';
          yield formatOpenAIChunk({
            model: responseModel,
            delta: {
              tool_calls: [{
                index: currentToolIndex,
                id: toolId,
                type: 'function',
                function: { name: toolName, arguments: '' },
              }],
            },
          });
        }
      }

      if (eventType === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          yield formatOpenAIChunk({
            model: responseModel,
            delta: { content: delta.text as string },
          });
        }
        if (delta?.type === 'input_json_delta') {
          yield formatOpenAIChunk({
            model: responseModel,
            delta: {
              tool_calls: [{
                index: currentToolIndex,
                function: { arguments: delta.partial_json as string ?? '' },
              }],
            },
          });
        }
      }

      if (eventType === 'message_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        const usage = event.usage as Record<string, number> | undefined;
        if (usage?.output_tokens) completionTokens = usage.output_tokens;

        const stopReason = delta?.stop_reason as string | undefined;
        if (stopReason) {
          const finishReason = stopReason === 'tool_use' ? 'tool_calls'
            : stopReason === 'end_turn' ? 'stop'
            : stopReason === 'max_tokens' ? 'length'
            : 'stop';
          yield formatOpenAIChunk({
            model: responseModel,
            delta: {},
            finish_reason: finishReason,
            usage: promptTokens || completionTokens
              ? { prompt_tokens: promptTokens, completion_tokens: completionTokens }
              : undefined,
          });
        }
      }

      if (eventType === 'message_stop') {
        yield 'data: [DONE]\n\n';
      }
    }
  }
}

function formatOpenAIChunk(opts: {
  model?: string;
  delta: Record<string, unknown>;
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}): string {
  const chunk: Record<string, unknown> = {
    choices: [{
      delta: opts.delta,
      ...(opts.finish_reason ? { finish_reason: opts.finish_reason } : {}),
    }],
  };
  if (opts.model) chunk.model = opts.model;
  if (opts.usage) chunk.usage = opts.usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ---------------------------------------------------------------------------
// Non-streaming response translation: Anthropic → OpenAI
// ---------------------------------------------------------------------------

interface AnthropicResponseJson {
  id?: string;
  model?: string;
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Translate a non-streaming Anthropic Messages API response to
 * OpenAI chat completions format.
 */
export function translateAnthropicResponse(json: AnthropicResponseJson): {
  model?: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
} {
  const content = json.content ?? [];
  let textContent = '';
  const toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      textContent += block.text;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? '',
        type: 'function',
        function: {
          name: block.name ?? '',
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const stopReason = json.stop_reason;
  const finishReason = stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'end_turn' ? 'stop'
    : stopReason === 'max_tokens' ? 'length'
    : 'stop';

  return {
    model: json.model,
    choices: [{
      message: {
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    ...(json.usage ? {
      usage: {
        prompt_tokens: json.usage.input_tokens ?? 0,
        completion_tokens: json.usage.output_tokens ?? 0,
      },
    } : {}),
  };
}
