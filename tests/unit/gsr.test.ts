import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import {
  buildGsrArgs,
  bufferFootprint,
  clampBuffer,
  parseAudioDevices,
  parseInfo,
  parseMonitors,
  parseReplies
} from '@core/capture/gsr'

const launch = {
  capture: DEFAULT_SETTINGS.capture,
  audio: DEFAULT_SETTINGS.audio,
  monitor: 'DP-2',
  outputDir: '/tmp/stage',
  ipcPath: '/run/user/1000/podium-gsr.sock'
}

describe('buildGsrArgs', () => {
  it('builds a CBR replay buffer with one audio track per source', () => {
    const args = buildGsrArgs(launch)
    const flag = (name: string): string | undefined => args[args.indexOf(name) + 1]
    expect(flag('-w')).toBe('DP-2')
    expect(flag('-r')).toBe('120')
    expect(flag('-bm')).toBe('cbr')
    expect(flag('-q')).toBe('40000')
    expect(flag('-c')).toBe('mp4')
    expect(flag('-ipc')).toBe(launch.ipcPath)
    expect(args.filter((a) => a === '-a')).toHaveLength(2)
    expect(args).toContain('default_output')
    expect(args).toContain('default_input')
  })

  it('leaves out disabled audio sources', () => {
    const args = buildGsrArgs({ ...launch, audio: { desktop: 'default_output', mic: null } })
    expect(args.filter((a) => a === '-a')).toHaveLength(1)
  })

  it('clamps the buffer length', () => {
    expect(clampBuffer(1)).toBe(5)
    expect(clampBuffer(99_999)).toBe(1800)
    const args = buildGsrArgs({ ...launch, capture: { ...launch.capture, bufferSeconds: 0 } })
    expect(args[args.indexOf('-r') + 1]).toBe('5')
  })

  it('estimates the buffer footprint', () => {
    // 120 s × (40000 + 2×160) kbps / 8 ≈ 605 MB
    expect(Math.round(bufferFootprint(DEFAULT_SETTINGS.capture, 2) / 1e6)).toBe(605)
  })
})

describe('gsr output parsing', () => {
  it('parses monitors and skips non-monitor capture options', () => {
    expect(parseMonitors('window\nportal\nDP-1|1920x1080\nHDMI-A-1|2560x1440\n')).toEqual([
      { id: 'DP-1', width: 1920, height: 1080 },
      { id: 'HDMI-A-1', width: 2560, height: 1440 }
    ])
  })

  it('maps audio devices to -a source ids', () => {
    const devices = parseAudioDevices(
      [
        'default_output|Default output',
        'default_input|Default input',
        'alsa_output.pci-0000_0c_00.4.analog-stereo.monitor|Monitor of Starship Analog Stereo',
        'alsa_input.usb-Blue_Yeti-00.analog-stereo|Yeti Stereo Microphone'
      ].join('\n')
    )
    expect(devices.map((d) => [d.id, d.kind])).toEqual([
      ['default_output', 'output'],
      ['default_input', 'input'],
      ['device:alsa_output.pci-0000_0c_00.4.analog-stereo.monitor', 'output'],
      ['device:alsa_input.usb-Blue_Yeti-00.analog-stereo', 'input']
    ])
    expect(devices[3]!.label).toBe('Yeti Stereo Microphone')
  })

  it('parses --info sections', () => {
    const info = parseInfo(
      [
        'section=system_info',
        'display_server|wayland',
        'section=gpu_info',
        'vendor|nvidia',
        'section=video_codecs',
        'h264',
        'hevc',
        'av1',
        'vp9',
        'section=capture_options',
        'window',
        'DP-2|1920x1080'
      ].join('\n')
    )
    expect(info).toEqual({
      displayServer: 'wayland',
      gpuVendor: 'nvidia',
      codecs: ['h264', 'hevc', 'av1'],
      monitors: [{ id: 'DP-2', width: 1920, height: 1080 }]
    })
  })

  it('splits IPC replies and keeps partial lines', () => {
    const { replies, rest } = parseReplies(
      '{"id":1,"result":"ok","data":"/a.mp4"}\nnot json\n{"id":2,"result":"error","data":"nope"}\n{"id":3'
    )
    expect(replies).toEqual([
      { id: 1, result: 'ok', data: '/a.mp4' },
      { id: 2, result: 'error', data: 'nope' }
    ])
    expect(rest).toBe('{"id":3')
  })
})
