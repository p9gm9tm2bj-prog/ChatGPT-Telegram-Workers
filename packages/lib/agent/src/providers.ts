import type {
    ClientConfig,
    CompletionOptions,
    CompletionResult,
    FunctionTool,
    FunctionToolCall,
} from '@chatgpt-telegram-workers/ai';
import type { AppSettings, ChatProviderConfig, ImageProviderConfig } from '@chatgpt-telegram-workers/config';
import type { ChatAgent, ImageAgent } from './types';
import { createClient, createImageClient, findChatProtocol } from '@chatgpt-telegram-workers/ai';
import { consumeTextStream } from './stream';

const CHAT_MESSAGE_SYSTEM_PROMPT = [
    'You are chatting on Telegram. Deliver every reply by calling send_messages.',
    'Each item in messages is sent immediately as a separate Telegram bubble, in the order given.',
    'A single item is a normal reply. Use several items only when your reply naturally consists of separate thoughts or chat lines.',
    'Never split text mechanically, and never add filler just to create more bubbles.',
    'Do not mention this sending mechanism to the user. Keep your configured persona, tone, and humor.',
].join(' ');

const SEND_MESSAGES_TOOL: FunctionTool = {
    type: 'function',
    function: {
        name: 'send_messages',
        description:
            'Deliver your reply as Telegram chat bubbles. Each item in "messages" is sent immediately as a separate message, in order. Use one item for a normal single-message reply; use multiple items when you would naturally send separate chat lines. Do not mechanically split a paragraph.',
        parameters: {
            type: 'object',
            properties: {
                messages: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Message texts in send order. One item is a normal single-message reply.',
                },
            },
            required: ['messages'],
            additionalProperties: false,
        },
    },
};

// The model chooses how many messages to send; this is only a hard safety cap.
const MAX_CHAT_MESSAGES_PER_TURN = 10;

type MessageToolChoice = 'auto' | 'required';

/** 仅用于诊断：人设是否明确要求只发一条，避免和发送协议互相打架。 */
function personaMentionsSingleMessage(persona: string): boolean {
    return /(one message|single message|one reply|single reply|一条|单条|一句话)/i.test(persona);
}

export interface MessageActionDiagnostics {
    hasPersona?: boolean;
    personaMentionsSingleMessage?: boolean;
}

interface ParsedMessageActions {
    texts: string[];
    toolNames: string[];
    invalidItems: number;
}

function parseMessageActions(toolCalls: FunctionToolCall[]): ParsedMessageActions {
    const texts: string[] = [];
    const toolNames: string[] = [];
    let invalidItems = 0;

    for (const call of toolCalls) {
        toolNames.push(call.function.name);
        if (call.function.name !== 'send_messages') {
            continue;
        }
        try {
            const args =
                typeof call.function.arguments === 'string'
                    ? JSON.parse(call.function.arguments)
                    : call.function.arguments;
            const list = (args as { messages?: unknown })?.messages;
            if (!Array.isArray(list)) {
                invalidItems++;
                continue;
            }
            for (const item of list) {
                if (typeof item !== 'string') {
                    invalidItems++;
                    continue;
                }
                const text = item.trim();
                if (text) {
                    texts.push(text);
                }
            }
        } catch {
            invalidItems++;
        }
    }

    return { texts, toolNames, invalidItems };
}

/**
 * 一轮对话只请求一次模型，由模型把 1..N 条消息写进 send_messages 数组。
 * 强制的是发送通道，不是条数；没有任何机械拆分。
 */
export async function completeWithMessageActions(
    client: ReturnType<typeof createClient>,
    options: CompletionOptions,
    onMessage: (text: string) => Promise<unknown>,
    diagnostics: MessageActionDiagnostics = {},
): Promise<string> {
    const startedAt = Date.now();
    const requestOptions: CompletionOptions = {
        ...options,
        messages: [...options.messages],
        tools: [SEND_MESSAGES_TOOL],
    };

    let toolChoice: MessageToolChoice = 'required';
    let retriedWithAuto = false;
    let result: CompletionResult;
    try {
        result = await client.complete({ ...requestOptions, toolChoice });
    } catch (error) {
        // 超时/主动中断不重试；其它错误可能是 provider 不支持 required，退回 auto 一次。
        // 此时还没有发送任何消息，重试不会造成重复气泡。
        if ((error as Error)?.name === 'AbortError') {
            throw error;
        }
        console.warn('[chat-delivery] tool_choice=required failed; retrying with auto', {
            errorName: (error as Error)?.name,
        });
        toolChoice = 'auto';
        retriedWithAuto = true;
        result = await client.complete({ ...requestOptions, toolChoice });
    }

    const toolCalls = result.toolCalls ?? [];
    const text = result.text.trim();
    const sent: string[] = [];
    let path: 'tools' | 'text_fallback' | 'empty' = 'empty';
    let toolNames: string[] = [];
    let requested = 0;
    let capHit = false;
    let invalidItems = 0;

    if (toolCalls.length > 0) {
        const parsed = parseMessageActions(toolCalls);
        toolNames = parsed.toolNames;
        requested = parsed.texts.length;
        invalidItems = parsed.invalidItems;
        capHit = parsed.texts.length > MAX_CHAT_MESSAGES_PER_TURN;

        for (const message of parsed.texts.slice(0, MAX_CHAT_MESSAGES_PER_TURN)) {
            await onMessage(message);
            sent.push(message);
        }
        if (sent.length > 0) {
            path = 'tools';
        }
    }

    // 工具调用没有产出有效内容时，把模型的普通文本作为单条消息发送，保证不丢回复。
    if (sent.length === 0 && text) {
        await onMessage(text);
        sent.push(text);
        path = 'text_fallback';
    }

    console.info('[chat-delivery]', {
        ...diagnostics,
        model: options.model,
        path,
        toolChoice,
        retriedWithAuto,
        toolNames,
        requested,
        delivered: sent.length,
        capHit,
        invalidItems,
        contentAlongsideTools: toolCalls.length > 0 && !!text,
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
