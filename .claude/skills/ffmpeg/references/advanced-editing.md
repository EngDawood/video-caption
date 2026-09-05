# Advanced editing

Speed changes, jump cuts, social-media cropping, drawtext overlays, subtitle burn-in, watermarking, vertical stacking, and full intro/main/outro assembly.

## Change playback speed without distorting audio

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -filter_complex "[0:v]setpts=PTS/1.5[v];[0:a]atempo=1.5[a]" -map "[v]" -map "[a]" output_sped_up.mp4
```

- `setpts=PTS/1.5` speeds video up by 1.5x. Use `PTS*2` to slow to half speed.
- `atempo=1.5` matches audio speed without pitch shift. `atempo` accepts 0.5-100; chain multiple for extreme rates: `atempo=2.0,atempo=2.0` = 4x.

## Change frame rate without changing audio

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -filter:v fps=60 popeye_fps.mp4
```

Only the video is touched; audio passes through.

## Jump cuts

Keep three time ranges, drop everything else:

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -vf "select='between(t,0.0,5.7)+between(t,11.0,18.0)+between(t,19.0,20.0)',setpts=N/FRAME_RATE/TB" -af "aselect='between(t,0.0,5.7)+between(t,11.0,18.0)+between(t,19.0,20.0)',asetpts=N/SR/TB" popeye_jumpcuts.mp4
```

- `+` is logical OR inside FFmpeg expressions, so the three `between(t,a,b)` ranges form a union.
- `setpts=N/FRAME_RATE/TB` and `asetpts=N/SR/TB` rebuild the timeline so dropped frames do not leave gaps. `N` = consumed frames, `FRAME_RATE` / `SR` = video fps / audio sample rate, `TB` = input timebase.

Use this for silence removal, transition cleanup, and shorts assembly.

## 🛠️ Crop a video for social media (vertical 9:16)

Crop chunks of a 1080x720 video to 480x720 windows at different X offsets, then upscale each chunk to 720x1080 and concatenate:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "split=3[1][2][3];[1]trim=0.0:4.5,setpts=PTS-STARTPTS,crop=min(in_w-300\,480):min(in_h-0\,720):300:0,scale=720:1080,setsar=1:1[1];[2]trim=4.5:8.5,setpts=PTS-STARTPTS,crop=min(in_w-500\,480):min(in_h-0\,720):500:0,scale=720:1080,setsar=1:1[2];[3]trim=8.5,setpts=PTS-STARTPTS,crop=min(in_w-400\,480):min(in_h-0\,720):400:0,scale=720:1080,setsar=1:1[3];[1][2][3]concat=n=3:v=1" -c:v libx264 -c:a copy output_cropped.mp4
```

Filter notes:
- `split=3[1][2][3]` duplicates the source three times.
- For each chunk: `trim=start:end`, then `setpts=PTS-STARTPTS` to reset the timeline (otherwise `concat` misaligns), then `crop=W:H:X:Y`, then `scale=720:1080,setsar=1:1`.
- `min(in_w-300\,480)` clamps crop width so it cannot reach outside the input frame; the comma is escaped to keep the filter parser happy.

If a desired crop window goes past the edge, pad with black before scaling:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "split=3[1][2][3];[1]trim=0.0:4.5,setpts=PTS-STARTPTS,crop=min(in_w-1200\,480):min(in_h-0\,720):1200:0,pad=480:720:(ow-iw)/2:(oh-ih)/2:color=black,scale=720:1080,setsar=1:1[1];[2]trim=4.5:8.5,setpts=PTS-STARTPTS,crop=min(in_w-500\,480):min(in_h-0\,720):500:0,pad=480:720:(ow-iw)/2:(oh-ih)/2:color=black,scale=720:1080,setsar=1:1[2];[3]trim=8.5,setpts=PTS-STARTPTS,crop=min(in_w-400\,480):min(in_h-0\,720):400:0,pad=480:720:(ow-iw)/2:(oh-ih)/2:color=black,scale=720:1080,setsar=1:1[3];[1][2][3]concat=n=3:v=1" -c:v libx264 -c:a copy output_cropped.mp4
```

## Overlay text on video

Three text messages, each appearing at its own time with fade-in alpha and a semi-transparent box:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "drawtext=text='Get ready':x=50:y=100:fontsize=80:fontcolor=black:alpha='if(gte(t,1)*lte(t,3),(t-1)/2,1)':box=1:boxcolor=#6bb666@0.6:boxborderw=7:enable='gte(t,1)', drawtext=text='Set':x=50:y=200:fontsize=80:fontcolor=black:alpha='if(gte(t,6)*lte(t,10),(t-6)/4,1)':box=1:boxcolor=#6bb666@0.6:boxborderw=7:enable='gte(t,6)', drawtext=text='BOOM!':x=50:y=300:fontsize=80:fontcolor=black:alpha='if(gte(t,10)*lte(t,15),(t-10)/5,1)':box=1:boxcolor=#6bb666@0.6:boxborderw=7:enable='gte(t,10)'" -c:v libx264 output_text_overlay.mp4
```

drawtext details (per message):
- `enable='gte(t,1)'` shows the text from t = 1 s onward. `*` is logical AND.
- `alpha='if(gte(t,1)*lte(t,3),(t-1)/2,1)'` fades alpha from 0 to 1 between t=1 and t=3, full opacity afterwards.
- `box=1` draws a background box. `boxborderw=7` adds 7 px padding.
- `boxcolor=#6bb666@0.6` greenish background at 60% opacity.
- `x=50:y=100` top-left position.

For non-ASCII text, special characters, or long strings prefer `textfile=` and `fontfile=`:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "drawtext=textfile=sample_text.txt:fontfile=Poppins-Regular.ttf:x=50:y=100:fontsize=40:fontcolor=black:alpha='if(gte(t,1)*lte(t,5),t-1,1)':box=1:boxcolor=#6bb666@0.6:boxborderw=7:enable='gte(t,1)'" -c:v libx264 output_text_font_file.mp4
```

FFmpeg does not download `textfile=` or `fontfile=` paths - download them locally first.

## 🛠️ Burn subtitles into video

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p.mp4 -ss 00:00 -to 00:40 -vf "subtitles=sample_subtitles.srt:fontsdir=.:force_style='FontName=Poppins,FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H4066B66B,Outline=1,BorderStyle=3'" -c:v libx264 -c:a copy output_subtitles.mp4
```

- Subtitle colors are `&HBBGGRR` or `&HAABBGGRR` (alpha first, FF = fully transparent, 00 = opaque).
- `PrimaryColour` is the font fill. `OutlineColour` plus `Outline=1,BorderStyle=3` draws a colored background box behind the text.
- `FontName` is the *font family name* found inside the font file, not the filename. `fontsdir` points at the directory containing the .ttf.
- For pixel-perfect styling, switch to ASS subtitle format or pre-render captions as transparent PNGs and overlay them.

Embed an SRT track into MKV without re-encoding video:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -i sample_subtitles.srt -c copy -c:s srt -disposition:s:0 default big_buck_bunny_720p_16sec.mkv
```

Extract subtitles back out:

```sh
ffmpeg -i big_buck_bunny_720p_16sec.mkv -map 0:s:0 subs.srt
```

## Watermark / logo overlay

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -i https://storage.rendi.dev/sample/rendi_banner_white_transparent.png -filter_complex "overlay=x=(main_w-overlay_w)/8:y=(main_h-overlay_h)/8:enable='gte(t,1)*lte(t,7)'" -c:v libx264 -c:a copy output_logo.mp4
```

- `main_w`, `main_h` = base video size; `overlay_w`, `overlay_h` = logo size.
- The expression places the top-left corner 1/8th of the slack from the left and top.
- `enable='gte(t,1)*lte(t,7)'` makes the watermark visible from t=1 to t=7 seconds.

🛠️ Force a 50% transparent overlay even when the source PNG has no alpha channel:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -i https://storage.rendi.dev/sample/rendi_banner_white.png -filter_complex "[1:v]format=argb,geq='p(X,Y)':a='0.5*alpha(X,Y)'[v1];[0:v][v1]overlay=x=(main_w-overlay_w)/8:y=(main_h-overlay_h)/8:enable='gte(t,1)*lte(t,7)'" -c:v libx264 -c:a copy output_faded_logo.mp4
```

- `format=argb` adds an alpha channel to the logo.
- `geq='p(X,Y)':a='0.5*alpha(X,Y)'` rewrites every pixel keeping its color but halving its alpha.

## Place video on top of a background image

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -i https://storage.rendi.dev/sample/evil-frank.png -filter_complex "[1:v][0:v]overlay=(W-w)/2:(H-h)/2" -c:v libx264 -c:a copy output_bg.mp4
```

- `[1:v][0:v]` puts the image first (so it becomes the background) and the video on top.
- `(W-w)/2:(H-h)/2` centers the video. Capitals refer to the first stream listed in the overlay (`[1:v]` here), lowercase to the second.

## Combine intro, main, and outro with background music

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_5sec_intro.mp4 -i https://storage.rendi.dev/sample/popeye_talking.mp4 -i https://storage.rendi.dev/sample/big_buck_bunny_720p_5sec_outro.mp4 -i https://storage.rendi.dev/sample/Neon%20Lights.mp3 -filter_complex "[0:v]fps=30,format=yuv420p,setsar=1[intro_v];[1:v]scale=-2:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,setsar=1[main_v];[2:v]fps=30,format=yuv420p,setsar=1[outro_v];[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo[intro_a];[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo[main_a];[2:a]aformat=sample_fmts=fltp:channel_layouts=stereo[outro_a];[intro_v][intro_a][main_v][main_a][outro_v][outro_a]concat=n=3:v=1:a=1[combined_video][combined_audio];[3:a]volume=0.1,aformat=sample_fmts=fltp,afade=t=in:ss=0:d=1.5,afade=t=out:st=20:d=2[bgm_faded];[combined_audio][bgm_faded]amix=inputs=2:duration=first:dropout_transition=2[final_audio]" -map "[combined_video]" -map "[final_audio]" -c:v libx264 -c:a aac -shortest intro_main_outro.mp4
```

- Each video clip is normalized to the same fps (30), pixel format (yuv420p), and SAR (1:1) before `concat`. Skipping that step is the most common reason `concat` fails or shows artifacts.
- Each audio clip is converted to `fltp` planar with `aformat` for the same reason.
- `amix=inputs=2:duration=first:dropout_transition=2` mixes background music under the dialog audio. `duration=first` pins the output length to the dialog (`[combined_audio]`); `dropout_transition=2` fades the shorter input out instead of cutting.

## 🛠️ Vertically stack two videos

Keep the audio of the second video:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -i https://storage.rendi.dev/sample/popeye_talking.mp4 -filter_complex "[0:v]scale=720:-2:force_original_aspect_ratio=decrease,pad=720:640:(ow-iw)/2:(oh-ih)/2:black[top];[1:v]scale=720:-2:force_original_aspect_ratio=decrease,pad=720:640:(ow-iw)/2:(oh-ih)/2:black[bottom];[top][bottom]vstack=inputs=2:shortest=1[v]" -map "[v]" -map 1:a -c:v libx264 -c:a aac -shortest output_stacked.mp4
```

- Both clips are scaled and padded into the same 720x640 frame so `vstack` can join them.
- `vstack=inputs=2:shortest=1` ends the stacked video when the shorter input ends.
- The outer `-shortest` ends the file when audio (mapped from input 1) runs out, whichever comes first.
