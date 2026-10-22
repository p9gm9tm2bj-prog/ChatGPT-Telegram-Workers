/**
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

