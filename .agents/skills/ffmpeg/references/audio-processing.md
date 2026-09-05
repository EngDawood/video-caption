# Audio processing

Replace, extract, mix, crossfade, and reformat audio - including the variant most useful for speech-to-text pipelines (16 kHz mono MP3).

## Replace audio in video

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -i https://storage.rendi.dev/sample/Neon_Lights_5sec.mp3 -map 0:v -map 1:a -shortest -c:v copy -c:a aac output_replace_audio.mp4
```

- `-map 0:v -map 1:a` takes video from the first input and audio from the second.
- `-shortest` ends the output when the shorter stream ends. Drop it to keep the original video length and let the audio go silent past its end.
- `-c:v copy` skips re-encoding the video. The audio is re-encoded to AAC.

## Extract audio

Encode MP4 audio to MP3:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 big_buck_bunny_720p_16sec.mp3
```

Speech-friendly extract: 16 kHz mono MP3 at 48 kbit/s, plus a muted video copy:

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -ar 16000 -ab 48k -codec:a libmp3lame -ac 1 output_extracted_audio.mp3 -map 0:v -c:v copy -an out_video_only.mp4
```

- `-ar 16000` sample rate 16 kHz - the rate most ASR models expect.
- `-b:a 48k` (alias `-ab`) audio bitrate 48 kbit/s - low and adequate for speech.
- `-ac 1` mono.
- The second output (`out_video_only.mp4`) reuses the same input but maps only video and disables audio with `-an`.

Extract AAC audio without re-encoding:

```sh
ffmpeg -i https://storage.rendi.dev/sample/popeye_talking.mp4 -map 0:a:0 -acodec copy output.aac
```

## Mix audio in video

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -i https://storage.rendi.dev/sample/Neon_Lights_5sec.mp3 -filter_complex "[1:a]volume=0.2[a1];[0:a][a1]amix=inputs=2:duration=shortest" -shortest -map 0:v -c:v copy -c:a aac output_mix_audio.mp4
```

- `[1:a]volume=0.2[a1]` lowers the second input's audio to 20% so the original audio stays audible.
- `[0:a][a1]amix=inputs=2:duration=shortest` mixes the two streams. `duration=shortest` controls the *audio* duration only; the outer `-shortest` controls the final video duration.
- Without volume changes, simplify to `-filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest"`.

## Combine MP3 tracks with fade transition

```sh
ffmpeg -i https://storage.rendi.dev/sample/Neon_Lights_5sec.mp3 -i https://storage.rendi.dev/sample/Neon%20Lights.mp3 -filter_complex "[0:a]afade=t=out:st=2:d=3[a0];[1:a]afade=t=in:st=0:d=3[a1];[a0][a1]concat=n=2:v=0:a=1" -c:a libmp3lame -q:a 2 output_gapless_fade.mp3
```

- `afade=t=out:st=2:d=3` fade out over 3 s starting at t=2 s on the first track.
- `afade=t=in:st=0:d=3` fade in over 3 s starting at t=0 s on the second track.
- `concat=n=2:v=0:a=1` concatenates 2 segments, audio only.
- `-q:a 2` libmp3lame VBR ~170-210 kbit/s stereo.

## Crossfade two MP3s

```sh
ffmpeg -i https://storage.rendi.dev/sample/Neon_Lights_5sec.mp3 -i https://storage.rendi.dev/sample/Neon%20Lights.mp3 -filter_complex "[0:0][1:0]acrossfade=d=3:c1=exp:c2=qsin" -c:a libmp3lame -q:a 2 output.mp3
```

`acrossfade=d=3:c1=exp:c2=qsin` 3-second crossfade where the first track fades out exponentially while the second fades in via a quarter-sine curve.

## Change audio format

MP3 to mono 48 kHz WAV (32-bit little-endian PCM):

```sh
ffmpeg -i https://storage.rendi.dev/sample/Neon%20Lights.mp3 -acodec pcm_s32le -ac 1 -ar 48000 output.wav
```

Merge audio from two videos, mix to mono, normalize, downsample to 16 kHz, encode as 64 kbit/s MP3:

```sh
ffmpeg -i https://storage.rendi.dev/sample/big_buck_bunny_720p_16sec.mp4 -i https://storage.rendi.dev/sample/popeye_talking.mp4 -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest,pan=mono|c0=.5*c0+.5*c1,dynaudnorm" -ar 16000 -c:a libmp3lame -b:a 64k merged_audio.mp3
```

- `pan=mono|c0=.5*c0+.5*c1` blends 50% left + 50% right into a single mono channel.
- `dynaudnorm` dynamic audio normalization - levels out loud and quiet sections.
- `duration=longest` runs out to the longer input rather than truncating.
