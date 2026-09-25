import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import {
  buildWindowsArgs,
  concatList,
  encoderName,
  parseRegValue,
  pickSegments,
  probeArgs,
  ringSize,
  videoEncodeArgs
} from '@core/capture/windows'

const launch = {
  capture: DEFAULT_SETTINGS.capture,
  audio: DEFAULT_SETTINGS.audio,
  outputIndex: 1,
  vendor: 'nvenc' as const,
  segmentDir: 'C:\\Users\\me\\Videos\\Podium\\.podium\\ring',
  audioPipes: ['\\\\.\\pipe\\podium-desktop', '\\\\.\\pipe\\podium-mic']
}

describe('Windows capture arguments', () => {
  it('grabs the chosen monitor on the GPU and writes a segment ring', () => {
    const args = buildWindowsArgs(launch)
    const flag = (name: string, from = 0): string | undefined => args[args.indexOf(name, from) + 1]
    expect(args).toContain('ddagrab=output_idx=1:framerate=60:draw_mouse=1')
    expect(flag('-c:v')).toBe('h264_nvenc')
    expect(flag('-segment_wrap')).toBe(String(ringSize(120)))
    expect(args.at(-1)).toBe('C:/Users/me/Videos/Podium/.podium/ring/seg%05d.ts')
    // Two raw PCM pipes become two audio tracks.
    expect(args.filter((a) => a === 'f32le')).toHaveLength(2)
    expect(args.filter((a) => a === '-map')).toHaveLength(3)
    expect(args).toContain('2:a')
  })

  it('leaves audio out when no track is recorded', () => {
    const args = buildWindowsArgs({ ...launch, audioPipes: [] })
    expect(args).not.toContain('-c:a')
    expect(args.filter((a) => a === '-map')).toHaveLength(1)
  })

  it('picks encoder-specific options', () => {
    expect(videoEncodeArgs('nvenc', 'hevc', 40000, 60)).toEqual(
      expect.arrayContaining(['-c:v', 'hevc_nvenc', '-b:v', '40000k', '-g', '60'])
    )
    expect(videoEncodeArgs('qsv', 'h264', 20000, 30)).toEqual(
      expect.arrayContaining(['-vf', 'hwmap=derive_device=qsv,format=qsv'])
    )
    expect(videoEncodeArgs('software', 'h264', 20000, 30)).toEqual(
      expect.arrayContaining(['-vf', 'hwdownload,format=bgra,format=yuv420p', '-c:v', 'libx264'])
    )
    expect(videoEncodeArgs('amf', 'av1', 20000, 30)).not.toContain('-vf')
    expect(encoderName('software', 'hevc')).toBeNull()
    expect(() => videoEncodeArgs('software', 'av1', 1, 1)).toThrow()
  })

  it('probes with a short, throwaway encode', () => {
    const args = probeArgs('amf', 'h264', 0)
    expect(args).toContain('h264_amf')
    expect(args.slice(-3)).toEqual(['-f', 'null', '-'])
  })
})

describe('segment ring', () => {
  const seg = (name: string, mtimeMs: number, size = 100) => ({ path: `/ring/${name}`, size, mtimeMs })
  // The ring wraps: seg00002 was rewritten last, seg00000 is the oldest.
  const ring = [
    seg('seg00001.ts', 30),
    seg('seg00002.ts', 40),
    seg('seg00000.ts', 20),
    seg('seg00003.ts', 10),
    seg('seg00004.ts', 50, 0)
  ]

  it('orders by write time and skips empty files', () => {
    expect(pickSegments(ring, null).map((s) => s.path)).toEqual([
      '/ring/seg00003.ts',
      '/ring/seg00000.ts',
      '/ring/seg00001.ts',
      '/ring/seg00002.ts'
    ])
  })

  it('takes enough of the newest segments for the requested length', () => {
    expect(pickSegments(ring, 1).map((s) => s.path)).toEqual(['/ring/seg00001.ts', '/ring/seg00002.ts'])
    expect(pickSegments(ring, 60)).toHaveLength(4)
  })

  it('writes concat lists FFmpeg can read', () => {
    expect(concatList(['C:\\a\\b.ts', "/x/it's.ts"])).toBe("file 'C:/a/b.ts'\nfile '/x/it'\\''s.ts'\n")
  })
})

describe('parseRegValue', () => {
  const out = `
HKEY_CURRENT_USER\\Software\\Valve\\Steam
    RunningAppID    REG_DWORD    0x2da
    SteamPath    REG_SZ    c:/program files (x86)/steam
`
  it('reads DWORDs and strings', () => {
    expect(parseRegValue(out, 'RunningAppID')).toBe(730)
    expect(parseRegValue(out, 'steampath')).toBe('c:/program files (x86)/steam')
    expect(parseRegValue(out, 'Missing')).toBeNull()
  })
})
