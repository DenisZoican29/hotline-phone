# Hotline Answering Machine

A Hotline Miami–style cassette player for the iPhone (installable web app, works offline). One button plays a random voice line, the other a random song.

- **▶ / ⏸**: plays random songs back to back; press again to pause, and again to resume.
- **⏮ / ⏭**: previous and next song. Previous restarts the song once it has played a few seconds.
- **Double-tap ⏭**: plays a random voice line over the music, which goes quieter underneath. Every line plays once before any repeats.
- **≡ (faint button on the right edge)**: opens a list of songs and voice lines; untick any you don't want played. The choice is remembered on the phone.
- The app always shows in landscape: held upright, the screen turns on its side.

The voice lines and sound effects are generated locally (Windows text-to-speech plus synthesis). No game audio is included.

## Layout

- `app/`: the website. On every push to `main`, `tools/build-site.js` copies it plus `songs/` into `_site/` and GitHub Pages publishes that.
- `app/content.json`: the voice lines. Edit the text here.
- `songs/`: songs built into the public site. Drop audio files in, commit and push. Anyone with the link can download them.
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

`build-audio.js` also loudness-matches every file in `my-songs/` into `app/audio/songs/` (git-ignored). Those copies are the ones to put in `songs/`.

Each deploy stamps `VERSION` in `sw.js` with the commit, so installed phones download the new copy (songs included). Bump `VERSION` by hand only for local or private copies.

## Private preview

`node tools/build-artifact.js` packs the app, including your songs, into `build/artifact/` for a private claude.ai preview.

## Run locally

```
python -m http.server 8080 --directory app
```
