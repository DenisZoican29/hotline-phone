# Hotline Answering Machine

A Hotline Miami–style cassette player for the iPhone (installable web app, works offline). One button plays a random voice line, the other a random song.

- **VOICE**: plays a random line; press again to stop. Every line plays once before any repeats.
- **SONG**: plays random songs back to back; press again to stop. Music goes quieter under voice lines.
- **⏏ load songs**: pick songs from the phone. They are saved on that phone only and never uploaded.

The voice lines and sound effects are generated locally (Windows text-to-speech plus synthesis). No game audio is included, and the public site ships without songs.

## Layout

- `app/`: the website. GitHub Pages publishes this folder on every push to `main`.
- `app/content.json`: the voice lines. Edit the text here.
- `my-songs/`: your own song files (git-ignored, never published).
- `tools/`: audio generators.

## Rebuild the audio

Requires Windows (for the SAPI voices), Node, ffmpeg and Python with Pillow.

```
node tools/build-audio.js         # text-to-speech + music + sound effects -> app/audio
node tools/build-audio.js --fast  # only re-apply voice effects / re-encode
python tools/icons.py             # app icons
node tools/fetch-fonts.js         # fonts
```

`build-audio.js` also loudness-matches every file in `my-songs/` into `app/audio/songs/` (git-ignored). Those copies are the ones to put on the phone.

After changing anything in `app/`, bump `VERSION` in `app/sw.js` so installed phones download the new copy.

## Private preview

`node tools/build-artifact.js` packs the app, including your songs, into `build/artifact/` for a private claude.ai preview.

## Run locally

```
python -m http.server 8080 --directory app
```
