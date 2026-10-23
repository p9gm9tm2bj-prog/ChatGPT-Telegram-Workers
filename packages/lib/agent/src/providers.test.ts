import type { CompletionOptions, CompletionResult, FunctionToolCall, LLMClient } from '@chatgpt-telegram-workers/ai';
import { completeWithMessageActions } from './providers';

function toolCall(id: string, text: string): FunctionToolCall {
    return {
        id,
        type: 'function',
        function: { name: 'send_message', arguments: JSON.stringify({ text }) },
    };
}

function fakeClient(results: CompletionResult[]) {
    const requests: CompletionOptions[] = [];
    const client = {
        protocol: 'chat-completions',
        complete: vi.fn(async (options: CompletionOptions) => {
            requests.push(options);
            const next = results.shift();
            if (!next) throw new Error('Unexpected completion request');
            return next;
        }),
        stream: vi.fn(async function* () {}),
    } as unknown as LLMClient;
    return { client, requests };
}

describe('completeWithMessageActions', () => {
    it('lets the model send a message, reconsider, and stop naturally', async () => {
        const { client, requests } = fakeClient([
            {
                text: '',
                reasoningContent: 'Start with a playful greeting.',
                toolCalls: [toolCall('call_1', '哟，来啦？')],
            },
            { text: '我刚才正准备找点东西吃。', toolCalls: [toolCall('call_2', '你吃饭了没？')] },
            { text: '没吃的话可以一起云吃饭。', stopReason: 'stop' },
        ]);
        const sent: string[] = [];

        const result = await completeWithMessageActions(
            client,
            { model: 'deepseek-flash', messages: [{ role: 'user', content: '在干嘛' }] },
            async text => sent.push(text),
        );

        expect(sent).toEqual(['哟，来啦？', '我刚才正准备找点东西吃。', '你吃饭了没？', '没吃的话可以一起云吃饭。']);
        expect(result).toBe(sent.join('\n\n'));
        expect(requests[0].tools).toHaveLength(1);
        expect(requests[1].messages.at(-2)).toMatchObject({ role: 'assistant', reasoning_content: 'Start with a playful greeting.' });
        expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    });

    it('does not force a second bubble when the model answers in one message', async () => {
        const { client, requests } = fakeClient([{ text: '好呀，等我一下。' }]);
        const sent: string[] = [];

        await completeWithMessageActions(
            client,
            { model: 'deepseek-flash', messages: [{ role: 'user', content: '等会儿' }] },
            async text => sent.push(text),
        );

        expect(sent).toEqual(['好呀，等我一下。']);
        expect(requests).toHaveLength(1);
    });

    it('allows natural multi-message replies but stops at the ten-message safety cap', async () => {
        const { client, requests } = fakeClient([
            ...Array.from({ length: 12 }, (_, index) => ({
                text: '',
                toolCalls: [toolCall(`call_${index + 1}`, `第${index + 1}条`)],
            })),
        ]);
        const sent: string[] = [];

        await completeWithMessageActions(
            client,
            { model: 'deepseek-flash', messages: [{ role: 'user', content: '说点什么' }] },
            async text => sent.push(text),
        );

        expect(sent).toHaveLength(10);
        expect(sent.at(-1)).toBe('第10条');
        expect(requests).toHaveLength(10);
    });
});
