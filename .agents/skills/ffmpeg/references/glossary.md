# Glossary - flags, filters, and ground rules

Use this file to validate any command before returning it.

## Common flags

- `-y` Auto-overwrite output files. Add to the front of every non-interactive command.
- `-i <input>` Input file or URL. Repeat once per input.
- `-c` (alias `-codec`) codec selector. `-c:v` video codec, `-c:a` audio codec, `-c:s` subtitle codec, `-c copy` copy all streams without re-encoding.
- `-map` Pick which input streams go into which output. `-map 0:v` first input's video, `-map 1:a` second input's audio, `-map "[name]"` a named filter graph output.
- `-an` Drop audio in the output.
- `-vn` Drop video in the output.
- `-shortest` Trim output to the shortest input stream when mixing.
- `-frames:v N` Output only N video frames (used for thumbnails, single-frame extracts).
- `-vsync 0` / `-fps_mode passthrough` Drop duplicate frames. `-vsync` is deprecated in newer builds; prefer `-fps_mode` when targeting recent FFmpeg.
- `-ss <time>` Seek. Position-sensitive: see "Input vs output seeking" below.
- `-to <time>` Stop at this timestamp. `-t <duration>` stop after this much elapsed.
- `-pix_fmt yuv420p` Pixel format. Required for playback in QuickTime, Safari, and most consumer players when emitting H.264.
- `-movflags +faststart` Move the moov atom to the front so the file starts playing before fully downloaded. Works with MP4, M4A, MOV.
- `-vtag hvc1` Apple-friendly HEVC tag. Add when emitting libx265 for iOS / macOS.
- `-q:v <2-31>` JPEG output quality. 2 = best, 31 = worst.
- `-q:a <0-9>` MP3 (libmp3lame) VBR quality. 0 = best, 9 = worst. `-q:a 2` is the common high-quality setting (~170-210 kbit/s stereo).
- `-b:v <bitrate>` Video bitrate (e.g. `-b:v 2M`).
- `-b:a <bitrate>` Audio bitrate (e.g. `-b:a 128k`). `-ab` is the older alias.
- `-ar <hz>` Audio sample rate (e.g. `-ar 16000` for speech-to-text).
- `-ac <n>` Audio channels (`-ac 1` mono, `-ac 2` stereo).
- `-threads 0` Let FFmpeg pick thread count. Default; usually omit.

## Filtering

Three filter entry points:

- `-vf <chain>` (alias `-filter:v`) - single video chain on the first matching input.
- `-af <chain>` (alias `-filter:a`) - single audio chain.
- `-filter_complex "<graph>"` - multi-input or multi-output filter graphs, named streams, mixing video and audio.

Use `-filter_complex` whenever:
- You have more than one input feeding a filter.
- You need named labels (`[v0]`, `[a1]`, `[out]`).
- You manipulate audio and video together.
- You produce more than one output stream.

## Stream selectors

- `[0]` All streams from the first input (zero-based).
- `[0:v]` Video stream(s) from the first input.
- `[0:v:0]` First video stream of the first input.
- `[1:a]` Audio stream(s) from the second input.
- `[1:a:1]` Second audio stream of the second input.
- `[name]` A named stream produced earlier in the same filter graph.

Selectors used with `-map` follow the same shape but without brackets: `-map 0:v:0`, `-map 1:a`.

## Critical filter idioms

- After `trim` or `atrim`, always reset PTS:
  - Video: `trim=start=11:end=15,setpts=PTS-STARTPTS`
  - Audio: `atrim=start=11:end=15,asetpts=PTS-STARTPTS`
  Skipping this breaks `concat` and downstream filters silently.
- After resize+pad, lock pixel aspect ratio: append `,setsar=1:1`. Without it, FFmpeg may carry a non-1:1 SAR and the output looks stretched.
- For frame-accurate jump cuts, reset timestamps with `setpts=N/FRAME_RATE/TB` (video) and `asetpts=N/SR/TB` (audio).
- When concatenating dissimilar clips, normalize them first: `fps=30,format=yuv420p,setsar=1` for video; `aformat=sample_fmts=fltp:channel_layouts=stereo` for audio.
- Quote filter chains with single quotes when expressions contain commas, parentheses, or `*`. Escape inline commas inside expressions as `\,`.

## Expression evaluation

Filter parameters that take expressions support `if`, `gte`, `lte`, `gt`, `lt`, `eq`, arithmetic, and helpers. Use `*` as logical AND, `+` as logical OR.

Useful variables inside filters:
- `t` current timestamp in seconds.
- `n` / `N` frame counter (zero-based).
- `iw`, `ih` input width / height.
- `ow`, `oh` output width / height (after the current filter).
- `main_w`, `main_h`, `overlay_w`, `overlay_h` for `overlay`.
- `W`, `H`, `w`, `h` first-stream and second-stream dimensions in `filter_complex` overlays.

## `-c copy` (stream copy)

Re-muxes streams into a new container without re-encoding. Much faster, lossless. Use whenever possible.

Do **not** use `-c copy` when:
- Applying any video filter (`scale`, `overlay`, `subtitles`, `trim`, `fade`).
- Mixing or modifying audio (`amix`, `atempo`, `volume`).
- Burning subtitles into the picture.
- Transcoding between codecs.
- Trying to compress the file.
- Trimming with frame accuracy (only keyframe-aligned cuts work, can produce black frames).

## Input vs output seeking

- **Input seeking** - `-ss` *before* `-i`. Fast (parses by keyframe), but only seeks to the nearest keyframe before the requested time. With H.264 at 25 fps a keyframe can be every 10 seconds. Trims here reset the timeline.
- **Output seeking** - `-ss` *after* `-i`. Decodes and discards until the timestamp; frame-accurate but slower.

Rule of thumb:
- Thumbnails / quick previews -> input seeking.
- Real trims kept in the output -> output seeking, **without** `-c:v copy`. Combining input seeking with `-c:v copy` triggers an open FFmpeg bug and can drop the first second of output. Combining output seeking with `-c:v copy` leaves the cut at a non-keyframe and produces black frames.

## Stream disposition

- `-disposition:s:0 default` Mark the first subtitle stream as the default track.
- `-disposition:a:0 default` Same for audio. Useful when the container has multiple language tracks.

## Inspecting media

- `ffprobe -show_streams -i <file>` - codecs, resolutions, durations, channel layouts.
- `ffprobe -v trace -i <file>` - extreme detail; grep for `moov` to confirm `+faststart` worked.
- `ffmpeg -formats` - what containers this build supports.
- `ffmpeg -codecs` - what codecs this build supports.
