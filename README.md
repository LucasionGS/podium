# Podium

An open-source, local-first game clipper — an alternative to Medal and ShadowPlay that works on Linux
(and, soon, Windows). Podium keeps the last few minutes of your screen, game audio and microphone in a
replay buffer. Press a hotkey when something great happens and the moment lands in your clip library,
ready to trim and share.

- **Instant replay buffer** in RAM (or on disk for long buffers), recorded with your GPU's video encoder.
- **Global hotkeys**: save the last 30 s, the last 2 min, or bookmark the whole buffer to review later.
- **Clip library** grouped by game, with hover previews, search, favourites and Steam artwork.
- **Game detection**: Steam and Proton games are recognised automatically, other fullscreen games by window.
- **Separate audio tracks** for desktop audio and your mic, so you can turn yourself down per clip.
- **Trim and export**: frame-exact trimming, and presets for Discord (under 10 MB), high quality, separate tracks and GIF.
- **Everything stays on your machine.** No account, no uploads.

## Requirements

| Platform | Capture engine |
| --- | --- |
| Linux (Wayland or X11) | [GPU Screen Recorder](https://git.dec05eba.com/gpu-screen-recorder/about/): `yay -S gpu-screen-recorder` on Arch, or `flatpak install flathub com.dec05eba.gpu_screen_recorder` |
| Windows | Planned for v0.2 (FFmpeg `ddagrab` + WASAPI loopback) |

FFmpeg is bundled for exports; a system FFmpeg with GPU encoders (NVENC, VAAPI, QSV, AMF) is used when present.

### Hotkeys on Wayland

Wayland doesn't let apps read the keyboard while a game has focus. On Hyprland (Lua or classic config),
Podium adds its binds to the compositor while it runs, so there's nothing to configure; keys already bound
in your config are reported in **Settings → Hotkeys** instead of being overridden. On KDE and GNOME it uses
the desktop's GlobalShortcuts portal. Anywhere else, bind `podium --clip=30` (or `--clip=120`,
`--bookmark`) to a key; it hands the request to the running Podium.

## Development

```sh
pnpm install
pnpm dev          # run with hot reload
pnpm test         # unit tests (src/core)
pnpm test:e2e     # builds, then drives the app offscreen with a fake capture engine
pnpm typecheck
pnpm dist:pacman  # or pnpm dist for the platform's default installer
```

`PODIUM_BACKEND=fake` swaps the capture engine for one that renders a test pattern with two audio tracks,
so everything except real screen capture can be developed and tested without a GPU.

## Architecture

```
src/core      Pure TypeScript, unit tested: gpu-screen-recorder arguments and output parsing, Steam VDF,
              game matching, library reconciliation and queries, export presets, hotkey helpers.
src/main      Electron main process
  capture/    CaptureBackend interface; GsrBackend (spawns gsr, talks JSON over its IPC socket);
              FakeBackend; CaptureManager (buffer state, restarts, the save → file → notify pipeline)
  games/      Steam library lookup and the process/window poller
  library.ts  JSON index reconciled with the clips folder; the podium-file:// protocol (Range requests
              for <video>), thumbnails, filmstrips and per-track audio for the player
  export.ts   Export queue (FFmpeg with GPU encoders, falling back to x264)
  hotkeys.ts, tray.ts, autostart.ts
src/shared    Typed IPC channels and the preload API
src/renderer  React 19 + Tailwind 4 + zustand: sidebar + clip grid, player with trim bar and
              per-track mixer, settings
```

Saving a clip: hotkey → `CaptureManager.save` → gsr `save-replay` over the IPC socket (answered once the
file is written to `<library>/.podium`) → the file is moved to `<library>/<Game>/<Game> <date>.mp4`,
indexed, thumbnailed → sound + notification.

## Licence

GPL-3.0-or-later.
