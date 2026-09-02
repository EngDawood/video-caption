import type { FfmpegContainer } from './container';
import type { CaptionPosition, CaptionPreset, CaptionSize } from './subtitles';

export interface Env {
  AI: Ai;
  MEDIA: R2Bucket;
  /** Per-chat caption settings. Without it the deployed defaults are used. */
  SETTINGS: KVNamespace;
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
