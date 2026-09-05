# Encoding and tuning

Codec choices, bitrate control, container flags, seeking trade-offs, hardware acceleration, and ffprobe.

## 🛠️ Daily-use template (H.264)

A flagged-up command good for archiving, non-live streaming, and broad device playback:

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -vf "scale=w=1080:h=1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1:1" -crf 18 -preset veryslow -threads 0 -tune fastdecode -movflags +faststart output_scaled_optimized.mp4
```

- `-crf 18` near-lossless quality (18 is usually visually transparent; 17 if you want extra headroom).
- `-preset veryslow` slowest encode, smallest file at the same CRF. Use `medium` for a faster default, `ultrafast` only when speed matters more than size.
- `-tune fastdecode` produces a stream that is cheaper to decode on weak devices. Use `zerolatency` for live streaming instead.
- `-threads 0` lets FFmpeg pick. Usually omit; only set explicitly when you know better than FFmpeg.
- `-movflags +faststart` moves the moov atom to the front so the file plays before fully downloaded.

## 🛠️ Video / audio encoders

Selectors:

- `-c:v <encoder>` video.
- `-c:a <encoder>` audio.
- `-c:s <encoder>` subtitle.
- `-c copy` skip re-encoding for everything mapped.
- `-an` disable audio output.
- `-vn` disable video output.

Common audio encoders:

- `aac` AAC. FFmpeg's default for MP4. Always specify it explicitly.
- `libmp3lame` MP3 encoder. Pair with `-q:a 2` for high-quality VBR.
- `libopus` Opus, default for WebM.
- `pcm_s16le` / `pcm_s32le` uncompressed PCM in WAV.

### libx264 - H.264 (AVC)

The most broadly compatible video codec; FFmpeg defaults to it for MP4 when libx264 is built in.

CRF (Constant Rate Factor) is the recommended rate control for libx264 / libx265:

- Range 0-51. Lower = higher quality. Default 23.
- Sane range 17-28.
- 17-18 = visually lossless or near-lossless.
- +6 CRF roughly halves bitrate; -6 roughly doubles it.
- CRF cannot enforce a target file size - use two-pass ABR for that.

`-preset` trades encode time for compression efficiency: `ultrafast`, `superfast`, `veryfast`, `faster`, `fast`, `medium` (default), `slow`, `slower`, `veryslow`. Same CRF + slower preset = smaller file at the same quality.

Required for QuickTime / Safari / most consumer players:

```sh
-pix_fmt yuv420p
```

Without it, output may decode fine in VLC but fail in other players.

`-movflags +faststart` is supported by MP4, M4A, MOV. Verify with:

```sh
ffprobe -v trace -i your_video.mp4
```

and look for an early line containing `type:'moov'`.

### libx265 - H.265 (HEVC)

Same CRF semantics as libx264. Smaller files at the same quality, but slower to encode and less broadly supported.

Apple-friendly HEVC for AirDrop / Photos / iOS playback:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -c:v libx265 -vtag hvc1 -c:a copy output_265.mp4
```

`-vtag hvc1` flags the file as Apple-compatible HEVC. Without it, AirDrop on iOS rejects the file.

`+faststart` works with libx265 too:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -c:v libx265 -c:a copy -movflags +faststart big_buck_bunny_720p_16sec_h265_faststart.mp4
```

### libvpx-vp9 (WebM)

VP9 is the YouTube-friendly open codec. ~20-50% smaller than libx264 at the same visual quality.

Constant Quality mode (the VP9 equivalent of CRF):

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -c:v libvpx-vp9 -crf 15 -b:v 0 -c:a libopus big_buck_bunny_720p_16sec.webm
```

- `-b:v 0` is mandatory. Anything else triggers Constrained Quality mode and changes the meaning of `-crf`.
- VP9 CRF range: 0-63. Recommended range 15-35; ~31 for 1080p HD.
- WebM's default audio encoder is libopus.

## Choosing rate control

| Use case | Recommendation |
| --- | --- |
| Archival | CRF that gives the quality you want |
| Web streaming (VOD) | Two-pass CRF or ABR with VBV-constrained bitrate |
| Live streaming | One-pass CRF or ABR with VBV-constrained bitrate, or CBR if bits are cheap |
| Encoding for devices | Two-pass ABR |
| Hitting a target size | Two-pass ABR (CRF cannot guarantee size) |

## 🛠️ `-c copy` (stream copy)

Re-muxes streams into a new container without re-encoding. Faster and lossless. Use whenever you do not need to alter the streams.

Do **not** use `-c copy` when:

- Applying any video filter (`scale`, `overlay`, `subtitles`, `trim`, `fade`).
- Mixing or modifying audio (`amix`, `atempo`, `volume`).
- Burning subtitles into the picture.
- Transcoding between codecs.
- Aiming to compress.
- Trimming with frame accuracy (only keyframe-aligned cuts work).

## 🛠️ Input vs output seeking

Input seeking - `-ss` *before* `-i`:

```sh
ffmpeg -ss 00:00:03 -i "https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4" -frames:v 1 "input_seeking.jpg"
```

Parses the file by keyframes. Very fast, but only seeks to the nearest keyframe before the requested time. With H.264 at 25 fps a keyframe can be every 10 seconds, so the actual landing point can be off by several seconds. When trimming with input seeking, the output timeline starts from the trim point.

Output seeking - `-ss` *after* `-i`:

```sh
ffmpeg -i "https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4" -ss 00:00:03 -frames:v 1 "input_seeking.jpg"
```

Decodes and discards until the timestamp; frame-accurate but slower because the decoder has to process the skipped bytes.

🛠️ For real trims kept in the output, prefer **output seeking without `-c:v copy`** (re-encoding the trimmed range):

- Input seeking + `-c:v copy` triggers an open FFmpeg trimming bug ([trac ticket 8189](https://trac.ffmpeg.org/ticket/8189)) and can drop the first second of output.
- Output seeking + `-c:v copy` cuts at a non-keyframe so the first frames are missing reference data and render black.

If you re-encode for trimming, the bitrate of the trimmed portion may differ from the source - reset bitrate (or CRF) explicitly when this matters.

## 🛠️ Hardware acceleration

Nvidia (NVENC):

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_stereo.avi -c:v h264_nvenc output_gpu_264.mp4
```

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_stereo.avi -c:v hevc_nvenc output_gpu_265.mp4
```

Intel Quick Sync Video (QSV):

```sh
ffmpeg -init_hw_device qsv=hw -filter_hw_device hw -i https://storage.rendi.dev/sample/big_buck_bunny_720p_stereo.avi -c:v h264_qsv output_gpu_qsv.mp4
```

AMD via VAAPI is supported on Linux but requires more setup ([VAAPI wiki](https://trac.ffmpeg.org/wiki/Hardware/VAAPI)).

Notes:
- Hardware encoders are much faster but typically produce slightly larger files at the same visual quality vs `libx264 -preset veryslow`.
- macOS has VideoToolbox encoders (`h264_videotoolbox`, `hevc_videotoolbox`) which work without extra device setup.
- Do not suggest GPU encoders if the user is on macOS or in a CI environment without GPUs - the command will fail at runtime.

## ffprobe

Inspect streams:

```sh
ffprobe -show_streams -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4
```

Verify `+faststart` actually placed the moov atom early:

```sh
ffprobe -v trace -i your_video.mp4
```

Look for a line containing `type:'moov'` near the top of the output.

List supported formats and codecs in the local FFmpeg build:

```sh
ffmpeg -formats
ffmpeg -codecs
```
