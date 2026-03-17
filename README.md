# PhotoFrame

PhotoFrame is a Tauri desktop app that rotates images from a configured directory at a fixed interval.

## Features

- Resizable desktop window
- Persistent window size and placement
- Offscreen window-state protection on launch
- JSON-backed settings for directory path and interval seconds
- Random slideshow rotation for `.jpg`, `.jpeg`, `.gif`, `.png`, and `.webp`
- Full-image scaling using aspect-ratio-preserving fit behavior

## Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the desktop app:

   ```bash
   npm run tauri dev
   ```

## Settings Storage

The application stores its settings and window state in the platform app config directory.

- `settings.json`
- `window-state.json`
