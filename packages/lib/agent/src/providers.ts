import type { ClientConfig, CompletionOptions, CompletionResult } from '@chatgpt-telegram-workers/ai';
import type { AppSettings, ChatProviderConfig, ImageProviderConfig } from '@chatgpt-telegram-workers/config';
import type { ChatAgent, ImageAgent } from './types';
import { createClient, createImageClient, findChatProtocol } from '@chatgpt-telegram-workers/ai';
import { consumeTextStream } from './stream';

const CHAT_MESSAGE_SYSTEM_PROMPT = [
    'You are chatting on Telegram. Return a JSON object of the form {"messages":["..."]}.',
    'Each string in messages is sent as one separate Telegram chat bubble, in order.',
    'Use one string when one message is enough. Use several strings when your reply naturally consists of separate thoughts, reactions, or chat lines.',
    'Do not mechanically split sentences and do not add filler just to make more bubbles.',
    'Do not mention this JSON format. Keep your configured persona, tone, and humor.',
].join(' ');

/** DeepSeek thinking 模式不支持强制 tool_choice，用 JSON 信封承载 1..N 个气泡。 */
const BUBBLE_RESPONSE_FORMAT = { type: 'json_object' } as const;

// The model chooses how many messages to send; this is only a hard safety cap.
const MAX_CHAT_MESSAGES_PER_TURN = 10;

/** 仅用于诊断：人设是否明确要求只发一条，避免和发送协议互相打架。 */
function personaMentionsSingleMessage(persona: string): boolean {
    return /(one message|single message|one reply|single reply|一条|单条|一句话)/i.test(persona);
}

export interface MessageActionDiagnostics {
    hasPersona?: boolean;
    personaMentionsSingleMessage?: boolean;
}

interface ParsedBubbles {
    texts: string[];
    invalidItems: number;
    /** JSON 解析成功且 messages 是数组（空数组也算有效）。 */
    valid: boolean;
}

export function parseBubbleEnvelope(text: string): ParsedBubbles {
    let normalized = text.trim();
    const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) {
        normalized = fenced[1].trim();
    }

    let data: unknown;
    try {
        data = JSON.parse(normalized);
    } catch {
        return { texts: [], invalidItems: 1, valid: false };
    }

    const list = (data as { messages?: unknown })?.messages;
    if (!Array.isArray(list)) {
        return { texts: [], invalidItems: 1, valid: false };
    }

    const texts: string[] = [];
    let invalidItems = 0;
    for (const item of list) {
        if (typeof item !== 'string') {
            invalidItems++;
            continue;
        }
        const value = item.trim();
        if (value) {
            texts.push(value);
        }
    }

    return { texts, invalidItems, valid: true };
}

/**
 * 一轮对话只请求一次模型，由模型把 1..N 条消息写进 JSON 的 messages 数组。
 * 约束的是输出信封，不是条数；没有任何机械拆分。
 */
export async function completeWithMessageActions(
    client: ReturnType<typeof createClient>,
    options: CompletionOptions,
    onMessage: (text: string) => Promise<unknown>,
    diagnostics: MessageActionDiagnostics = {},
): Promise<string> {
    const startedAt = Date.now();
    const messages = [...options.messages];
    const baseOptions: CompletionOptions = { ...options, messages };
    const jsonOptions: CompletionOptions = {
        ...baseOptions,
        extra: { ...(options.extra ?? {}), response_format: BUBBLE_RESPONSE_FORMAT },
    };

    let result: CompletionResult;
    let usedJsonMode = true;
    try {
        result = await client.complete(jsonOptions);
    } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
            throw error;
        }
        // 少数 chat-completions provider 不支持 response_format；退回普通请求，
        // 并把整段回复作为单条消息发送，至少不丢内容。
        console.warn('[chat-delivery] json_object response failed; retrying without response_format', {
            errorName: (error as Error)?.name,
        });
        usedJsonMode = false;
        result = await client.complete(baseOptions);
    }

    const rawText = result.text.trim();
    const parsed = parseBubbleEnvelope(rawText);
    const capHit = parsed.texts.length > MAX_CHAT_MESSAGES_PER_TURN;
    const sent: string[] = [];

    for (const message of parsed.texts.slice(0, MAX_CHAT_MESSAGES_PER_TURN)) {
        await onMessage(message);
        sent.push(message);
    }

    let path: 'json' | 'text_fallback' | 'empty' = sent.length > 0 ? 'json' : 'empty';
    // 解析失败（或 provider 不支持 JSON 模式）时，保留原始回复为单条气泡；
    // 解析成功但 messages 为空时不发送任何内容。
    if (sent.length === 0 && rawText && !parsed.valid) {
        await onMessage(rawText);
        sent.push(rawText);
        path = 'text_fallback';
    }

    console.info('[chat-delivery]', {
        ...diagnostics,
        model: options.model,
        path,
        format: usedJsonMode ? 'json_object' : 'text',
        requested: parsed.texts.length,
        delivered: sent.length,
        capHit,
        invalidItems: parsed.invalidItems,
        jsonParseFailed: !!rawText && !parsed.valid,
        hasReasoningContent: !!result.reasoningContent,
        finishReason: result.stopReason ?? null,
        durationMs: Date.now() - startedAt,
    });

    return sent.join('\n\n');
}

/** 走 HTTP 客户端的聊天协议(workers 有独立入口) */
export type HttpChatProtocol = 'chat-completions' | 'anthropic-messages' | 'responses';

/**
 * 按 `chatCompleteApiTimeout`(秒,<=0 表示不限)创建超时控制器。
 * 返回 clear,调用方在请求结束后必须清理,避免定时器泄漏。
 */
export function chatAbortSignal(settings: AppSettings): { signal?: AbortSignal; clear: () => void } {
    if (settings.chatCompleteApiTimeout <= 0) {
        return { clear: () => {} };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.chatCompleteApiTimeout * 1000);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** 从 provider.options 读取 API Key 的自定义请求头名(Azure 用 `api-key`) */
function apiKeyHeader(provider: ChatProviderConfig): string | undefined {
    const value = provider.options?.apiKeyHeader;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clientConfig(provider: ChatProviderConfig, settings: AppSettings): ClientConfig {
    return {
        baseUrl: provider.baseUrl || undefined,
        apiKey: provider.apiKey || undefined,
        apiKeyHeader: apiKeyHeader(provider),
        // 仅对同时支持 URL 与 base64 的协议生效;anthropic 恒内联、workers 恒剥离,由 ai 客户端按协议能力决定
        imageTransfer: settings.telegramImageTransferMode,
    };
}

/** 按协议与实例组装走 HTTP 的聊天 agent(workers 走 workersai.ts) */
export function createChatAgent(
    protocol: HttpChatProtocol,
    provider: ChatProviderConfig,
    settings: AppSettings,
): ChatAgent {
    const client = createClient(protocol, clientConfig(provider, settings));
    return {
        name: provider.id,
        label: provider.label || findChatProtocol(protocol)?.label || protocol,
        model: provider.model || provider.models[0] || '',
        modelList: async () => provider.models,
        chat: async (messages, onStream, onMessage) => {
            const extra = provider.extraParams ?? {};
            const { signal, clear } = chatAbortSignal(settings);
            const options: CompletionOptions = {
                model: provider.model,
                system:
                    protocol === 'chat-completions'
                        ? [settings.systemInitMessage, CHAT_MESSAGE_SYSTEM_PROMPT].filter(Boolean).join('\n\n')
                        : settings.systemInitMessage || undefined,
                messages,
                signal,
                ...(settings.maxOutputTokens > 0 ? { maxTokens: settings.maxOutputTokens } : {}),
                ...(Object.keys(extra).length ? { extra } : {}),
            };
            try {
                if (protocol === 'chat-completions' && onMessage) {
                    const persona = settings.systemInitMessage ?? '';
                    return await completeWithMessageActions(client, options, onMessage, {
                        hasPersona: !!persona,
                        personaMentionsSingleMessage: personaMentionsSingleMessage(persona),
                    });
                }
                if (onStream) {
                    return await consumeTextStream(
                        client.stream(options),
                        onStream,
                        settings.telegramMinStreamInterval,
                    );
                }
                return (await client.complete(options)).text;
            } finally {
                clear();
            }
        },
    };
}

/** 组装 OpenAI Images 协议的图片 agent(workers 走 workersai.ts) */
export function createImageAgent(provider: ImageProviderConfig): ImageAgent {
    const client = createImageClient('images', {
        model: provider.model,
        baseUrl: provider.baseUrl || undefined,
        apiKey: provider.apiKey || undefined,
        extraParams: provider.extraParams,
    });
    return {
        name: provider.id,
        label: provider.label || 'OpenAI Images',
        model: provider.model || provider.models[0] || '',
        modelList: async () => provider.models,
        generate: prompt => client.generate(prompt),
    };
}
