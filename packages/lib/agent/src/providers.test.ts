import type { CompletionOptions, CompletionResult, FunctionToolCall, LLMClient } from '@chatgpt-telegram-workers/ai';
import { completeWithMessageActions } from './providers';

function toolCall(id: string, messages: string[]): FunctionToolCall {
    return {
        id,
        type: 'function',
        function: { name: 'send_messages', arguments: JSON.stringify({ messages }) },
    };
}

function rawToolCall(id: string, name: string, args: unknown): FunctionToolCall {
    return {
        id,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    };
}

function fakeClient(results: CompletionResult[], firstError?: Error) {
    const requests: CompletionOptions[] = [];
    const client = {
        protocol: 'chat-completions',
        complete: vi.fn(async (options: CompletionOptions) => {
            requests.push(options);
            if (firstError && requests.length === 1) {
                throw firstError;
            }
            const next = results.shift();
            if (!next) throw new Error('Unexpected completion request');
            return next;
        }),
        stream: vi.fn(async function* () {}),
    } as unknown as LLMClient;
    return { client, requests };
}

const options: CompletionOptions = { model: 'deepseek-flash', messages: [{ role: 'user', content: '在干嘛' }] };

describe('completeWithMessageActions', () => {
    it('sends a single model-selected bubble through the required tool', async () => {
        const { client, requests } = fakeClient([{ text: '', toolCalls: [toolCall('call_1', ['好呀，等我一下'])] }]);
        const sent: string[] = [];

        const result = await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['好呀，等我一下']);
        expect(result).toBe('好呀，等我一下');
        expect(requests).toHaveLength(1);
        expect(requests[0].toolChoice).toBe('required');
        expect(requests[0].tools?.[0].function.name).toBe('send_messages');
    });

    it('keeps the model-selected order of several bubbles', async () => {
        const { client, requests } = fakeClient([
            { text: '', toolCalls: [toolCall('call_1', ['哟，来啦？', '我刚准备找点东西吃', '你吃饭了没？'])] },
        ]);
        const sent: string[] = [];

        const result = await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['哟，来啦？', '我刚准备找点东西吃', '你吃饭了没？']);
        expect(result).toBe(sent.join('\n\n'));
        expect(requests).toHaveLength(1);
    });

    it('caps the turn at ten messages without dropping content beyond the cap', async () => {
        const messages = Array.from({ length: 12 }, (_, index) => `第${index + 1}条`);
        const { client, requests } = fakeClient([{ text: '', toolCalls: [toolCall('call_1', messages)] }]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(messages.slice(0, 10));
        expect(requests).toHaveLength(1);
    });

    it('falls back to one plain-text bubble when the model does not call the tool', async () => {
        const { client, requests } = fakeClient([{ text: '好呀，等我一下。' }]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['好呀，等我一下。']);
        expect(requests).toHaveLength(1);
    });

    it('retries with auto when the provider rejects a required tool choice', async () => {
        const { client, requests } = fakeClient(
            [{ text: '', toolCalls: [toolCall('call_1', ['好呀'])] }],
            new Error('tool_choice is not supported'),
        );
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['好呀']);
        expect(requests).toHaveLength(2);
        expect(requests[0].toolChoice).toBe('required');
        expect(requests[1].toolChoice).toBe('auto');
    });

    it('does not send assistant text alongside tool calls', async () => {
        const { client } = fakeClient([
            { text: '好的，我来发送。', toolCalls: [toolCall('call_1', ['哟，来啦？'])] },
        ]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['哟，来啦？']);
    });

    it('flattens multiple tool calls in order', async () => {
        const { client } = fakeClient([
            {
                text: '',
                toolCalls: [toolCall('call_1', ['一', '二']), toolCall('call_2', ['三'])],
            },
        ]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['一', '二', '三']);
    });

    it('drops empty items and ignores unknown tools', async () => {
        const { client } = fakeClient([
            {
                text: '',
                toolCalls: [
                    rawToolCall('call_1', 'send_messages', { messages: ['', '  ', '有效'] }),
                    rawToolCall('call_2', 'do_something_else', {}),
                ],
            },
        ]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['有效']);
    });

    it('falls back to plain text when tool arguments are invalid', async () => {
        const { client } = fakeClient([
            {
                text: '兜底回复',
                toolCalls: [rawToolCall('call_1', 'send_messages', 'not-json')],
            },
        ]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['兜底回复']);
    });

    it('returns an empty result when the model produces neither text nor usable tool calls', async () => {
        const { client } = fakeClient([{ text: '' }]);
        const sent: string[] = [];

        const result = await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual([]);
        expect(result).toBe('');
    });
});
