import type { HistoryModifier, Message, Part, StreamHandler } from '@chatgpt-telegram-workers/agent';
import type * as Telegram from 'telegram-bot-api-types';
import type { WorkerContext } from '../context';
import { loadChatLLM, requestCompletionsFromLLM } from '@chatgpt-telegram-workers/agent';
import { ENV } from '@chatgpt-telegram-workers/config';
import { createTelegramBotAPI, MessageSender } from '@chatgpt-telegram-workers/telegram';

export async function chatWithMessage(
    message: Telegram.Message,
    params: Message | null,
    context: WorkerContext,
    modifier: HistoryModifier | null,
): Promise<Response> {
    const sender = MessageSender.fromMessage(context.SHARE_CONTEXT.botToken, message);
    try {
        try {
            const msg = (await sender.sendPlainText('...').then(r => r.json())) as Telegram.ResponseWithMessage;
            sender.update({
                message_id: msg.result.message_id,
            });
        } catch (e) {
            console.error(e);
        }
        const api = createTelegramBotAPI(context.SHARE_CONTEXT.botToken);
        setTimeout(
            () =>
                api
                    .sendChatAction({
                        chat_id: message.chat.id,
                        action: 'typing',
                    })
                    .catch(console.error),
            0,
        );
        // The current chat-completions path emits each model-selected message as it is chosen.
        // Other providers keep their existing single-response behavior.
        const onStream: StreamHandler | null = ENV.CONFIG.settings.streamMode ? async () => {} : null;
        let sentByAgent = 0;
        const retryAfterSeconds = async (response: Response): Promise<number> => {
            try {
                const body = (await response.clone().json()) as { parameters?: { retry_after?: number } };
                return Math.min(body.parameters?.retry_after ?? 1, 5);
            } catch {
                return 1;
            }
        };
        const onMessage = async (text: string) => {
            let response = await sender.sendRichText(text);
            // 连续气泡很容易触发 Telegram 限流；只对未拆分的单条消息重试一次。
            if (!response.ok && response.status === 429 && text.length <= 4096) {
                const delayMs = (await retryAfterSeconds(response)) * 1000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                response = await sender.sendRichText(text);
            }
            if (!response.ok) {
                throw new Error(`Telegram message send failed (${response.status})`);
            }
            sentByAgent++;
            // First send edits the initial placeholder; following sends create new bubbles.
            sender.update({ message_id: null });
            return response;
        };

        const agent = loadChatLLM(ENV.CONFIG);
        if (agent === null) {
            return sender.sendPlainText('LLM is not enable');
        }
        const answer = await requestCompletionsFromLLM(
            params,
            context.SHARE_CONTEXT.chatHistoryKey,
            ENV.CONFIG,
            agent,
            modifier,
            onStream,
            onMessage,
        );
        if (sentByAgent > 0) {
            return new Response('Messages sent', { status: 200 });
        }
        return sender.sendRichText(answer);
    } catch (e) {
        let errMsg = `Error: ${(e as Error).message}`;
        if (errMsg.length > 2048) {
            // 裁剪错误信息 最长2048
            errMsg = errMsg.substring(0, 2048);
        }
        return sender.sendPlainText(errMsg);
    }
}

export async function extractImageURL(fileId: string | null, context: WorkerContext): Promise<URL | null> {
    if (!fileId) {
        return null;
    }
    const api = createTelegramBotAPI(context.SHARE_CONTEXT.botToken);
    const file = await api.getFileWithReturns({ file_id: fileId });
    const filePath = file.result.file_path;
    if (filePath) {
        const url = URL.parse(
            `${ENV.CONFIG.settings.telegramApiDomain}/file/bot${context.SHARE_CONTEXT.botToken}/${filePath}`,
        );
        if (url) {
            return url;
        }
    }
    return null;
}

export function extractImageFileID(message: Telegram.Message): string | null {
    if (message.photo && message.photo.length > 0) {
        const offset = ENV.CONFIG.settings.telegramPhotoSizeOffset;
        const length = message.photo.length;
        const sizeIndex = Math.max(0, Math.min(offset >= 0 ? offset : length + offset, length - 1));
        return message.photo[sizeIndex]?.file_id;
    } else if (message.document && message.document.thumbnail) {
        return message.document.thumbnail.file_id;
    }
    return null;
}

export async function extractUserMessageItem(message: Telegram.Message, context: WorkerContext): Promise<Message> {
    const settings = ENV.CONFIG.settings;
    let text = message.text || message.caption || '';
    const urls = await extractImageURL(extractImageFileID(message), context).then(u => (u ? [u] : []));
    if (
        settings.extraMessageContext &&
        message.reply_to_message &&
        message.reply_to_message.from &&
        `${message.reply_to_message.from.id}` !== `${context.SHARE_CONTEXT.botId}` // ignore bot reply
    ) {
        const extraText = message.reply_to_message.text || message.reply_to_message.caption || '';
        if (extraText) {
            text = `${text}\nThe following is the referenced context: ${extraText}`;
        }
        if (settings.extraMessageMediaCompatible.includes('image') && message.reply_to_message.photo) {
            const url = await extractImageURL(extractImageFileID(message.reply_to_message), context);
            if (url) {
                urls.push(url);
            }
        }
    }
    const params: Message = {
        role: 'user',
        content: text,
    };
    if (urls.length > 0) {
        const contents = new Array<Part>();
        if (text) {
            contents.push({ type: 'text', text });
        }
        for (const url of urls) {
            contents.push({ type: 'image', image: url });
        }
        params.content = contents;
    }
    return params;
}
