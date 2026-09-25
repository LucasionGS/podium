# Podium — notes for coding agents

Electron game clipper (a local-first Medal alternative). Read `README.md` → Architecture first.
Stack and look are shared with Edion (`~/development/edion`); copy patterns from there before inventing new ones.

## Commands

- `pnpm typecheck`, `pnpm test` (core unit tests), `pnpm test:e2e` (builds, then drives the app offscreen), `pnpm format`.
- Never launch the app visibly to check something. Use the offscreen hooks (invisible, muted, throwaway profile):
  `PODIUM_BACKEND=fake PODIUM_LIBRARY_DIR=/tmp/lib PODIUM_SCREENSHOT=/tmp/out.png [PODIUM_DEBUG_SCRIPT=/tmp/script.js] pnpm exec electron .`
  after `pnpm exec electron-vite build`. The debug script runs in the page (it has `window.podium`); what it resolves
  with is printed as `[script] …`. Automated runs don't register global hotkeys or create a tray icon.
- `PODIUM_BACKEND=fake` renders test-pattern clips with two audio tracks. `PODIUM_REAL_CAPTURE=1` lets an offscreen
  run use gpu-screen-recorder for real; `PODIUM_USER_DATA=<dir>` runs against a given profile (e.g. a copy of the user's).
- Offscreen runs don't cover startup, the tray or hotkeys. Before saying something works, also launch it for real
  (`PODIUM_USER_DATA=<copy> PODIUM_LIBRARY_DIR=<scratch> setsid pnpm exec electron . &`) and check from outside:
  `hyprctl clients -j` (window), `pgrep -af gpu-screen-recorder`, `hyprctl binds -j` (hotkeys), `dbus-monitor` (notifications).
  Press hotkeys with `ydotool key 56:1 67:1 67:0 56:0` (Alt+F9); `wtype` input never reaches Hyprland binds.
  Stop it with SIGTERM and check that gsr, the binds and `$XDG_RUNTIME_DIR/podium-*` are gone.
- `~/.config/Podium` may hold settings from an older prototype; `normalizeSettings` must keep accepting anything.

## Rules of the codebase

- `src/core` stays pure (no DOM, Electron or Node imports) and every behaviour change there gets a unit test.
- IPC is typed in `src/shared/ipc.ts`; add the channel there, then the main handler, then the preload bridge.
- The renderer only reads files through `podium-file://` (`clip/<id>`, `thumb/<id>`, `game-icon/<id>`,
  `game-hero/<id>`, `cache/<path>`). Never widen it to arbitrary paths.
- Anything that captures goes behind `CaptureBackend`; Windows gets its own backend, not branches in `gsr.ts`.
- Clip files are the source of truth; `library.json` is an index that `reconcileLibrary` rebuilds from the folder.
- Prettier reformats on `pnpm format`; match its output when patching files.
