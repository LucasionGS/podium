import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'
import type { CaptureCapabilities, Monitor } from '@shared/ipc'
import { runFfmpeg } from '../ffmpeg/jobs'
import type { CaptureBackend, StartConfig } from './Backend'

const FAKE_MONITORS: Monitor[] = [
  { id: 'FAKE-1', width: 1280, height: 720, bounds: { x: 0, y: 360, width: 1280, height: 720 } },
  { id: 'FAKE-2', width: 1920, height: 1080, bounds: { x: 1280, y: 0, width: 1920, height: 1080 } }
]

/**
 * Pretend replay buffer for tests and machines without a real one (`PODIUM_BACKEND=fake`): saving
 * renders a test pattern with two sine-wave audio tracks, shaped like what gpu-screen-recorder writes.
 */
export class FakeBackend implements CaptureBackend {
  readonly kind = 'fake' as const
  private config: StartConfig | null = null
  private counter = 0

  async probe(): Promise<CaptureCapabilities> {
    return {
      backend: 'fake',
      problem: null,
      version: 'test',
      gpu: null,
      monitors: FAKE_MONITORS,
      audioDevices: [
        { id: 'default_output', label: 'Default output', kind: 'output' },
        { id: 'default_input', label: 'Default input', kind: 'input' }
      ],
      codecs: ['h264'],
      ramBuffer: true
    }
  }

  async start(config: StartConfig): Promise<void> {
    await mkdir(config.stagingDir, { recursive: true })
    this.config = config
  }

  async stop(): Promise<void> {
    this.config = null
  }

  async save(seconds: number | null): Promise<string> {
    const config = this.config
    if (!config) throw new Error('The replay buffer is not running')
    // Short clips keep tests fast; the requested length is still honoured up to 10 s.
    const duration = Math.min(10, seconds ?? config.capture.bufferSeconds)
    const output = join(config.stagingDir, `Replay_${Date.now()}_${++this.counter}.mp4`)
    const tracks = [config.audio.desktop, config.audio.mic].filter(Boolean) as string[]
    const args = ['-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${duration}`]
    tracks.forEach((_, i) =>
      args.push('-f', 'lavfi', '-i', `sine=frequency=${440 * (i + 1)}:duration=${duration}`)
    )
    args.push('-map', '0:v')
    tracks.forEach((_, i) => args.push('-map', `${i + 1}:a`))
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k')
    tracks.forEach((track, i) => args.push(`-metadata:s:a:${i}`, `title=${track}`))
    args.push('-movflags', '+faststart', output)
    await runFfmpeg({ args })
    return output
  }

  async preview(monitor: string, scratchDir: string): Promise<NativeImage | null> {
    const m = FAKE_MONITORS.find((f) => f.id === monitor)
    if (!m) return null
    await mkdir(scratchDir, { recursive: true })
    const output = join(scratchDir, `preview-${m.id}-${Date.now()}.png`)
    try {
      await runFfmpeg({
        args: ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${m.width}x${m.height}`, '-frames:v', '1', output]
      })
      return nativeImage.createFromBuffer(await readFile(output))
    } finally {
      await rm(output, { force: true })
    }
  }

  onExit(): void {}
}
