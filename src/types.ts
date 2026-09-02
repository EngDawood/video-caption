import type { FfmpegContainer } from './media/container';
import type { CaptionSettings } from './captions/settings';
import type { CaptionPosition, CaptionPreset, CaptionSize } from './captions/subtitles';

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
  /** The provider tried FIRST; the others follow as fallbacks. */
  STT_PROVIDER: 'workers-ai' | 'groq' | 'mistral';
  CHUNK_SECONDS: string;
  MAX_VIDEO_SECONDS: string;
  /** Longest caption line before it is split into another cue. */
  MAX_CAPTION_CHARS: string;
  /** Override the download-media-bot base URL. Defaults to dl.engdawood.com. */
  DOWNLOAD_API_BASE?: string;
  /** Largest video accepted from a social link, in MB. */
  MAX_SOURCE_MB?: string;

  // secrets (wrangler secret put)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Both are used: one is the preferred STT provider, the other its fallback. */
  GROQ_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  /**
   * download-media-bot API key. Unset means the bot still captions uploaded
   * videos but tells the user that links are not available.
   */
  DOWNLOAD_API_KEY?: string;
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

/**
 * A caption job.
 *
 * `full` fetches, transcribes, translates and burns. `restyle` reuses the text
 * and the source video an earlier run left in R2 and only burns again, so it
 * costs one encode instead of a second round of transcription and translation.
 *
 * On a `full` job exactly one of `fileId` / `sourceUrl` is set: an upload, or a
 * social link. A `restyle` job needs neither — it has `assetJobId` instead.
 */
export interface CaptionJob {
  jobId: string;
  chatId: number;
  messageId: number;
  /** Telegram file id, when the user sent the video itself. */
  fileId?: string;
  /** Social post URL, when the user sent a link instead. */
  sourceUrl?: string;
  statusMessageId?: number;
  /**
   * Keeps the ✖️ Stop button on the status line: every progress edit has to
   * re-send the keyboard, because Telegram drops it otherwise.
   */
  cancelToken?: string;
  /** Defaults to 'full' so jobs queued before this field existed still run. */
  mode?: 'full' | 'restyle';
  /**
   * Which job's R2 prefix holds the input video and the translated cues.
   * Its own `jobId` for a full run; the original job's for a restyle.
   */
  assetJobId?: string;
  /**
   * Settings frozen at queue time. A restyle carries the per-video draft here
   * so it burns what the user chose rather than whatever the chat defaults
   * happen to be by the time the step runs.
   */
  settings?: CaptionSettings;
}

export interface VideoMeta {
  bytes: number;
  duration: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  audioBytes: number;
}
