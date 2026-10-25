import type { CompletionOptions, CompletionResult, LLMClient } from '@chatgpt-telegram-workers/ai';
import { completeWithMessageActions } from './providers';

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

function envelope(messages: string[]): string {
    return JSON.stringify({ messages });
}

const options: CompletionOptions = { model: 'deepseek-flash', messages: [{ role: 'user', content: '在干嘛' }] };

describe('completeWithMessageActions', () => {
    it('sends a single model-selected bubble from the JSON envelope', async () => {
        const { client, requests } = fakeClient([{ text: envelope(['好呀，等我一下']) }]);
        const sent: string[] = [];

        const result = await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['好呀，等我一下']);
        expect(result).toBe('好呀，等我一下');
        expect(requests).toHaveLength(1);
        expect(requests[0].tools).toBeUndefined();
        expect(requests[0].extra).toMatchObject({ response_format: { type: 'json_object' } });
    });

    it('keeps the model-selected order of several bubbles', async () => {
        const { client, requests } = fakeClient([
            { text: envelope(['哟，来啦？', '我刚准备找点东西吃', '你吃饭了没？']) },
        ]);
        const sent: string[] = [];

        const result = await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['哟，来啦？', '我刚准备找点东西吃', '你吃饭了没？']);
        expect(result).toBe(sent.join('\n\n'));
        expect(requests).toHaveLength(1);
    });

    it('caps the turn at ten messages', async () => {
        const messages = Array.from({ length: 12 }, (_, index) => `第${index + 1}条`);
        const { client } = fakeClient([{ text: envelope(messages) }]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(messages.slice(0, 10));
    });

    it('parses JSON wrapped in a code fence', async () => {
        const { client } = fakeClient([{ text: '```json\n{"messages":["一","二"]}\n```' }]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['一', '二']);
    });

    it('falls back to one plain-text bubble when the model ignores the JSON envelope', async () => {
        const { client } = fakeClient([{ text: '好呀，等我一下。' }]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['好呀，等我一下。']);
    });

    it('preserves invalid JSON as one bubble instead of dropping it', async () => {
        const { client } = fakeClient([{ text: '{"messages":["未闭合"' }]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['{"messages":["未闭合"']);
    });

    it('sends nothing for a valid empty messages array', async () => {
        const { client } = fakeClient([{ text: envelope([]) }]);
        const sent: string[] = [];

        const result = await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual([]);
        expect(result).toBe('');
    });

    it('drops empty and non-string items', async () => {
        const { client } = fakeClient([{ text: JSON.stringify({ messages: ['', '  ', 42, '有效'] }) }]);
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['有效']);
    });

    it('retries without response_format and sends the reply as one bubble', async () => {
        const { client, requests } = fakeClient([{ text: '普通文本兜底' }], new Error('response_format unsupported'));
        const sent: string[] = [];

        await completeWithMessageActions(client, options, async text => sent.push(text));

        expect(sent).toEqual(['普通文本兜底']);
        expect(requests).toHaveLength(2);
        expect(requests[0].extra).toMatchObject({ response_format: { type: 'json_object' } });
        expect((requests[1].extra as Record<string, unknown> | undefined)?.response_format).toBeUndefined();
    });

    it('does not retry an aborted request', async () => {
        const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
        const { client, requests } = fakeClient([], abort);

        await expect(completeWithMessageActions(client, options, async () => {})).rejects.toBe(abort);
        expect(requests).toHaveLength(1);
    });
});
