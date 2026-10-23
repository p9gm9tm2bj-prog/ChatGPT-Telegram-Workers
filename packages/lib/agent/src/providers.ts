import type { ClientConfig, CompletionOptions, FunctionTool, Message } from '@chatgpt-telegram-workers/ai';
import type { AppSettings, ChatProviderConfig, ImageProviderConfig } from '@chatgpt-telegram-workers/config';
import type { ChatAgent, ImageAgent } from './types';
import { createClient, createImageClient, findChatProtocol } from '@chatgpt-telegram-workers/ai';
import { consumeTextStream } from './stream';

const CHAT_MESSAGE_SYSTEM_PROMPT = [
    'For natural Telegram conversation, you may send one or multiple separate messages with send_message, or answer normally in one message.',
    'Choose the content and number of messages naturally. Do not force a particular count or change your configured persona.',
].join(' ');

const SEND_MESSAGE_TOOL: FunctionTool = {
    type: 'function',
    function: {
        name: 'send_message',
        description: 'Send this message to the user as a separate Telegram chat bubble.',
        parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The exact text of one Telegram message.' } },
            required: ['text'],
            additionalProperties: false,
        },
    },
};

// The model chooses how many messages to send; this is only a hard safety cap.
const MAX_CHAT_MESSAGES_PER_TURN = 10;

export async function completeWithMessageActions(
    client: ReturnType<typeof createClient>,
    options: CompletionOptions,
    onMessage: (text: string) => Promise<unknown>,
): Promise<string> {
    const messages = [...options.messages];
    const delivered: string[] = [];

    while (true) {
            if (delivered.length >= MAX_CHAT_MESSAGES_PER_TURN) {
                return delivered.join('\n\n');
            }
            let result;
            try {
                result = await client.complete({
                    ...options,
                    messages,
                    tools: [SEND_MESSAGE_TOOL],
                    toolChoice: 'auto',
                });
            } catch (error) {
                if (delivered.length === 0) {
                    throw error;
                }
                console.error('Stopping message-action turn after a provider error:', error);
                return delivered.join('\n\n');
            }
            const text = result.text.trim();
            const toolCalls = result.toolCalls ?? [];

            // No action call means the model chose to finish this turn naturally.
            if (toolCalls.length === 0) {
                if (text) {
                    await onMessage(text);
                    delivered.push(text);
                }
                return delivered.join('\n\n');
            }

            const assistantMessage: Message = {
                role: 'assistant',
                content: result.text,
                tool_calls: toolCalls,
                ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
            };
            messages.push(assistantMessage);
            if (text) {
                await onMessage(text);
                delivered.push(text);
                if (delivered.length >= MAX_CHAT_MESSAGES_PER_TURN) {
                    return delivered.join('\n\n');
                }
            }

            for (const toolCall of toolCalls) {
                let toolResult = 'No message was sent.';
                if (toolCall.function.name === 'send_message') {
                    try {
                        const args = JSON.parse(toolCall.function.arguments) as { text?: unknown };
                        const messageText = typeof args.text === 'string' ? args.text.trim() : '';
                        if (messageText && delivered.length < MAX_CHAT_MESSAGES_PER_TURN) {
                            await onMessage(messageText);
                            delivered.push(messageText);
                            toolResult = 'Message sent successfully.';
                        } else if (delivered.length >= MAX_CHAT_MESSAGES_PER_TURN) {
                            toolResult = 'Message not sent: the ten-message safety cap was reached.';
                        } else {
                            toolResult = 'The message was empty and was not sent.';
                        }
                    } catch (error) {
                        if (error instanceof SyntaxError) {
                            toolResult = 'Invalid message arguments; no message was sent.';
                        } else {
                            throw error;
                        }
                    }
                } else {
                    toolResult = 'Unknown action; no message was sent.';
                }
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
                if (delivered.length >= MAX_CHAT_MESSAGES_PER_TURN) {
                    return delivered.join('\n\n');
                }
            }
    }
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
                    return await completeWithMessageActions(client, options, onMessage);
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
