import type { FfmpegContainer } from './container';
import type { CaptionPosition, CaptionPreset, CaptionSize } from './subtitles';

export interface Env {
  AI: Ai;
  MEDIA: R2Bucket;
  /** Per-chat caption settings. Without it the deployed defaults are used. */
  CAPTION_SETTINGS: KVNamespace;
  FFMPEG: DurableObjectNamespace<FfmpegContainer>;
  CAPTION_WORKFLOW: Workflow<CaptionJob>;

  // vars (wrangler.jsonc)
  /** Must be the font's internal family name, not its filename. */
  SUBTITLE_FONT: string;
  /** "true" only for a font with a real bold weight — libass fakes it otherwise. */
  SUBTITLE_FONT_BOLD: string;
  CAPTION_PRESET: CaptionPreset;
  CAPTION_SIZE: CaptionSize;
  CAPTION_POSITION: CaptionPosition;
  SOURCE_LANG: string;
  TARGET_LANG: string;
  STT_PROVIDER: 'workers-ai' | 'groq' | 'mistral';
  CHUNK_SECONDS: string;
  MAX_VIDEO_SECONDS: string;
  /** Longest caption line before it is split into another cue. */
  MAX_CAPTION_CHARS: string;

  // secrets (wrangler secret put)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Only the one matching STT_PROVIDER is needed. */
  GROQ_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  /**
   * Telegram chat id allowed to run /usage. Unset disables the command —
   * it fails closed so billing figures never leak to other users.
   */
  ADMIN_CHAT_ID?: string;
  /** For /usage. Needs Account Analytics: Read — nothing more. */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

/** A single subtitle line: seconds from the start of the video. */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface CaptionJob {
  jobId: string;
  chatId: number;
  messageId: number;
  fileId: string;
  statusMessageId?: number;
}

export interface VideoMeta {
  bytes: number;
  duration: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  audioBytes: number;
}
