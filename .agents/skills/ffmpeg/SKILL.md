---
name: ffmpeg
description: Provides FFmpeg commands and filter recipes for video automation pipelines - format conversion, resizing, trimming, audio mixing, subtitles and overlays, slideshows, thumbnails, and encoding tuning. Use when the user asks to convert, trim, compress, mix, overlay, or burn text into media, generate thumbnails or slideshows, build a Ken Burns or social-media clip, or tune ffmpeg encoding parameters such as CRF, preset, faststart, or hardware acceleration.
license: MIT
metadata:
  author: Anton Novoselov
  version: "1.0"
---

Build correct FFmpeg commands for media-processing tasks by composing recipes from the references instead of recalling commands from memory. FFmpeg syntax is highly position-sensitive and easy to get subtly wrong, so prefer adapting a known-good command from these references over inventing one.

Workflow:

1. Identify the task category (simple edit, audio processing, advanced filtering, asset generation, encoding tune-up).
1. Open the matching reference file and pick the closest recipe.
1. Adapt input paths, time ranges, dimensions, codecs, and filter parameters to the user's request.
1. Before returning the command, walk through `references/glossary.md` to validate stream selectors, `-map`, `-c copy` use, and seeking position.
1. If the user is running on macOS or Linux without a GPU, do not suggest `*_nvenc`, `*_qsv`, or VAAPI encoders.

If doing partial work, load only the relevant reference files.


## Core Instructions

- Always start commands with `-y` when overwriting is acceptable; otherwise omit it so FFmpeg prompts before clobbering output.
- Prefer `-c copy` (stream copy / remux) when no filter, codec change, or precise trim is needed - it avoids re-encoding and is much faster.
- Do not use `-c copy` when applying any video filter (`scale`, `overlay`, `subtitles`, `trim`, `fade`), mixing or modifying audio (`amix`, `atempo`, `volume`), burning subtitles, transcoding between codecs, or compressing.
- For frame-accurate trimming, use **output seeking** (`-ss` after `-i`) without `-c:v copy`. Input seeking (`-ss` before `-i`) is fast but only seeks to the nearest keyframe and can produce black frames or off-by-seconds cuts.
- For H.264 output, default to `-c:v libx264 -crf 18 -preset veryslow -movflags +faststart -pix_fmt yuv420p` unless the user specifies otherwise. `yuv420p` is required for QuickTime and most consumer players.
- For H.265 (HEVC) output destined for Apple devices, add `-vtag hvc1` so AirDrop and QuickTime accept the file.
- Treat CRF as the primary quality knob: lower = higher quality, +6 roughly halves bitrate. Sane libx264 range is 17-28; 18 is "visually lossless"; libvpx-vp9 uses 15-35 with `-b:v 0` for constant quality.
- When chaining filters, prefer `-filter_complex` once you need named streams (`[v0]`, `[a1]`), multiple inputs, or both audio and video manipulation. Use `-vf` / `-af` for single-stream filtering.
- After `trim` / `atrim`, always reset timestamps with `setpts=PTS-STARTPTS` / `asetpts=PTS-STARTPTS`, otherwise `concat` and downstream filters break.
- Use `-shortest` when mixing inputs of different durations and the output should follow the shortest stream. Pair with `duration=shortest` inside `amix` when both behaviors are needed.
- For `pad`, `setsar=1:1` should follow the resize/pad chain to lock pixel aspect ratio to 1:1 - omitting it can make the output appear stretched even when dimensions look correct.
- Quote `-vf` and `-filter_complex` arguments in single quotes (or escape commas inside expressions with `\,`) to avoid the shell or FFmpeg's expression parser swallowing characters.
- When generating filenames programmatically, prefer extensions that match the codec (`.mp4` for H.264/H.265, `.webm` for VP9/Opus, `.mkv` when multiple subtitle tracks are needed, `.mov` for ProRes / Apple-flavored workflows).
- If the user reports playback failures (black frames, audio drift, "file not supported"), check first for: missing `-pix_fmt yuv420p`, missing `+faststart`, input seeking with `-c copy`, or wrong `-vtag` for HEVC on Apple.
- If the user already has a target file size, switch to two-pass ABR (`-b:v <rate>` with `-pass 1` then `-pass 2`); CRF cannot enforce a size cap.
- Verify metadata and stream layout with `ffprobe -show_streams -i <file>` before debugging filter graphs - mismatched stream indices are the most common silent failure.


## Output Format

When the user asks for a command, return:

1. The full one-line FFmpeg command in a `sh` code block, ready to paste.
1. A short bullet list explaining each non-trivial flag and filter.
1. Any caveats: player compatibility, expected runtime cost, lossy steps, or known FFmpeg quirks linked from the relevant reference file.

Skip the explanation block only if the user explicitly asks for "command only".

When the user asks for a review of an existing command, organize findings as:

1. **Correctness** - flags or filter ordering that will fail or produce wrong output.
1. **Quality** - CRF, preset, color space, faststart, audio bitrate.
1. **Performance** - unnecessary re-encodes, slow filter chains, missing hardware acceleration.
1. **Portability** - codec/container mismatches, Apple HEVC tag, yuv420p for consumer playback.

Example output for a request like "compress this MP4 for the web, keep visual quality":

```sh
ffmpeg -i input.mp4 -c:v libx264 -crf 20 -preset veryslow -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k output.mp4
```

- `-crf 20` keeps near-source quality while shrinking the file; drop to 18 for archival.
- `-preset veryslow` trades encode time for ~20-30% smaller output at the same CRF.
- `-pix_fmt yuv420p` ensures playback in Safari, QuickTime, and most browsers.
- `+faststart` moves the moov atom to the front so the video starts playing before fully downloaded.
- `-c:a aac -b:a 128k` re-encodes audio at a transparent stereo bitrate.

End of example.


## References

- `references/glossary.md` - flag and filter syntax, stream selectors, `-map`, `-c copy` rules, input vs output seeking.
- `references/simple-editing.md` - format conversion (MP4/MKV/MOV/AVI), resize and pad, time-based trim.
- `references/audio-processing.md` - replace, extract, mix, crossfade, downsample, stereo-to-mono, format change.
- `references/advanced-editing.md` - playback speed, fps, jump cuts, social-media cropping, drawtext overlays, subtitles, watermarks, vstack, intro/outro assembly.
- `references/asset-generation.md` - image-to-video, slideshow with xfade, Ken Burns, GIFs, thumbnails, scene-change storyboards.
- `references/encoding-and-tuning.md` - daily-use template, libx264/libx265/libvpx-vp9, faststart, CRF guidance, seeking, GPU encoders, ffprobe.


## Source

Recipes adapted from the [Rendi FFmpeg cheatsheet](https://github.com/rendi-api/ffmpeg-cheatsheet). Sample URLs in the references point at `storage.rendi.dev` so commands can be run directly without local files.
