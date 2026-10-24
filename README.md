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
- **Uploads, on your terms**: send clips to your own server (by hand, or automatically as soon as they're saved) and
  get a link to share. Servers speak the open [Podium upload protocol](docs/upload-protocol.md).
- **Everything stays on your machine** unless you upload it. No account, no cloud of ours.

## Requirements

| Platform | Capture engine |
| --- | --- |
| Linux (Wayland or X11) | [GPU Screen Recorder](https://git.dec05eba.com/gpu-screen-recorder/about/): `pacman -S gpu-screen-recorder` on Arch, or `flatpak install flathub com.dec05eba.gpu_screen_recorder` |
| Windows 10/11 | FFmpeg 6+ with `ddagrab` (the bundled build is tried first; otherwise `winget install Gyan.FFmpeg`). Untested so far. |

FFmpeg is bundled for exports; a system FFmpeg with GPU encoders (NVENC, VAAPI, QSV, AMF) is used when present.

## Install

- **Arch Linux** (AUR): `podium` builds the latest release from source, `podium-bin` installs the release's
  prebuilt package, and `podium-git` builds the latest commit (update it with `yay -Syu --devel`).
  The PKGBUILDs live in `packaging/aur`; releases are pushed to the AUR by the build workflow, and
  `packaging/aur/publish.sh <package>` publishes one by hand.
- **Windows**: `Podium.Setup.<version>.exe` from the [latest release](https://github.com/LucasionGS/podium/releases/latest).
  It installs for your user only (no admin rights needed). Podium 0.2.0 and older used a different installer:
  uninstall that one first.
- **Debian and Ubuntu**: `podium_<version>_amd64.deb` from the latest release (`sudo apt install ./podium_*.deb`).
- **Other Linux distros**: the AppImage from the latest release.

Every push to `master` also builds all of these as artifacts of the run on the Actions tab.

### Updates

Podium checks GitHub for a new release when it starts and every six hours (you can turn this off in
**Settings → General**). It tells you when one is out, and **Install update** puts it in place, then offers
to restart into it:

| Installed as | How it updates |
| --- | --- |
| Windows installer | Squirrel downloads the new version in the background and swaps it in on restart. |
| AppImage | The AppImage file is replaced with the new one. |
| `.deb` / release pacman package | The new package is installed with apt or pacman through `pkexec` (your desktop asks for your password). |
| `podium`, `podium-bin` (AUR) | The AUR package is built with `makepkg`, like an AUR helper would, then installed with `pkexec pacman -U`. |
| `podium-git` (AUR) | Not updated by Podium: use `yay -Syu --devel`. |

Downloads are checked against the release's `SHA256SUMS.txt`. Podium knows how it was installed from the
`package-type` file next to its resources, which the AUR PKGBUILDs set to `aur:<package>`.

### Releasing

Bump `version` in `package.json` and push to `master`. When that version has no GitHub Release yet, the
build workflow tags the commit, publishes the installers as a GitHub Release and updates `podium` and
`podium-bin` on the AUR. A version with a `-` (`0.3.0-beta.1`) becomes a GitHub prerelease and stays off
the AUR.

### How Windows capture works

FFmpeg grabs the monitor with Desktop Duplication (`ddagrab`, frames stay on the GPU) and encodes it with
the first encoder that works on your machine (NVENC, AMF, Quick Sync, then x264) into a ring of one-second
MPEG-TS segments on disk. FFmpeg has no system-audio loopback on Windows, so a hidden page captures it
(and the microphone) through Chromium and streams raw PCM to FFmpeg over named pipes, one track each.
Saving a clip joins the newest segments without re-encoding.

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
pnpm dist:pacman  # or dist:deb, or pnpm dist for the platform's default installer
```

`PODIUM_BACKEND=fake` swaps the capture engine for one that renders a test pattern with two audio tracks,
so everything except real screen capture can be developed and tested without a GPU.

## Architecture

```
src/core      Pure TypeScript, unit tested: gpu-screen-recorder arguments and output parsing, Steam VDF,
              game matching, library reconciliation and queries, export presets, hotkey helpers.
src/main      Electron main process
  capture/    CaptureBackend interface; GsrBackend (Linux: spawns gsr, talks JSON over its IPC socket);
              WindowsBackend (FFmpeg ddagrab segment ring + audio via the hidden capture page);
              FakeBackend; CaptureManager (buffer state, restarts, the save → file → notify pipeline)
  games/      Steam library lookup and the process/window poller
  library.ts  JSON index reconciled with the clips folder; the podium-file:// protocol (Range requests
              for <video>), thumbnails, filmstrips and per-track audio for the player
  export.ts   Export queue (FFmpeg with GPU encoders, falling back to x264)
  upload/     UploadProtocol interface, the Podium protocol client and the upload queue (auto-upload, links)
  update/     Update checks against GitHub releases and one installer per install kind (Squirrel, AppImage,
              deb/pacman through pkexec, AUR packages rebuilt with makepkg)
  secrets.ts  Upload tokens, encrypted with the OS keyring (safeStorage) and kept out of settings.json
  hotkeys.ts, tray.ts, autostart.ts
src/shared    Typed IPC channels and the preload API
src/renderer  React 19 + Tailwind 4 + zustand: sidebar + clip grid, player with trim bar and
              per-track mixer, settings
```

Saving a clip: hotkey → `CaptureManager.save` → gsr `save-replay` over the IPC socket (answered once the
file is written to `<library>/.podium`) → the file is moved to `<library>/<Game>/<Game> <date>.mp4`,
indexed, thumbnailed → sound + notification.

## Uploading to your own server

Podium uploads to any server that speaks the [Podium upload protocol](docs/upload-protocol.md): plain HTTPS and
JSON, with resumable chunked uploads. [`docs/upload-reference-server.ts`](docs/upload-reference-server.ts) is a
complete server without dependencies. Run it to try uploads, or use it as a starting point for your own:

```sh
PODIUM_UPLOAD_TOKEN=secret node docs/upload-reference-server.ts   # then add http://localhost:8787 in Settings → Uploads
```

## Licence

GPL-3.0-or-later.
