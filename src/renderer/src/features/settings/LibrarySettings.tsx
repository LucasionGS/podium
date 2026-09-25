import { FolderOpen } from 'lucide-react'
import { Button } from '@/ui/Button'
import { formatBytes } from '@/lib/format'
import { updateSettings, useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { Group, Row } from './Row'

export function LibrarySettings() {
  const info = useApp((s) => s.info)
  const custom = useApp((s) => s.settings!.libraryDir)
  const clips = useLibrary((s) => s.clips)
  const total = clips.reduce((sum, c) => sum + c.size, 0)
  const folder = custom ?? info?.libraryDir ?? ''

  const choose = async (): Promise<void> => {
    const dir = await window.podium.dialog.chooseFolder()
    if (!dir) return
    await updateSettings({ libraryDir: dir })
    useApp.setState({ info: await window.podium.app.info() })
  }

  return (
    <Group title="Clips folder">
      <Row
        label="Save clips to"
        hint={
          <span className="break-all select-text">
            {folder}
            <br />
            Each game gets its own folder. Files you add or delete there show up in Podium.
          </span>
        }
      >
        <Button onClick={() => void choose()}>
          <FolderOpen size={13} />
          Change…
        </Button>
      </Row>
      {custom && (
        <Row label="Use the default folder" hint="Your Videos folder, in Podium.">
          <Button
            onClick={() =>
              void updateSettings({ libraryDir: null }).then(async () =>
                useApp.setState({ info: await window.podium.app.info() })
              )
            }
          >
            Reset
          </Button>
        </Row>
      )}
      <Row label="In the library" hint={`${clips.length} clips`}>
        <span className="text-xs text-muted tabular-nums">{formatBytes(total)}</span>
      </Row>
    </Group>
  )
}
