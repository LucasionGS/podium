import type { AudioDevice, AudioSettings, CaptureSettings, Monitor, VideoCodec } from '@shared/ipc'

export interface GsrLaunch {
  capture: CaptureSettings
  audio: AudioSettings
  /** Resolved monitor name; `CaptureSettings.monitor` may be null (= "whichever has focus"). */
  monitor: string
  outputDir: string
  ipcPath: string
}

export const MIN_BUFFER_SECONDS = 5
export const MAX_BUFFER_SECONDS = 30 * 60

export const clampBuffer = (seconds: number): number =>
  Math.round(Math.min(MAX_BUFFER_SECONDS, Math.max(MIN_BUFFER_SECONDS, seconds)))

/** Command line for a gpu-screen-recorder replay buffer controlled over its IPC socket. */
export function buildGsrArgs({ capture, audio, monitor, outputDir, ipcPath }: GsrLaunch): string[] {
  const args = [
    '-w',
    monitor,
    '-f',
    String(Math.max(1, Math.round(capture.fps))),
    '-c',
    'mp4',
    '-k',
    capture.codec,
    // Constant bitrate keeps the buffer's RAM/disk use predictable in high-motion scenes.
    '-bm',
    'cbr',
    '-q',
    String(Math.max(1000, Math.round(capture.bitrateKbps))),
    '-r',
    String(clampBuffer(capture.bufferSeconds)),
    '-replay-storage',
    capture.storage,
    '-cursor',
    capture.cursor ? 'yes' : 'no',
    // Saves start on a keyframe, so a short interval keeps "last 10 s" close to 10 s.
    '-keyint',
    '1',
    // AAC plays everywhere a clip gets shared; opus in mp4 does not.
    '-ac',
    'aac'
  ]
  // One -a per source gives one audio track per source, so the mic can be adjusted per clip.
  for (const source of [audio.desktop, audio.mic]) {
    if (source) args.push('-a', source)
  }
  args.push('-o', outputDir, '-ipc', ipcPath)
  return args
}

/** Estimated memory (or disk) used by a full buffer, in bytes. */
export function bufferFootprint(capture: CaptureSettings, audioTracks: number): number {
  const kbps = capture.bitrateKbps + audioTracks * 160
  return (clampBuffer(capture.bufferSeconds) * kbps * 1000) / 8
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/** `--list-monitors` / `--list-capture-options`: `DP-1|1920x1080` lines (other capture options are skipped). */
export function parseMonitors(text: string): Monitor[] {
  const monitors: Monitor[] = []
  for (const line of lines(text)) {
    const match = /^([^|]+)\|(\d+)x(\d+)/.exec(line)
    if (match) monitors.push({ id: match[1]!, width: Number(match[2]), height: Number(match[3]) })
  }
  return monitors
}

/**
 * `--list-audio-devices`: `name|description` lines. Ids are returned in the form `-a` accepts:
 * `default_output`/`default_input` as is, everything else as `device:<name>`.
 */
export function parseAudioDevices(text: string): AudioDevice[] {
  const devices: AudioDevice[] = []
  for (const line of lines(text)) {
    const bar = line.indexOf('|')
    const name = bar === -1 ? line : line.slice(0, bar)
    const label = bar === -1 ? line : line.slice(bar + 1)
    const isDefault = name === 'default_output' || name === 'default_input'
    const kind = name === 'default_output' || name.endsWith('.monitor') ? 'output' : 'input'
    devices.push({ id: isDefault ? name : `device:${name}`, label, kind })
  }
  return devices
}

export interface GsrInfo {
  displayServer: string | null
  gpuVendor: string | null
  codecs: VideoCodec[]
  monitors: Monitor[]
}

const CODECS: VideoCodec[] = ['h264', 'hevc', 'av1']

/** `--info`: `section=<name>` headers followed by `key|value` or bare-value lines. */
export function parseInfo(text: string): GsrInfo {
  const sections = new Map<string, string[]>()
  let current = ''
  for (const line of lines(text)) {
    const header = /^section=(.+)$/.exec(line)
    if (header) {
      current = header[1]!
      sections.set(current, [])
    } else {
      sections.get(current)?.push(line) ?? sections.set(current, [line])
    }
  }
  const value = (section: string, key: string): string | null => {
    const line = sections.get(section)?.find((l) => l.startsWith(`${key}|`))
    return line ? line.slice(key.length + 1) : null
  }
  const codecs = new Set(sections.get('video_codecs') ?? [])
  return {
    displayServer: value('system_info', 'display_server'),
    gpuVendor: value('gpu_info', 'vendor'),
    codecs: CODECS.filter((c) => codecs.has(c)),
    monitors: parseMonitors((sections.get('capture_options') ?? []).join('\n'))
  }
}

export interface GsrRequest {
  id: number
  name: 'save-replay' | 'set-paused' | 'stop'
  data?: unknown
}

export interface GsrReply {
  id: number
  result: 'ok' | 'error'
  data?: unknown
}

/** Splits a socket stream into complete newline-terminated JSON replies; returns the unfinished tail. */
export function parseReplies(buffer: string): { replies: GsrReply[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const replies: GsrReply[] = []
  for (const part of parts) {
    if (!part.trim()) continue
    try {
      const reply = JSON.parse(part) as GsrReply
      if (typeof reply.id === 'number') replies.push(reply)
    } catch {
      // A malformed line can't be matched to a request; its request times out instead.
    }
  }
  return { replies, rest }
}
