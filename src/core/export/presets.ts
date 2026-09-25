import type { ExportPreset, ExportQuality } from '@shared/ipc'

export interface EncoderSpec {
  name: string
  globalArgs: string[]
  filterSuffix: string
  pixelFormat: string | null
  codecArgs: Record<ExportQuality, string[]>
}

export interface ExportPlanInput {
  preset: ExportPreset
  input: string
  output: string
  start: number
  end: number
  /** Linear gain per audio track, in stream order; the track count is its length. */
  volumes: number[]
  trackTitles: string[]
  width: number
  height: number
  fps: number
  encoder: EncoderSpec
}

export const PRESETS: Record<ExportPreset, { label: string; hint: string; extension: string }> = {
  discord: { label: 'Discord (under 10 MB)', hint: 'Fits the free upload limit', extension: 'mp4' },
  high: { label: 'High quality', hint: 'Full resolution, audio mixed', extension: 'mp4' },
  tracks: { label: 'Keep audio tracks', hint: 'Full quality, tracks stay separate', extension: 'mp4' },
  gif: { label: 'GIF', hint: '480p, 15 fps, no sound', extension: 'gif' }
}

/** Discord's free upload limit is 10 MB; aim a little under to leave room for the container. */
export const DISCORD_TARGET_BYTES = 9.5 * 1000 * 1000

export interface DiscordPlan {
  videoKbps: number
  audioKbps: number
  height: number
  fps: number
}

/** Bitrate that makes the clip fit in the target size, and a resolution that still looks decent at it. */
export function planDiscord(duration: number, height: number, fps: number, hasAudio: boolean): DiscordPlan {
  const seconds = Math.max(0.5, duration)
  const audioKbps = hasAudio ? (seconds > 120 ? 64 : 128) : 0
  const totalKbps = (DISCORD_TARGET_BYTES * 8) / 1000 / seconds
  const videoKbps = Math.max(100, Math.floor(totalKbps * 0.97 - audioKbps))
  const cap = videoKbps >= 2500 ? 1080 : videoKbps >= 1200 ? 720 : videoKbps >= 600 ? 480 : 360
  return { videoKbps, audioKbps, height: even(Math.min(height, cap)), fps: Math.min(fps || 60, 60) }
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
const seconds = (n: number): string => n.toFixed(3)

/**
 * Audio filter graph: each track gets its volume; muted tracks are dropped entirely. With `mix`,
 * the rest are summed into `[aout]`, otherwise each stays its own labelled output `[a0]`, `[a1]`…
 */
export function audioGraph(
  volumes: number[],
  mix: boolean
): { graph: string[]; outputs: string[]; kept: number[] } {
  const kept = volumes.flatMap((v, i) => (v > 0 ? [i] : []))
  if (!kept.length) return { graph: [], outputs: [], kept }
  const graph = kept.map((i) => `[0:a:${i}]volume=${volumes[i]!.toFixed(3)}[a${i}]`)
  if (!mix || kept.length === 1) return { graph, outputs: kept.map((i) => `[a${i}]`), kept }
  graph.push(
    `${kept.map((i) => `[a${i}]`).join('')}amix=inputs=${kept.length}:normalize=0:duration=longest[aout]`
  )
  return { graph, outputs: ['[aout]'], kept }
}

/** Bitrate-targeted options per encoder family (used when the file size matters more than quality). */
function bitrateArgs(encoder: EncoderSpec, kbps: number): string[] {
  const rate = [`-b:v`, `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.2)}k`, '-bufsize', `${kbps * 2}k`]
  if (encoder.name.includes('nvenc')) return ['-preset', 'p5', '-rc', 'vbr', ...rate]
  if (encoder.name === 'libx264') return ['-preset', 'medium', ...rate]
  if (encoder.name.includes('vaapi')) return ['-rc_mode', 'VBR', ...rate]
  return rate
}

/** FFmpeg arguments for an export (without the binary, with `-progress pipe:1` for progress parsing). */
export function buildExportArgs(p: ExportPlanInput): string[] {
  const start = Math.max(0, p.start)
  const duration = Math.max(0.05, p.end - start)
  const head = ['-y', '-nostdin', '-progress', 'pipe:1', '-nostats']
  // Seeking before -i is fast, and still frame-exact because we re-encode.
  const input = ['-ss', seconds(start), '-t', seconds(duration), '-i', p.input]

  if (p.preset === 'gif') {
    const graph = `[0:v]fps=15,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[pal];[s1][pal]paletteuse=dither=bayer:bayer_scale=5[v]`
    return [...head, ...input, '-filter_complex', graph, '-map', '[v]', '-an', '-loop', '0', p.output]
  }

  const mix = p.preset !== 'tracks'
  const audio = audioGraph(p.volumes, mix)
  const discord =
    p.preset === 'discord' ? planDiscord(duration, p.height, p.fps, audio.kept.length > 0) : null

  const videoFilters: string[] = []
  if (discord && discord.height < p.height) videoFilters.push(`scale=-2:${discord.height}`)
  if (discord && p.fps > discord.fps) videoFilters.push(`fps=${discord.fps}`)
  const suffix = p.encoder.filterSuffix.replace(/^,/, '')
  if (suffix) videoFilters.push(suffix)
  const graph = [`[0:v]${videoFilters.length ? videoFilters.join(',') : 'null'}[v]`, ...audio.graph]

  const args = [...head, ...p.encoder.globalArgs, ...input, '-filter_complex', graph.join(';'), '-map', '[v]']
  for (const out of audio.outputs) args.push('-map', out)
  args.push('-c:v', p.encoder.name)
  args.push(...(discord ? bitrateArgs(p.encoder, discord.videoKbps) : p.encoder.codecArgs.high))
  if (p.encoder.pixelFormat) args.push('-pix_fmt', p.encoder.pixelFormat)
  if (audio.outputs.length) {
    args.push('-c:a', 'aac', '-b:a', `${discord ? discord.audioKbps : 192}k`)
    if (!mix) {
      audio.kept.forEach((track, i) => {
        const title = p.trackTitles[track]
        if (title) args.push(`-metadata:s:a:${i}`, `title=${title}`)
      })
    }
  } else {
    args.push('-an')
  }
  args.push('-movflags', '+faststart', p.output)
  return args
}

/** Parses FFmpeg's `-progress` key=value stream into seconds done, or null for other lines. */
export function progressSeconds(line: string): number | null {
  const match = /^out_time_(us|ms)=(\d+)/.exec(line.trim())
  // FFmpeg reports out_time_ms in microseconds too (a long-standing naming bug).
  return match ? Number(match[2]) / 1_000_000 : null
}
