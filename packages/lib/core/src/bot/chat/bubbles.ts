/**
 * @deprecated 未使用的机械分段实现。多气泡现在由模型的 send_messages 工具
 * 选择（见 `@chatgpt-telegram-workers/agent` 的 providers.ts），这里不再参与
 * 发送流程。保留仅作参考，请勿重新接回聊天路径。
 *
 * Conversational paragraphs are delivered as separate Telegram bubbles.
 * Keep structured/Markdown-heavy answers intact to avoid breaking formatting.
 */
export function splitAssistantBubbles(answer: string): string[] {
    const normalized = answer.replace(/\r\n?/g, '\n').trim();
    if (!normalized) {
        return [];
    }
    if (
        normalized.includes('```') ||
        /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|)/m.test(normalized)
    ) {
        return [normalized];
    }

    const paragraphs = normalized
        .split(/\n\s*\n+/)
        .map(part => part.trim())
        .filter(Boolean);
    if (paragraphs.length <= 1) {
        return [normalized];
    }

    // Preserve every word while keeping Telegram output to at most three bubbles.
    if (paragraphs.length > 3) {
        return [...paragraphs.slice(0, 2), paragraphs.slice(2).join('\n\n')];
    }
    return paragraphs;
}

export const ASSISTANT_BUBBLE_DELAY_MS = 450;
