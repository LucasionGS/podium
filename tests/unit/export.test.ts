import { describe, expect, it } from 'vitest'
import {
  audioGraph,
  buildExportArgs,
  planDiscord,
  progressSeconds,
  type EncoderSpec
} from '@core/export/presets'

const x264: EncoderSpec = {
  name: 'libx264',
  globalArgs: [],
  filterSuffix: '',
  pixelFormat: 'yuv420p',
  codecArgs: { high: ['-crf', '17'], medium: ['-crf', '21'], low: ['-crf', '26'] }
}
const base = {
  input: '/in.mp4',
  output: '/out.mp4',
  start: 10,
  end: 40,
  volumes: [1, 0.5],
  trackTitles: ['Desktop', 'Microphone'],
  width: 2560,
  height: 1440,
  fps: 144,
  encoder: x264
}
const graphOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1]!

describe('audioGraph', () => {
  it('mixes tracks with their volumes', () => {
    const { graph, outputs } = audioGraph([1, 0.5], true)
    expect(graph).toEqual([
      '[0:a:0]volume=1.000[a0]',
      '[0:a:1]volume=0.500[a1]',
      '[a0][a1]amix=inputs=2:normalize=0:duration=longest[aout]'
    ])
    expect(outputs).toEqual(['[aout]'])
  })

  it('drops muted tracks, and everything when all are muted', () => {
    expect(audioGraph([0, 0.8], true).outputs).toEqual(['[a1]'])
    expect(audioGraph([0, 0], true).outputs).toEqual([])
    expect(audioGraph([1, 1], false).outputs).toEqual(['[a0]', '[a1]'])
  })
})

describe('planDiscord', () => {
  it('fits short clips at 1080p', () => {
    const plan = planDiscord(30, 1440, 144, true)
    // (9.5 MB × 8 / 30 s) × 0.97 − 128 kbps
    expect(plan.videoKbps).toBe(2329)
    expect(plan.height).toBe(720)
    expect(plan.fps).toBe(60)
    const short = planDiscord(10, 1080, 60, true)
    expect(short.height).toBe(1080)
    const total = ((short.videoKbps + short.audioKbps) * 1000 * 10) / 8
    expect(total).toBeLessThan(9.5e6)
  })

  it('scales long clips down and lowers audio bitrate', () => {
    const plan = planDiscord(300, 1080, 60, true)
    expect(plan.audioKbps).toBe(64)
    expect(plan.height).toBe(360)
  })
})

describe('buildExportArgs', () => {
  it('seeks, trims and mixes for high quality', () => {
    const args = buildExportArgs({ ...base, preset: 'high' })
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual([
      '-ss',
      '10.000',
      '-t',
      '30.000'
    ])
    expect(graphOf(args)).toContain('amix=inputs=2')
    expect(args).toContain('[aout]')
    expect(args).toContain('-crf')
    expect(args.at(-1)).toBe('/out.mp4')
  })

  it('keeps tracks separate with their titles', () => {
    const args = buildExportArgs({ ...base, preset: 'tracks' })
    expect(graphOf(args)).not.toContain('amix')
    expect(args.filter((a) => a === '-map')).toHaveLength(3)
    expect(args).toContain('title=Microphone')
  })

  it('scales and limits frame rate for Discord', () => {
    const args = buildExportArgs({ ...base, preset: 'discord' })
    expect(graphOf(args)).toContain('scale=-2:720,fps=60')
    expect(args).toContain('-maxrate')
    expect(args).not.toContain('-crf')
  })

  it('builds a palette GIF without audio', () => {
    const args = buildExportArgs({ ...base, preset: 'gif', output: '/out.gif' })
    expect(graphOf(args)).toContain('palettegen')
    expect(args).toContain('-an')
  })

  it('adds the encoder filter suffix (VAAPI upload)', () => {
    const vaapi = { ...x264, name: 'h264_vaapi', filterSuffix: ',format=nv12,hwupload', pixelFormat: null }
    const args = buildExportArgs({ ...base, preset: 'high', encoder: vaapi })
    expect(graphOf(args)).toContain('[0:v]format=nv12,hwupload[v]')
    expect(args).not.toContain('-pix_fmt')
  })

  it('parses progress lines', () => {
    expect(progressSeconds('out_time_us=1500000')).toBe(1.5)
    expect(progressSeconds('out_time_ms=2000000')).toBe(2)
    expect(progressSeconds('frame=10')).toBeNull()
  })
})
