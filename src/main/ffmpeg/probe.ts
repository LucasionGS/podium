import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { MediaProbe, MediaStreamInfo } from '@shared/ipc'
import { resolveFfmpeg } from './paths'

const exec = promisify(execFile)

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined
  const [n, d] = rate.split('/').map(Number)
  if (!n || !d) return undefined
  return n / d
}

interface RawStream {
  index: number
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  pix_fmt?: string
  sample_rate?: string
  channels?: number
  tags?: { rotate?: string; title?: string; handler_name?: string }
  side_data_list?: Array<{ rotation?: number }>
  disposition?: { attached_pic?: number }
}

export async function probe(path: string): Promise<MediaProbe> {
  const { ffprobePath } = await resolveFfmpeg()
  const { stdout } = await exec(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { maxBuffer: 16 * 1024 * 1024 }
  )
  const raw = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string }
    streams?: RawStream[]
  }
  const streams: MediaStreamInfo[] = (raw.streams ?? [])
    .filter((s) => !s.disposition?.attached_pic)
    .map((s) => {
      const kind = s.codec_type === 'video' ? 'video' : s.codec_type === 'audio' ? 'audio' : 'other'
      const rotation =
        s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
        (s.tags?.rotate ? Number(s.tags.rotate) : undefined)
      return {
        index: s.index,
        kind,
        codec: s.codec_name ?? 'unknown',
        width: s.width,
        height: s.height,
        fps: parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate),
        rotation,
        pixelFormat: s.pix_fmt,
        sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
        channels: s.channels,
        title: s.tags?.title ?? s.tags?.handler_name
      }
    })
  return {
    path,
    size: (await stat(path)).size,
    duration: Number(raw.format?.duration ?? 0),
    format: raw.format?.format_name ?? 'unknown',
    streams
  }
}
