/**
 * Hidden audio-capture page for the Windows engine. FFmpeg has no system-audio loopback input on
 * Windows, but Chromium does: this page captures the loopback and the microphone and streams raw
 * interleaved stereo float32 PCM at 48 kHz to main, which feeds it to FFmpeg over named pipes.
 */
import type { AudioDevice, CaptureTrack } from '@shared/ipc'

declare global {
  interface Window {
    podiumCapture: { sendPcm(track: CaptureTrack, pcm: Float32Array): void }
    captureAgent: typeof agent
  }
}

const SAMPLE_RATE = 48_000
const CHUNK_FRAMES = 960 // 20 ms

/**
 * Collects render quanta into 20 ms chunks. When the input has no data it sends silence, so FFmpeg
 * always receives a steady stream (a stalled input would stall the whole recording).
 */
const WORKLET = `
class Pcm extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(${CHUNK_FRAMES * 2}); this.filled = 0 }
  process(inputs) {
    const input = inputs[0] || []
    const frames = input[0] ? input[0].length : 128
    const left = input[0], right = input[1] || input[0]
    for (let i = 0; i < frames; i++) {
      this.buffer[this.filled++] = left ? left[i] : 0
      this.buffer[this.filled++] = right ? right[i] : 0
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(${CHUNK_FRAMES * 2})
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('pcm', Pcm)
`
const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))

interface Running {
  track: CaptureTrack
  context: AudioContext
  stream: MediaStream
}

let running: Running[] = []

async function pipe(track: CaptureTrack, stream: MediaStream): Promise<Running> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  await context.audioWorklet.addModule(workletUrl)
  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    // Mono microphones are up-mixed to both channels.
    channelCount: 2,
    channelCountMode: 'explicit'
  })
  node.port.onmessage = (e: MessageEvent<Float32Array>) => window.podiumCapture.sendPcm(track, e.data)
  source.connect(node)
  // The node outputs silence; connecting it keeps the graph pulling at a steady rate.
  node.connect(context.destination)
  await context.resume()
  return { track, context, stream }
}

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

const agent = {
  async listDevices(): Promise<AudioDevice[]> {
    // Labels are only visible once the page may use the microphone; main grants that to this page.
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
    const inputs = devices.filter(
      (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
    )
    return [
      { id: 'default_output', label: 'All system audio', kind: 'output' },
      { id: 'default_input', label: 'Default microphone', kind: 'input' },
      ...inputs.map((d, i): AudioDevice => ({
        id: `device:${d.deviceId}`,
        label: d.label || `Microphone ${i + 1}`,
        kind: 'input'
      }))
    ]
  },

  /** Starts the requested tracks; resolves with the ones that actually started, with errors for the rest. */
  async start(config: {
    desktop: boolean
    mic: string | null
  }): Promise<{ started: CaptureTrack[]; errors: string[] }> {
    await agent.stop()
    const errors: string[] = []
    if (config.desktop) {
      try {
        // Main answers this with the system audio loopback; the video track isn't needed.
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        stream.getVideoTracks().forEach((t) => t.stop())
        if (!stream.getAudioTracks().length) throw new Error('No system audio track')
        running.push(await pipe('desktop', stream))
      } catch (error) {
        errors.push(`Desktop audio: ${String(error)}`)
      }
    }
    if (config.mic) {
      try {
        const deviceId = config.mic.startsWith('device:')
          ? { exact: config.mic.slice('device:'.length) }
          : undefined
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...RAW, deviceId } })
        running.push(await pipe('mic', stream))
      } catch (error) {
        errors.push(`Microphone: ${String(error)}`)
      }
    }
    return { started: running.map((r) => r.track), errors }
  },

  async stop(): Promise<void> {
    for (const r of running) {
      r.stream.getTracks().forEach((t) => t.stop())
      await r.context.close().catch(() => {})
    }
    running = []
  }
}

window.captureAgent = agent
