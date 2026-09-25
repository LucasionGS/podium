import type { AudioDevice, AudioSettings as Audio } from '@shared/ipc'
import { Select } from '@/ui/Field'
import { updateSettings, useApp } from '@/store/app'
import { Group, Row } from './Row'

function DeviceSelect({
  value,
  devices,
  label,
  onChange
}: {
  value: string | null
  devices: AudioDevice[]
  label: string
  onChange: (id: string | null) => void
}) {
  // A device that is unplugged right now stays selectable, so the choice isn't silently lost.
  const missing = value && !devices.some((d) => d.id === value)
  return (
    <Select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-72 flex-none"
      aria-label={label}
    >
      <option value="">Don’t record</option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
      {missing && <option value={value}>{value.replace(/^device:/, '')} (not connected)</option>}
    </Select>
  )
}

export function AudioSettings() {
  const audio = useApp((s) => s.settings!.audio)
  const devices = useApp((s) => s.capabilities?.audioDevices ?? [])
  const set = (patch: Partial<Audio>): void => void updateSettings({ audio: { ...audio, ...patch } })
  return (
    <>
      <Group title="Tracks">
        <Row label="Desktop and game audio" hint="Everything you hear. Recorded as its own track.">
          <DeviceSelect
            label="Desktop audio"
            value={audio.desktop}
            devices={devices.filter((d) => d.kind === 'output')}
            onChange={(desktop) => set({ desktop })}
          />
        </Row>
        <Row label="Microphone" hint="A separate track, so you can turn yourself down (or off) per clip.">
          <DeviceSelect
            label="Microphone"
            value={audio.mic}
            devices={devices.filter((d) => d.kind === 'input')}
            onChange={(mic) => set({ mic })}
          />
        </Row>
      </Group>
      <p className="text-xs leading-relaxed text-muted">
        Exports mix the tracks together at the volumes you set in the player, so shared clips play everywhere.
        “Keep audio tracks” exports them separately for editing.
      </p>
    </>
  )
}
