const API = 'https://api.telegram.org';

async function call<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result as T;
}

export interface TgFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  video?: { file_id: string; file_size?: number; duration?: number; mime_type?: string };
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  video_note?: { file_id: string; file_size?: number; duration?: number };
  text?: string;
  /** Text attached to a media message — a link can arrive here instead. */
  caption?: string;
  /** Present on a photo message: how a confirm card is told apart from a text one. */
  photo?: Array<{ file_id: string }>;
}

export interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: TgMessage;
  from: { id: number };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** One row of inline-keyboard buttons. */
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/** One entry in the ☰ command menu Telegram shows beside the input box. */
export interface BotCommand {
  /** Lowercase, 1–32 chars of a-z, 0-9 and _ — no leading slash. */
  command: string;
  description: string;
}

/** Who a published command list applies to. */
export type CommandScope = { type: 'default' } | { type: 'chat'; chat_id: number };

export function telegram(token: string) {
  return {
    sendMessage(chatId: number, text: string, replyTo?: number, keyboard?: InlineKeyboard) {
      return call<TgMessage>(token, 'sendMessage', {
        chat_id: chatId,
        text,
        ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    },

    editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) {
      // Editing to identical text is an API error; never let status updates break the job.
      return call<TgMessage>(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }).catch(() => null);
    },

    /**
     * Send a photo by URL — Telegram fetches it itself, which matters because
     * the thumbnail links handed out by the download API expire quickly.
     * Returns null instead of throwing: a dead thumbnail must not cost the
     * user the card, the caller falls back to text.
     */
    async sendPhoto(
      chatId: number,
      photo: string,
      opts: { caption?: string; replyTo?: number; keyboard?: InlineKeyboard } = {},
    ): Promise<TgMessage | null> {
      return call<TgMessage>(token, 'sendPhoto', {
        chat_id: chatId,
        photo,
        ...(opts.caption ? { caption: opts.caption } : {}),
        ...(opts.replyTo ? { reply_to_message_id: opts.replyTo, allow_sending_without_reply: true } : {}),
        ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
      }).catch(() => null);
    },

    /** editMessageText is refused on a photo message; captions need their own call. */
    editMessageCaption(chatId: number, messageId: number, caption: string, keyboard?: InlineKeyboard) {
      return call<TgMessage>(token, 'editMessageCaption', {
        chat_id: chatId,
        message_id: messageId,
        caption,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }).catch(() => null);
    },

    /**
     * Publish the ☰ command menu. The list is replaced wholesale for the scope
     * it is sent with, and a chat scope *hides* the default list from that chat
     * rather than adding to it — so a chat-scoped list must repeat every command
     * that chat should still see.
     */
    setMyCommands(commands: BotCommand[], scope?: CommandScope) {
      return call<boolean>(token, 'setMyCommands', {
        commands,
        ...(scope ? { scope } : {}),
      });
    },

    /** Every callback_query must be answered or the button spins forever. */
    answerCallbackQuery(id: string, text?: string) {
      return call(token, 'answerCallbackQuery', {
        callback_query_id: id,
        ...(text ? { text } : {}),
      }).catch(() => null);
    },

    async getFileUrl(fileId: string): Promise<{ url: string; size: number }> {
      const file = await call<TgFile>(token, 'getFile', { file_id: fileId });
      if (!file.file_path) throw new Error('telegram getFile returned no path');
      return {
        url: `${API}/file/bot${token}/${file.file_path}`,
        size: file.file_size ?? 0,
      };
    },

    async download(fileId: string): Promise<ArrayBuffer> {
      const { url } = await this.getFileUrl(fileId);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`telegram file download failed (${res.status})`);
      return res.arrayBuffer();
    },

    async sendVideo(chatId: number, video: ArrayBuffer, opts: { caption?: string; replyTo?: number } = {}) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('supports_streaming', 'true');
      if (opts.caption) form.append('caption', opts.caption);
      if (opts.replyTo) {
        form.append('reply_to_message_id', String(opts.replyTo));
        form.append('allow_sending_without_reply', 'true');
      }
      form.append('video', new File([video], 'captioned.mp4', { type: 'video/mp4' }));

      const res = await fetch(`${API}/bot${token}/sendVideo`, { method: 'POST', body: form });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) throw new Error(`telegram sendVideo failed: ${data.description ?? res.status}`);
    },
  };
}

/** Pull a usable video file id out of an update, whatever form it arrived in. */
export function extractVideo(message: TgMessage): { fileId: string; size: number } | null {
  if (message.video) return { fileId: message.video.file_id, size: message.video.file_size ?? 0 };
  if (message.video_note) return { fileId: message.video_note.file_id, size: message.video_note.file_size ?? 0 };
  if (message.document?.mime_type?.startsWith('video/')) {
    return { fileId: message.document.file_id, size: message.document.file_size ?? 0 };
  }
  return null;
}
