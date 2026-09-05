# Simple editing

Format conversion, resizing with padding, and time-based trimming. Most everyday FFmpeg work lives here.

## Convert formats

Remux MP4 to MKV (no re-encoding):

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -c copy big_buck_bunny_720p_16sec.mkv
```

Remux MP4 to MOV (no re-encoding):

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -c copy big_buck_bunny_720p_16sec.mov
```

Encode MP4 to AVI (forces re-encode because AVI does not support all H.264 profiles):

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 big_buck_bunny_720p_16sec.avi
```

Notes:
- MKV and MP4 are containers. They can both hold H.264 / H.265 video and AAC / MP3 audio. Quality lives in the codec, not the container.
- MP4 is the most broadly supported container on phones, browsers, and edge devices.
- MKV can hold multiple video streams, multiple subtitle tracks, and chapters cleanly.

## Resize and pad

🛠️ Upscale to 1080x1920 preserving aspect ratio, fill the gaps with black:

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -vf "scale=w=1080:h=1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1:1" output_resized_pad.mp4
```

Filter breakdown:
- `scale=w=1080:h=1920:force_original_aspect_ratio=decrease` resizes the input to fit *inside* 1080x1920 by lowering whichever dimension is needed to keep the original aspect ratio.
- `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black` centers the scaled video on a 1080x1920 black canvas. Values are `width:height:x:y`; negative values also center.
- `setsar=1:1` locks the sample aspect ratio to 1:1 so the output is not stretched.

`force_original_aspect_ratio` values:
- `disable` (default).
- `decrease` shrinks output dimensions on demand to keep aspect ratio.
- `increase` enlarges output dimensions on demand to keep aspect ratio.

Auto-pick a dimension while keeping aspect ratio:
- `scale=w=1080:h=-1` lets FFmpeg pick the height.
- `scale=w=1080:h=-2` same, but forces the result to be divisible by 2 (required by H.264).

Build a horizontal and a vertical version in one pass, with a logo on the vertical version:

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -i https://storage.rendi.dev/sample/rendi_banner_white.png -filter_complex "[0:v]split=2[s0][s1];[s0]scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1:1[out1];[s1]scale=w=720:h=1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1:1[s2];[s2][1]overlay=(main_w-overlay_w)/2:(main_w-overlay_w)/5[out2]" -map [out1] -map 0:a output_youtube.mp4 -map [out2] -map 0:a output_shorts.mp4
```

`split=2` duplicates the source video stream so both branches can run in the same graph. Each branch finishes with a named output (`[out1]`, `[out2]`) consumed by `-map` before its own output filename.

## Trim by time

Frame-accurate trim (output seeking, re-encodes the trimmed range):

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -ss 00:00:10 -to 00:00:25 output_trimmed.mp4
```

Caveats:
- Faster trims use input seeking (`-ss` before `-i`), but only land on keyframes.
- Pairing input seeking with `-c:v copy` triggers a known FFmpeg bug that can drop the first second of output.
- Pairing output seeking with `-c:v copy` cuts at a non-keyframe and can produce black frames at the start.
- For real edits kept in the output, use output seeking *without* `-c:v copy` (this command).

See `references/encoding-and-tuning.md` for the full input-vs-output seeking discussion.
