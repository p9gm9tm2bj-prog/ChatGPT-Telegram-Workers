import { describe, expect, it } from 'vitest';
import { splitAssistantBubbles } from './bubbles';

describe('splitAssistantBubbles', () => {
    it('splits casual paragraphs into separate bubbles', () => {
        expect(splitAssistantBubbles('嗯。\n\n我准备吃饭呢。\n\n你呢？')).toEqual([
            '嗯。',
            '我准备吃饭呢。',
            '你呢？',
        ]);
    });

    it('keeps a single paragraph as one bubble', () => {
        expect(splitAssistantBubbles('你好呀！有什么我可以帮你的？')).toEqual(['你好呀！有什么我可以帮你的？']);
    });

    it('keeps lists and fenced code intact', () => {
        expect(splitAssistantBubbles('选项：\n\n- 第一项\n- 第二项')).toEqual(['选项：\n\n- 第一项\n- 第二项']);
        expect(splitAssistantBubbles('代码：\n\n```js\n1\n```')).toEqual(['代码：\n\n```js\n1\n```']);
    });

    it('caps bubble count without dropping content', () => {
        expect(splitAssistantBubbles('一\n\n二\n\n三\n\n四')).toEqual(['一', '二', '三\n\n四']);
    });
});

