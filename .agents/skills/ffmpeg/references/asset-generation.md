# Asset generation

Build new media from stills, audio, and existing video: image-to-video, slideshows, Ken Burns, GIFs, thumbnails, and storyboards.

## Image to video

10-second video from a looping image plus an audio track, with a 1-second fade-in:

```sh
ffmpeg -loop 1 -t 10 -i https://storage.rendi.dev/sample/bbb-splash.png -i https://storage.rendi.dev/sample/Neon%20Lights.mp3 -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1:color=black,setsar=1,fade=t=in:st=0:d=1,format=yuv420p" -c:v libx264 -c:a aac -shortest output_loop.mp4
```

- `-loop 1` repeats the image; `-t 10` caps the loop at 10 s.
- `fade=t=in:st=0:d=1` 1-second fade in at the start. Use `t=out` for fade out.
- `format=yuv420p` is needed for QuickTime / browser playback.
- Downloading the PNG locally before running is much faster - otherwise FFmpeg fetches the same image once per output frame.

## 🛠️ Slideshow with crossfade

5 seconds per image, 0.5-second crossfade, background music:

```sh
ffmpeg -loop 1 -t 5 -i https://storage.rendi.dev/sample/rodents.png -loop 1 -t 5 -i https://storage.rendi.dev/sample/evil-frank.png -i https://storage.rendi.dev/sample/Neon%20Lights.mp3 -filter_complex "[0:v]format=yuv420p,fade=t=in:st=0:d=0.5,setpts=PTS-STARTPTS[v0];[1:v]format=yuv420p,fade=t=out:st=4.5:d=0.5,setpts=PTS-STARTPTS[v1];[v0][v1]xfade=transition=fade:duration=0.5:offset=4.5,format=yuv420p[v]" -map "[v]" -map 2:a -c:v libx264 -c:a aac -shortest slideshow_with_fade.mp4
```

- `xfade=transition=fade:duration=0.5:offset=4.5` starts the crossfade 4.5 s into the first clip and lasts 0.5 s, so the final video is 9.5 s.
- The first image fades in; the last image fades out.
- Other useful `xfade` transitions: `fadeblack`, `fadewhite`, `wipeleft`, `slideup`, `circleopen`, `pixelize`.

## 🛠️ Ken Burns from images

Two images, each on screen for 4 s, with a 1-second crossfade and zoom/pan effect:

```sh
ffmpeg -loop 1 -i https://storage.rendi.dev/sample/rodents.png -loop 1 -i https://storage.rendi.dev/sample/evil-frank.png -i https://storage.rendi.dev/sample/Neon%20Lights.mp3 -filter_complex "[0:v]scale=8000:-1,zoompan=z='zoom+0.005':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=100:s=1920x1080:fps=25,trim=duration=4,format=yuv420p,setpts=PTS-STARTPTS[v0];[1:v]scale=8000:-1,zoompan=z='if(lte(zoom,1.0),1.5,max(zoom-0.005,1.005))':x=0:y='ih/2-(ih/zoom/2)':d=100:s=1920x1080:fps=25,trim=duration=4,format=yuv420p,setpts=PTS-STARTPTS[v1];[v0][v1]xfade=transition=fade:duration=1:offset=3,format=yuv420p[v]" -map "[v]" -map 2:a -c:v libx264 -c:a aac -shortest output_kenburns.mp4
```

Filter notes:
- `z='zoom+0.005'` adds a tiny zoom step per frame (zoom in). The second clip uses `if(lte(zoom,1.0),1.5,max(zoom-0.005,1.005))` to start at 1.5x and zoom out toward 1.005.
- `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` keeps the zoom centered.
- `d=100:s=1920x1080:fps=25` produces 100 frames at 1920x1080 / 25 fps, i.e. 4 seconds per clip.
- `scale=8000:-1` upscales first to dodge the [zoompan jitter bug](https://trac.ffmpeg.org/ticket/4298) - costs CPU but gives smooth motion.
- `trim=duration=4` is needed *after* `zoompan`; specifying `-t 4` before the input does not work because `zoompan` ignores the input duration cap.

## Create GIFs

Looping GIF auto-scaled to 320 px wide, every 2nd frame, sped up 10x:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "select='gt(trunc(t/2),trunc(prev_t/2))',setpts='PTS*0.1',scale=trunc(oh*a/2)*2:320:force_original_aspect_ratio=decrease,pad=trunc(oh*a/2)*2:320:-1:-1" -loop 0 -an output.gif
```

- `select='gt(trunc(t/2),trunc(prev_t/2))'` keeps one frame every 2 seconds.
- `setpts='PTS*0.1'` plays the kept frames 10x faster.
- `-loop 0` loop indefinitely (default). `-loop 1` plays once.

For higher quality GIFs, generate a palette first:

```sh
ffmpeg -i input.mp4 -vf "fps=15,scale=480:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i input.mp4 -i palette.png -lavfi "fps=15,scale=480:-1:flags=lanczos [x]; [x][1:v] paletteuse" output.gif
```

## Create a video compilation from segments of one video

Pull two clips (11-15 s and 21-25 s), fade in and out each, concatenate:

```sh
ffmpeg -i https://storage.rendi.dev/sample/BigBuckBunny_320x180.mp4 -filter_complex "[0:v]trim=start=11:end=15,setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.5,fade=t=out:st=3.5:d=0.5[v1];[0:a]atrim=start=11:end=15,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=3.5:d=0.5[a1];[0:v]trim=start=21:end=25,setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.5,fade=t=out:st=3.5:d=0.5[v2];[0:a]atrim=start=21:end=25,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=3.5:d=0.5[a2];[v1][a1][v2][a2]concat=n=2:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -c:a aac output_fade_in_out.mp4
```

- Every `trim` / `atrim` is followed by `setpts=PTS-STARTPTS` / `asetpts=PTS-STARTPTS`. Without them, `concat` produces wrong durations or audio drift.
- `concat=n=2:v=1:a=1` joins 2 segments, each carrying both video and audio.

## Thumbnails

Single thumbnail at 7 s:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -ss 00:00:07 -frames:v 1 output_thumbnail.png
```

JPEG with quality control:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -ss 00:00:07 -frames:v 1 -q:v 2 output_thumbnail.jpg
```

`-q:v` 2 = best, 31 = worst.

Two thumbnails in one pass (at 5 s and 15 s):

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -filter_complex "[0:v]split=2[first][second];[first]select='gte(t,5)'[thumb1];[second]select='gte(t,15)'[thumb2]" -map [thumb1] -frames:v 1 output_thumbnail_1.png -map [thumb2] -frames:v 1 output_thumbnail_2.png
```

Thumbnail at the first scene change:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "select='gt(scene,0.4)'" -frames:v 1 -q:v 2 thumbnail_scene.jpg
```

`gt(scene,0.4)` measures inter-frame change. Lower threshold = more sensitive. Useful range: 0.3-0.5.

## Composite thumbnail from multiple images

```sh
ffmpeg -i https://storage.rendi.dev/sample/bbb-splash.png -i https://storage.rendi.dev/sample/rodents.png -i https://storage.rendi.dev/sample/evil-frank.png -filter_complex "[1]scale=640:360,pad=648:368:4:4:black[overlay1];[2]scale=640:360,pad=648:368:4:4:black[overlay2];[0][overlay1]overlay=0:main_h-overlay_h[tmp1];[tmp1][overlay2]overlay=main_w-overlay_w:main_h-overlay_h" -frames:v 1 thumbnail_overlayed.png
```

## Storyboards

2x2 storyboard from scene changes:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "select='gt(scene,0.4)',scale=640:480,tile=2X2" -frames:v 1 scene_storyboard.jpg
```

One image per scene change:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "select='gt(scene,0.4)'" -vsync 0 scene_storyboard_%03d.jpg
```

🛠️ `-vsync 0` drops frames in the same scene so duplicates do not pile up. `-vsync` is deprecated; on recent FFmpeg builds prefer `-fps_mode passthrough`.

Tile keyframes only:

```sh
ffmpeg -skip_frame nokey -i https://storage.rendi.dev/sample/big_buck_bunny_720p.mp4 -vf 'scale=640:480,tile=4x4' -an -vsync 0 keyframes%03d.png
```

`-skip_frame nokey` only decodes keyframes - very fast for long videos.

4x2 tile from every 10th frame:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -vf "select=not(mod(n\,10)),scale=640:480,tile=4x2" -vsync 0 tile_4_2_frames_10_%03d.png
```

Drop `,tile=4x2` to emit one image per kept frame instead.
