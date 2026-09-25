import { spawn } from 'node:child_process'
import { resolveFfmpeg } from './paths'

/** Runs background FFmpeg work a few at a time so imports never starve playback. */
class JobQueue {
  private running = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly concurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    try {
      return await task()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}

export const backgroundJobs = new JobQueue(2)

export interface FfmpegRun {
  args: string[]
  /** Receives stdout chunks; when omitted stdout is discarded. */
  onStdout?: (chunk: Buffer) => void
  signal?: AbortSignal
}

export async function runFfmpeg({ args, onStdout, signal }: FfmpegRun): Promise<void> {
  const { ffmpegPath } = await resolveFfmpeg()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
      stdio: ['ignore', onStdout ? 'pipe' : 'ignore', 'pipe'],
      signal
    })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    if (onStdout) child.stdout?.on('data', onStdout)
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${stderr.trim()}`))
    )
  })
}
