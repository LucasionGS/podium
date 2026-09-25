import type { AudioSettings, CaptureSettings, VideoCodec } from '@shared/ipc'
import { clampBuffer } from './gsr'

/**
 * Windows capture: FFmpeg grabs the desktop with `ddagrab` (Desktop Duplication, frames stay on the
 * GPU) and encodes it with the GPU's encoder into a ring of one-second MPEG-TS segments. Audio comes
 * in as raw PCM over named pipes (Chromium captures system audio loopback and the microphone).
 */

export type EncoderVendor = 'nvenc' | 'amf' | 'qsv' | 'software'

/** Tried in this order; the first that encodes real ddagrab frames wins. */
export const ENCODER_VENDORS: EncoderVendor[] = ['nvenc', 'amf', 'qsv', 'software']

/** Seconds per segment. Saves cut on segment boundaries, so this is the precision of "last N seconds". */
export const SEGMENT_SECONDS = 1

export const SAMPLE_RATE = 48_000
export const CHANNELS = 2

export function encoderName(vendor: EncoderVendor, codec: VideoCodec): string | null {
  if (vendor === 'software') return codec === 'h264' ? 'libx264' : null
  // Intel and AMD encoders exist for all three codecs; NVENC too.
  return `${codec}_${vendor}`
}

/** Filters between ddagrab's D3D11 frames and the encoder. */
function videoFilter(vendor: EncoderVendor): string | null {
  if (vendor === 'nvenc' || vendor === 'amf') return null // they take D3D11 frames directly
  if (vendor === 'qsv') return 'hwmap=derive_device=qsv,format=qsv'
  return 'hwdownload,format=bgra,format=yuv420p'
}

/** Constant bitrate and a keyframe every segment, so every segment can start a clip. */
export function videoEncodeArgs(
  vendor: EncoderVendor,
  codec: VideoCodec,
  bitrateKbps: number,
  fps: number
): string[] {
  const name = encoderName(vendor, codec)
  if (!name) throw new Error(`${codec} has no ${vendor} encoder`)
  const rate = `${Math.round(bitrateKbps)}k`
  const gop = String(Math.max(1, Math.round(fps * SEGMENT_SECONDS)))
  const filter = videoFilter(vendor)
  const common = ['-g', gop, '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]
  const perVendor: Record<EncoderVendor, string[]> = {
    nvenc: ['-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-b:v', rate, '-forced-idr', '1'],
    amf: ['-usage', 'lowlatency', '-rc', 'cbr', '-b:v', rate],
    qsv: ['-preset', 'veryfast', '-b:v', rate, '-maxrate', rate],
    software: [
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-b:v',
      rate,
      '-maxrate',
      rate,
      '-bufsize',
      rate
    ]
  }
  return [...(filter ? ['-vf', filter] : []), '-c:v', name, ...perVendor[vendor], ...common]
}

/** `ddagrab` source for one monitor (its DXGI output index). */
export const ddagrabSource = (outputIndex: number, fps: number, cursor: boolean): string =>
  `ddagrab=output_idx=${outputIndex}:framerate=${Math.round(fps)}:draw_mouse=${cursor ? 1 : 0}`

export interface WindowsLaunch {
  capture: CaptureSettings
  audio: AudioSettings
  outputIndex: number
  vendor: EncoderVendor
  segmentDir: string
  /** Named pipe per enabled audio track, in track order (desktop, then mic). */
  audioPipes: string[]
}

/** Number of segment files in the ring: the buffer plus a little slack for the one being written. */
export const ringSize = (bufferSeconds: number): number =>
  Math.ceil(clampBuffer(bufferSeconds) / SEGMENT_SECONDS) + 3

export function buildWindowsArgs(l: WindowsLaunch): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y']
  args.push('-f', 'lavfi', '-i', ddagrabSource(l.outputIndex, l.capture.fps, l.capture.cursor))
  for (const pipe of l.audioPipes) {
    args.push(
      '-f',
      'f32le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      String(CHANNELS),
      '-thread_queue_size',
      '4096',
      '-i',
      pipe
    )
  }
  args.push('-map', '0:v')
  l.audioPipes.forEach((_, i) => args.push('-map', `${i + 1}:a`))
  args.push(...videoEncodeArgs(l.vendor, l.capture.codec, l.capture.bitrateKbps, l.capture.fps))
  if (l.audioPipes.length) args.push('-c:a', 'aac', '-b:a', '160k')
  args.push(
    '-f',
    'segment',
    '-segment_time',
    String(SEGMENT_SECONDS),
    '-segment_format',
    'mpegts',
    '-segment_wrap',
    String(ringSize(l.capture.bufferSeconds)),
    '-reset_timestamps',
    '1',
    `${l.segmentDir.replace(/\\/g, '/')}/seg%05d.ts`
  )
  return args
}

/** Test encode used to find a working encoder: a few real desktop frames, thrown away. */
export function probeArgs(vendor: EncoderVendor, codec: VideoCodec, outputIndex: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    ddagrabSource(outputIndex, 10, false),
    '-frames:v',
    '5',
    ...videoEncodeArgs(vendor, codec, 5000, 10),
    '-f',
    'null',
    '-'
  ]
}

export interface Segment {
  path: string
  size: number
  mtimeMs: number
}

/**
 * The newest segments that cover the last `seconds` (all of them for null). Empty files are skipped:
 * the ring reuses names, and a file that was just truncated has nothing in it yet.
 */
export function pickSegments(segments: Segment[], seconds: number | null): Segment[] {
  const ordered = segments.filter((s) => s.size > 0).sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (seconds === null) return ordered
  // +1: the newest segment is still being written and holds less than a full segment.
  const count = Math.ceil(seconds / SEGMENT_SECONDS) + 1
  return ordered.slice(-count)
}

/** A concat demuxer list; single quotes in paths are escaped the way FFmpeg expects. */
export const concatList = (paths: string[]): string =>
  paths.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n'

/** `reg query` output → the value of `name` (REG_DWORD as a number, REG_SZ as a string). */
export function parseRegValue(stdout: string, name: string): string | number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line)
    if (!match || match[1]!.toLowerCase() !== name.toLowerCase()) continue
    const value = match[3]!.trim()
    if (match[2] === 'REG_DWORD' || match[2] === 'REG_QWORD') return Number.parseInt(value, 16)
    return value
  }
  return null
}
