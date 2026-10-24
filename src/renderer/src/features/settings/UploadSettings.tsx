import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import type { UploadProtocolKind, UploadTarget, UploadTestResult } from '@shared/ipc'
import { isInsecureUrl, normalizeServerUrl } from '@core/upload/protocol'
import { PROTOCOLS, resolveTarget } from '@core/upload/targets'
import { Button } from '@/ui/Button'
import { Select } from '@/ui/Field'
import { Modal } from '@/ui/Modal'
import { Switch } from '@/ui/Switch'
import { updateSettings, useApp } from '@/store/app'
import { confirm } from '@/store/feedback'
import { refreshTokens, useUploads } from '@/store/uploads'
import { Group, Row } from './Row'

const SPEC_URL = 'https://github.com/LucasionGS/podium/blob/master/docs/upload-protocol.md'

const inputClass =
  'h-8 w-full rounded-md border border-line bg-bg px-2.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent'

export function UploadSettings() {
  const upload = useApp((s) => s.settings!.upload)
  const tokens = useUploads((s) => s.tokens)
  // null: closed; 'new': adding; a target: editing it.
  const [editing, setEditing] = useState<UploadTarget | 'new' | null>(null)
  const current = resolveTarget(upload)
  const set = (patch: Partial<typeof upload>): void =>
    void updateSettings({ upload: { ...upload, ...patch } })

  const remove = async (target: UploadTarget): Promise<void> => {
    const answer = await confirm({
      title: `Remove ${target.name}?`,
      message: 'Clips already uploaded stay where they are, and their links stay in Podium.',
      confirmLabel: 'Remove',
      danger: true
    })
    if (answer !== 'confirm') return
    const targets = upload.targets.filter((t) => t.id !== target.id)
    // Main forgets the token when the target disappears from the settings.
    await updateSettings({
      upload: {
        ...upload,
        targets,
        defaultTarget: upload.defaultTarget === target.id ? null : upload.defaultTarget
      }
    })
    await refreshTokens()
  }

  return (
    <>
      <Group
        title="Upload targets"
        action={
          <Button variant="ghost" onClick={() => setEditing('new')}>
            <Plus size={13} /> Add target
          </Button>
        }
      >
        {upload.targets.length === 0 && (
          <div className="py-3.5 text-xs leading-relaxed text-muted">
            Add a server to upload clips to. Then share a link straight from the player, or have every new
            clip uploaded as soon as you save it.
            <div className="mt-2.5">
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={13} /> Add a target
              </Button>
            </div>
          </div>
        )}
        {upload.targets.map((target) => (
          <Row
            key={target.id}
            label={target.name}
            hint={
              <span className="flex flex-wrap items-center gap-x-1.5 break-all">
                {PROTOCOLS[target.protocol].label} · {target.url}
                {!tokens[target.id] && <span className="text-faint">· no token</span>}
              </span>
            }
          >
            {upload.targets.length > 1 &&
              (current?.id === target.id ? (
                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">
                  Default
                </span>
              ) : (
                <Button variant="ghost" onClick={() => set({ defaultTarget: target.id })}>
                  Make default
                </Button>
              ))}
            <Button variant="ghost" onClick={() => setEditing(target)} aria-label={`Edit ${target.name}`}>
              <Pencil size={13} />
            </Button>
            <Button variant="ghost" onClick={() => void remove(target)} aria-label={`Remove ${target.name}`}>
              <Trash2 size={13} />
            </Button>
          </Row>
        ))}
      </Group>

      <Group title="Behaviour">
        <Row
          label="Upload new clips automatically"
          hint={
            current
              ? `Clips you save with a hotkey or the tray go to ${current.name} right away. Bookmarks wait until you’ve reviewed them.`
              : 'Add an upload target first.'
          }
        >
          <Switch
            label="Upload new clips automatically"
            checked={upload.auto}
            disabled={!current}
            onChange={(auto) => set({ auto })}
          />
        </Row>
        <Row label="Copy the link when an upload finishes" hint="Ready to paste into Discord or a chat.">
          <Switch
            label="Copy the link when an upload finishes"
            checked={upload.copyLink}
            onChange={(copyLink) => set({ copyLink })}
          />
        </Row>
      </Group>

      <Group title="Run your own">
        <Row
          label="Podium upload protocol"
          hint="Podium-compatible servers speak an open, documented protocol, so any server or service can take clips from Podium."
        >
          <Button onClick={() => window.podium.app.openExternal(SPEC_URL)}>
            <ExternalLink size={13} /> Read the spec
          </Button>
        </Row>
      </Group>

      {editing && (
        <TargetDialog
          target={editing === 'new' ? null : editing}
          hasToken={editing !== 'new' && Boolean(tokens[editing.id])}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

function TargetDialog({
  target,
  hasToken,
  onClose
}: {
  target: UploadTarget | null
  hasToken: boolean
  onClose: () => void
}) {
  const upload = useApp((s) => s.settings!.upload)
  const [protocol, setProtocol] = useState<UploadProtocolKind>(target?.protocol ?? 'podium')
  const [name, setName] = useState(target?.name ?? '')
  const [url, setUrl] = useState(target?.url ?? '')
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [test, setTest] = useState<UploadTestResult | 'testing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const normalized = (() => {
    try {
      return normalizeServerUrl(url)
    } catch {
      return null
    }
  })()
  const draft = (): UploadTarget => ({
    id: target?.id ?? crypto.randomUUID(),
    name: name.trim(),
    protocol,
    url: normalizeServerUrl(url)
  })
  // An empty field keeps the saved token, unless the user asked to remove it.
  const tokenToTest = clearToken ? '' : token.trim() || null

  const runTest = async (): Promise<void> => {
    setError(null)
    let candidate: UploadTarget
    try {
      candidate = draft()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    setTest('testing')
    // A target that isn't saved yet has no saved token to fall back on.
    const result = await window.podium.uploads.test(candidate, target ? tokenToTest : token.trim())
    setTest(result)
    if (result.ok && !name.trim()) setName(result.serverName)
  }

  const save = async (): Promise<void> => {
    let next: UploadTarget
    try {
      next = draft()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    if (!next.name) next.name = new URL(next.url).host
    if (clearToken) await window.podium.uploads.setToken(next.id, null)
    else if (token.trim()) await window.podium.uploads.setToken(next.id, token.trim())
    const targets = target
      ? upload.targets.map((t) => (t.id === target.id ? next : t))
      : [...upload.targets, next]
    await updateSettings({ upload: { ...upload, targets } })
    await refreshTokens()
    onClose()
  }

  return (
    <Modal title={target ? `Edit ${target.name}` : 'Add an upload target'} onClose={onClose} width={480}>
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="block text-xs text-muted">
          Type
          <Select
            className="mt-1.5 h-8 w-full"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as UploadProtocolKind)}
          >
            {(Object.keys(PROTOCOLS) as UploadProtocolKind[]).map((p) => (
              <option key={p} value={p}>
                {PROTOCOLS[p].label}
              </option>
            ))}
          </Select>
          <span className="mt-1 block text-2xs text-faint">{PROTOCOLS[protocol].hint}</span>
        </label>

        <label className="block text-xs text-muted">
          Server URL
          <input
            autoFocus
            className={`${inputClass} mt-1.5`}
            placeholder="https://clips.example.com/api/podium"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setTest(null)
              setError(null)
            }}
          />
          {normalized && isInsecureUrl(normalized) && (
            <span className="mt-1 flex items-center gap-1 text-2xs text-warn">
              <AlertTriangle size={11} /> Not encrypted: your token and clips can be read on the way.
            </span>
          )}
        </label>

        <label className="block text-xs text-muted">
          Access token
          <input
            type="password"
            className={`${inputClass} mt-1.5`}
            placeholder={
              hasToken && !clearToken
                ? 'Saved. Type a new one to replace it.'
                : 'From your account on the server'
            }
            value={token}
            disabled={clearToken}
            onChange={(e) => {
              setToken(e.target.value)
              setTest(null)
            }}
          />
          <span className="mt-1 flex items-center gap-2 text-2xs text-faint">
            <KeyRound size={11} />
            Kept on this computer, encrypted when there’s a system keyring. Leave it empty for servers without
            tokens.
            {hasToken && (
              <button
                type="button"
                className="ml-auto text-muted hover:text-fg"
                onClick={() => {
                  setClearToken(!clearToken)
                  setToken('')
                  setTest(null)
                }}
              >
                {clearToken ? 'Keep the saved token' : 'Remove the saved token'}
              </button>
            )}
          </span>
        </label>

        <label className="block text-xs text-muted">
          Name
          <input
            className={`${inputClass} mt-1.5`}
            placeholder={
              test && test !== 'testing' && test.ok ? test.serverName : 'Shown in Podium, e.g. “My clips”'
            }
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {error && <p className="text-xs text-danger">{error}</p>}
        {test && test !== 'testing' && (
          <p className={`flex items-start gap-1.5 text-xs ${test.ok ? 'text-ok' : 'text-danger'}`}>
            {test.ok ? (
              <CheckCircle2 size={13} className="mt-px shrink-0" />
            ) : (
              <AlertTriangle size={13} className="mt-px shrink-0" />
            )}
            <span className="select-text">
              {test.ok
                ? `Connected to ${test.serverName}${test.account ? ` as ${test.account}` : ''}.`
                : test.message}
            </span>
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={() => void runTest()} disabled={!url.trim() || test === 'testing'}>
            {test === 'testing' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!url.trim()}>
            {target ? 'Save' : 'Add target'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
