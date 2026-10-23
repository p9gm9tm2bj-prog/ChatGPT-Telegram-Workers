import type { CompletionOptions } from './types';
import {
    buildChatCompletionsBody,
    ChatCompletionsClient,
    parseChatCompletionsResponse,
    parseChatCompletionsSSE,
} from './chat-completions';
import { collectStream, imageResponse, jsonResponse, sseEvent, sseResponse } from './testing';

/** PNG 魔数,base64 首字符为 'i',可被格式嗅探识别 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = 'iVBORw0KGgo=';

const options: CompletionOptions = {
    model: 'gpt-4o-mini',
    system: 'be nice',
    messages: [
        { role: 'user', content: 'hi' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'look' },
                { type: 'image', image: 'https://example.com/cat.png' },
                { type: 'image', image: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
            ],
        },
    ],
};

describe('buildChatCompletionsBody', () => {
    it('prepends system message and renders image parts', () => {
        expect(buildChatCompletionsBody(options, false)).toEqual({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'be nice' },
                { role: 'user', content: 'hi' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'look' },
                        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
                    ],
                },
            ],
        });
    });

    it('adds stream and sampling params only when set', () => {
        const body = buildChatCompletionsBody(
            { ...options, temperature: 0.5, topP: 0.9, stop: ['END'], maxTokens: 256 },
            true,
        );
        expect(body.stream).toBe(true);
        expect(body.temperature).toBe(0.5);
        expect(body.top_p).toBe(0.9);
        expect(body.stop).toEqual(['END']);
        expect(body.max_tokens).toBe(256);
    });

    it('keeps inline system messages', () => {
        const body = buildChatCompletionsBody(
            {
                model: 'gpt',
                messages: [{ role: 'system', content: 'sys' }],
            },
            false,
        );
        expect(body.messages).toEqual([{ role: 'system', content: 'sys' }]);
    });

    it('serializes tool definitions, assistant tool calls, and tool results', () => {
        const body = buildChatCompletionsBody(
            {
                model: 'deepseek-flash',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'send_message',
                            parameters: { type: 'object', properties: { text: { type: 'string' } } },
                        },
                    },
                ],
                messages: [
                    {
                        role: 'assistant',
                        content: '',
                        reasoning_content: 'I can answer briefly.',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'send_message', arguments: '{"text":"Hi"}' },
                            },
                        ],
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: 'Message sent.' },
                ],
            },
            false,
        );

        expect(body.tool_choice).toBe('auto');
        expect(body.tools[0].function.name).toBe('send_message');
        expect(body.messages).toEqual([
            {
                role: 'assistant',
                content: '',
                reasoning_content: 'I can answer briefly.',
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'send_message', arguments: '{"text":"Hi"}' },
                    },
                ],
            },
            { role: 'tool', content: 'Message sent.', tool_call_id: 'call_1' },
        ]);
    });
});

describe('parseChatCompletionsResponse', () => {
    it('extracts text usage and finish reason', () => {
        expect(
            parseChatCompletionsResponse({
                choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            }),
        ).toEqual({
            text: 'hello',
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            stopReason: 'stop',
        });
    });

    it('joins content part arrays', () => {
        expect(
            parseChatCompletionsResponse({
                choices: [
                    {
                        message: {
                            content: [
                                { type: 'text', text: 'a' },
                                { type: 'text', text: 'b' },
                            ],
                        },
                    },
                ],
            }).text,
        ).toBe('ab');
    });

    it('preserves tool calls and reasoning for a subsequent model turn', () => {
        expect(
            parseChatCompletionsResponse({
                choices: [
                    {
                        message: {
                            content: '',
                            reasoning_content: 'I will send one short message.',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'send_message', arguments: '{"text":"Hi"}' },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
            }),
        ).toMatchObject({
            text: '',
            reasoningContent: 'I will send one short message.',
            toolCalls: [{ id: 'call_1', function: { name: 'send_message' } }],
        });
    });
});

describe('parseChatCompletionsSSE', () => {
    it('extracts deltas and finishes on [DONE]', () => {
        expect(parseChatCompletionsSSE({ event: null, data: '{"choices":[{"delta":{"content":"Hi"}}]}' })).toEqual({
            delta: 'Hi',
        });
        expect(parseChatCompletionsSSE({ event: null, data: '{"choices":[{"delta":{}}]}' })).toEqual({});
        expect(parseChatCompletionsSSE({ event: null, data: '[DONE]' })).toEqual({ finish: true });
    });

    it('reports in-stream errors', () => {
        expect(parseChatCompletionsSSE({ event: null, data: '{"error":{"message":"quota"}}' })).toEqual({
            error: 'quota',
        });
    });
});

describe('chatCompletionsClient', () => {
    it('sends bearer auth and parses completion', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({
                choices: [{ message: { role: 'assistant', content: 'hey' }, finish_reason: 'stop' }],
            }),
        );
        const client = new ChatCompletionsClient({
            apiKey: 'sk',
            baseUrl: 'https://proxy.example/v1',
            fetch: fetchMock as any,
        });
        const result = await client.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });

        expect(result.text).toBe('hey');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://proxy.example/v1/chat/completions');
        expect(init.headers.authorization).toBe('Bearer sk');
        expect(JSON.parse(init.body).stream).toBeUndefined();
    });

    it('streams deltas until [DONE]', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                sseResponse([
                    sseEvent(null, '{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}'),
                    sseEvent(null, '{"choices":[{"delta":{"content":"lo"}}]}'),
                    sseEvent(null, '[DONE]'),
                ]),
            );
        const client = new ChatCompletionsClient({ fetch: fetchMock as any });
        await expect(collectStream(client.stream({ model: 'gpt', messages: [] }))).resolves.toEqual(['Hel', 'lo']);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    });

    it('throws on http failure with error message', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401));
        const client = new ChatCompletionsClient({ fetch: fetchMock as any });
        await expect(client.complete({ model: 'gpt', messages: [] })).rejects.toThrow('bad key');
    });

    it('keeps remote image urls by default and inlines them with imageTransfer base64', async () => {
        const fetchMock = vi.fn((url: any, _init: any) => {
            if (String(url).endsWith('.png')) {
                return Promise.resolve(imageResponse(PNG_BYTES));
            }
            return Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        });
        const messages = [
            { role: 'user' as const, content: [{ type: 'image' as const, image: 'https://example.com/cat.png' }] },
        ];

        const urlClient = new ChatCompletionsClient({ fetch: fetchMock as any });
        await urlClient.complete({ model: 'gpt', messages });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toEqual([
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ]);

        const inlineClient = new ChatCompletionsClient({ imageTransfer: 'base64', fetch: fetchMock as any });
        await inlineClient.complete({
            model: 'gpt',
            messages: [{ ...messages[0], content: [...messages[0].content] }],
        });
        expect(JSON.parse(fetchMock.mock.calls[2][1].body).messages[0].content).toEqual([
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ]);
    });
});
