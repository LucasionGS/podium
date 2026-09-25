import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { ExportQuality, ResolvedEncoder } from '@shared/ipc'
import { resolveFfmpeg, systemFfmpeg } from './paths'

const exec = promisify(execFile)
const VAAPI_DEVICE = '/dev/dri/renderD128'

type Template = Omit<ResolvedEncoder, 'ffmpegPath'>
const q = (high: string[], medium: string[], low: string[]): Record<ExportQuality, string[]> => ({
  high,
  medium,
  low
})

const SOFTWARE: Template = {
  name: 'libx264',
  label: 'Software (x264)',
  hardware: false,
  globalArgs: [],
  filterSuffix: '',
  pixelFormat: 'yuv420p',
  codecArgs: q(
    ['-preset', 'medium', '-crf', '17'],
    ['-preset', 'medium', '-crf', '21'],
    ['-preset', 'fast', '-crf', '26']
  )
}

const HARDWARE: Record<string, Template[]> = {
  all: [
    {
      name: 'h264_nvenc',
      label: 'NVIDIA NVENC',
      hardware: true,
      globalArgs: [],
      filterSuffix: '',
      pixelFormat: 'yuv420p',
      codecArgs: q(
        ['-preset', 'p6', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
        ['-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
        ['-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-b:v', '0']
      )
    },
    {
      name: 'h264_qsv',
      label: 'Intel Quick Sync',
      hardware: true,
      globalArgs: [],
      filterSuffix: '',
      pixelFormat: 'nv12',
      codecArgs: q(['-global_quality', '19'], ['-global_quality', '23'], ['-global_quality', '28'])
    }
  ],
  linux: [
    {
      name: 'h264_vaapi',
      label: 'VAAPI (GPU)',
      hardware: true,
      globalArgs: ['-vaapi_device', VAAPI_DEVICE],
      filterSuffix: ',format=nv12,hwupload',
      pixelFormat: null,
      codecArgs: q(
        ['-rc_mode', 'CQP', '-qp', '19'],
        ['-rc_mode', 'CQP', '-qp', '23'],
        ['-rc_mode', 'CQP', '-qp', '28']
      )
    }
  ],
  win32: [
    {
      name: 'h264_amf',
      label: 'AMD AMF',
      hardware: true,
      globalArgs: [],
      filterSuffix: '',
      pixelFormat: 'yuv420p',
      codecArgs: q(
        ['-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20'],
        ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24'],
        ['-quality', 'speed', '-rc', 'cqp', '-qp_i', '27', '-qp_p', '29']
      )
    }
  ],
  darwin: [
    {
      name: 'h264_videotoolbox',
      label: 'Apple VideoToolbox',
      hardware: true,
      globalArgs: [],
      filterSuffix: '',
      pixelFormat: 'yuv420p',
      codecArgs: q(['-q:v', '70'], ['-q:v', '58'], ['-q:v', '45'])
    }
  ]
}

/** Listing an encoder proves nothing (no GPU, no driver…), so each candidate has to encode a few real frames. */
async function works(ffmpegPath: string, encoder: Template): Promise<boolean> {
  if (encoder.name === 'h264_vaapi' && !existsSync(VAAPI_DEVICE)) return false
  try {
    await exec(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...encoder.globalArgs,
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=640x360:r=30:d=0.2',
        '-vf',
        `format=${encoder.pixelFormat ?? 'nv12'}${encoder.pixelFormat ? '' : ',hwupload'}`,
        '-c:v',
        encoder.name,
        ...encoder.codecArgs.medium,
        '-f',
        'null',
        '-'
      ],
      { timeout: 15000 }
    )
    return true
  } catch {
    return false
  }
}

let detection: Promise<ResolvedEncoder[]> | null = null

/** Working encoders, hardware first, software always last. Static builds rarely include GPU encoders, so the system FFmpeg is probed too. */
export function detectEncoders(): Promise<ResolvedEncoder[]> {
  detection ??= (async () => {
    const primary = (await resolveFfmpeg()).ffmpegPath
    const system = await systemFfmpeg()
    const binaries = [...new Set([primary, ...(system ? [system] : [])])]
    const candidates = [...(HARDWARE[process.platform] ?? []), ...HARDWARE['all']!]
    const found: ResolvedEncoder[] = []
    for (const encoder of candidates) {
      for (const ffmpegPath of binaries) {
        const listed = await exec(ffmpegPath, ['-hide_banner', '-encoders']).then(
          (r) => r.stdout.includes(` ${encoder.name} `),
          () => false
        )
        if (listed && (await works(ffmpegPath, encoder))) {
          found.push({ ...encoder, ffmpegPath })
          break
        }
      }
    }
    // NVENC beats the generic APIs when several work.
    found.sort((a, b) => Number(b.name.includes('nvenc')) - Number(a.name.includes('nvenc')))
    return [...found, { ...SOFTWARE, ffmpegPath: primary }]
  })()
  return detection
}

export const resetEncoderDetection = (): void => void (detection = null)
