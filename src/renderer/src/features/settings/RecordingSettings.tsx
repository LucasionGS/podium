import { RefreshCw } from 'lucide-react'
import type { CaptureSettings, VideoCodec } from '@shared/ipc'
import { bufferFootprint } from '@core/capture/gsr'
import { Button } from '@/ui/Button'
import { Segmented, Select } from '@/ui/Field'
import { Switch } from '@/ui/Switch'
import { codecLabel, formatBytes, formatLength } from '@/lib/format'
import { refreshCapabilities, updateSettings, useApp } from '@/store/app'
import { SetupCard } from '@/features/setup/SetupCard'
import { Group, Row } from './Row'

const FRAME_RATES = [30, 60, 90, 120, 144, 165, 240]
const BUFFER_LENGTHS = [30, 60, 120, 180, 300, 600, 900, 1800]
const QUALITIES: Array<{ kbps: number; label: string }> = [
  { kbps: 15_000, label: 'Low · 15 Mbps' },
  { kbps: 25_000, label: 'Medium · 25 Mbps' },
  { kbps: 40_000, label: 'High · 40 Mbps' },
  { kbps: 70_000, label: 'Very high · 70 Mbps' },
  { kbps: 100_000, label: 'Extreme · 100 Mbps' }
]
const CODEC_HINTS: Record<VideoCodec, string> = {
  h264: 'Plays everywhere, including Discord embeds.',
  hevc: 'Smaller files at the same quality; not every browser plays it.',
  av1: 'Smallest files; needs a recent GPU and player.'
}

export function RecordingSettings() {
  const settings = useApp((s) => s.settings)!
  const caps = useApp((s) => s.capabilities)
  const status = useApp((s) => s.status)
  const capture = settings.capture
  const set = (patch: Partial<CaptureSettings>): void =>
    void updateSettings({ capture: { ...capture, ...patch } })
  const tracks = [settings.audio.desktop, settings.audio.mic].filter(Boolean).length
  const footprint = bufferFootprint(capture, tracks)
  // The Windows engine keeps its buffer as a ring of files on disk, whatever the setting says.
  const inMemory = capture.storage === 'ram' && caps?.ramBuffer !== false
  const qualities = QUALITIES.some((q) => q.kbps === capture.bitrateKbps)
    ? QUALITIES
    : [...QUALITIES, { kbps: capture.bitrateKbps, label: `Custom · ${capture.bitrateKbps / 1000} Mbps` }]

  return (
    <>
      {caps?.problem && (
        <div className="mb-7">
          <SetupCard />
        </div>
      )}
      <Group title="Replay buffer">
        <Row
          label="Keep the last"
          hint={`Held in ${inMemory ? 'memory' : 'files on disk'}: about ${formatBytes(footprint)} at this quality.`}
        >
          <Select
            value={capture.bufferSeconds}
            onChange={(e) => set({ bufferSeconds: Number(e.target.value) })}
            className="w-36 flex-none"
            aria-label="Buffer length"
          >
            {BUFFER_LENGTHS.map((s) => (
              <option key={s} value={s}>
                {formatLength(s)}
              </option>
            ))}
          </Select>
        </Row>
        {caps?.ramBuffer !== false && (
          <Row
            label="Store the buffer in"
            hint="Memory is fastest and spares your SSD. Disk suits long buffers when RAM is tight."
          >
            <div className="w-44">
              <Segmented
                value={capture.storage}
                options={[
                  { value: 'ram', label: 'Memory' },
                  { value: 'disk', label: 'Disk' }
                ]}
                onChange={(storage) => set({ storage })}
              />
            </div>
          </Row>
        )}
        <Row label="Start buffering when Podium starts">
          <Switch
            label="Start buffering when Podium starts"
            checked={settings.bufferOnLaunch}
            onChange={(bufferOnLaunch) => void updateSettings({ bufferOnLaunch })}
          />
        </Row>
      </Group>

      <Group title="Video">
        <Row label="Monitor" hint="Automatic records the monitor that has focus when the buffer starts.">
          <Select
            value={capture.monitor ?? ''}
            onChange={(e) => set({ monitor: e.target.value || null })}
            className="w-56 flex-none"
            aria-label="Monitor"
          >
            <option value="">Automatic</option>
            {caps?.monitors.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id} · {m.width}×{m.height}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Frame rate">
          <Select
            value={capture.fps}
            onChange={(e) => set({ fps: Number(e.target.value) })}
            className="w-36 flex-none"
            aria-label="Frame rate"
          >
            {FRAME_RATES.map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Quality" hint="Constant bitrate, so the buffer never grows beyond its estimate.">
          <Select
            value={capture.bitrateKbps}
            onChange={(e) => set({ bitrateKbps: Number(e.target.value) })}
            className="w-48 flex-none"
            aria-label="Quality"
          >
            {qualities.map((q) => (
              <option key={q.kbps} value={q.kbps}>
                {q.label}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Codec" hint={CODEC_HINTS[capture.codec]}>
          <div className="w-56">
            <Segmented
              value={capture.codec}
              options={(caps?.codecs.length ? caps.codecs : (['h264'] as VideoCodec[])).map((c) => ({
                value: c,
                label: codecLabel(c)
              }))}
              onChange={(codec) => set({ codec })}
            />
          </div>
        </Row>
        <Row label="Record the mouse cursor">
          <Switch
            label="Record the mouse cursor"
            checked={capture.cursor}
            onChange={(cursor) => set({ cursor })}
          />
        </Row>
      </Group>

      <Group title="Engine">
        <Row
          label={
            caps?.backend === 'gsr'
              ? 'GPU Screen Recorder'
              : caps?.backend === 'ffmpeg'
                ? 'FFmpeg Desktop Duplication'
                : caps?.backend === 'fake'
                  ? 'Test engine'
                  : 'No engine'
          }
          hint={
            caps?.backend
              ? [
                  caps.version && (caps.backend === 'ffmpeg' ? caps.version : `Version ${caps.version}`),
                  caps.gpu &&
                    (caps.backend === 'ffmpeg' ? `Encoder: ${caps.gpu}` : `${caps.gpu.toUpperCase()} GPU`)
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Nothing can record on this system yet.'
          }
        >
          <Button onClick={() => void refreshCapabilities()}>
            <RefreshCw size={13} />
            Re-detect
          </Button>
          <Button
            onClick={() => void window.podium.capture.restart()}
            disabled={!caps?.backend || status?.state === 'unavailable'}
          >
            Restart buffer
          </Button>
        </Row>
      </Group>
    </>
  )
}
