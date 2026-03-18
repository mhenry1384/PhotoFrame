# AGENTS

## Build Versioning Policy

- Before running any new production build command (for example `npm run tauri build`), increment the app version by `0.0.1`.
- Keep all version references in sync:
  - `package.json` (`version`)
  - `src-tauri/tauri.conf.json` (`version`)
  - `src-tauri/Cargo.toml` (`package.version`)
  - `index.html` displayed app version label
- Apply the version bump first, then run the build.
