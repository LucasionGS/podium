import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { FfmpegInfo } from '@shared/ipc'

const exec = promisify(execFile)

/** Binaries inside app.asar can't be executed; electron-builder unpacks them next to it. */
const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

let cached: FfmpegInfo | null = null
let customDir: string | null = null

export function setCustomFfmpegDir(dir: string | null): void {
  customDir = dir
  cached = null
}

async function versionOf(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ['-version'])
    return stdout.split('\n')[0]?.match(/version (\S+)/)?.[1] ?? 'unknown'
  } catch {
    return null
  }
}

export async function resolveFfmpeg(): Promise<FfmpegInfo> {
  if (cached) return cached
  const exe = process.platform === 'win32' ? '.exe' : ''
  const candidates: Array<Omit<FfmpegInfo, 'version'>> = []
  if (customDir) {
    candidates.push({
      source: 'custom',
      ffmpegPath: `${customDir}/ffmpeg${exe}`,
      ffprobePath: `${customDir}/ffprobe${exe}`
    })
  }
  if (ffmpegStatic && existsSync(unpacked(ffmpegStatic))) {
    candidates.push({
      source: 'bundled',
      ffmpegPath: unpacked(ffmpegStatic),
      ffprobePath: unpacked(ffprobeStatic.path)
    })
  }
  candidates.push({ source: 'system', ffmpegPath: `ffmpeg${exe}`, ffprobePath: `ffprobe${exe}` })

  for (const c of candidates) {
    const version = await versionOf(c.ffmpegPath)
    if (version && (await versionOf(c.ffprobePath))) return (cached = { ...c, version })
  }
  throw new Error('No working FFmpeg binary found')
}

/** System FFmpeg, if any. Static builds often lack hardware encoders, the system one may have them. */
export async function systemFfmpeg(): Promise<string | null> {
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return (await versionOf(bin)) ? bin : null
}
