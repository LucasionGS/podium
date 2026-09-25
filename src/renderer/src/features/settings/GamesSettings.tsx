import { useState } from 'react'
import { Gamepad2, Plus, Trash2 } from 'lucide-react'
import type { GameRule } from '@shared/ipc'
import { Button } from '@/ui/Button'
import { updateSettings, useApp } from '@/store/app'
import { Group, Row } from './Row'

const inputClass =
  'h-7 min-w-0 rounded-md border border-line bg-bg px-2 text-xs outline-none placeholder:text-faint focus:border-accent'

export function GamesSettings() {
  const game = useApp((s) => s.game)
  const rules = useApp((s) => s.settings!.gameRules)
  const [match, setMatch] = useState('')
  const [name, setName] = useState('')
  const setRules = (next: GameRule[]): void => void updateSettings({ gameRules: next })

  const add = (ignore: boolean): void => {
    if (!match.trim()) return
    setRules([
      ...rules.filter((r) => r.match !== match.trim()),
      { match: match.trim(), name: ignore ? null : name.trim() || match.trim() }
    ])
    setMatch('')
    setName('')
  }

  return (
    <>
      <Group title="Detection">
        <Row
          label="Playing now"
          hint="Steam and Proton games are recognised automatically. Other fullscreen apps are treated as games unless they’re browsers, video players and the like."
        >
          <span className="flex items-center gap-1.5 text-xs">
            <Gamepad2 size={14} className={game ? 'text-ok' : 'text-faint'} />
            {game?.name ?? 'Nothing detected'}
          </span>
        </Row>
      </Group>

      <Group title="Window rules">
        <div className="py-3.5">
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Name a game that isn’t detected, or stop an app from counting as one. Match on the window class
            (run <code className="text-fg">hyprctl activewindow</code> to see it).
          </p>
          {rules.length > 0 && (
            <ul className="mb-3 flex flex-col gap-1">
              {rules.map((rule) => (
                <li key={rule.match} className="flex items-center gap-2 rounded-md bg-bg px-3 py-1.5 text-xs">
                  <code className="min-w-0 flex-1 truncate">{rule.match}</code>
                  <span className={rule.name ? '' : 'text-faint'}>{rule.name ?? 'Not a game'}</span>
                  <button
                    className="text-faint hover:text-danger"
                    aria-label={`Remove rule for ${rule.match}`}
                    onClick={() => setRules(rules.filter((r) => r !== rule))}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <input
              className={`${inputClass} flex-1`}
              placeholder="Window class"
              value={match}
              onChange={(e) => setMatch(e.target.value)}
            />
            <input
              className={`${inputClass} flex-1`}
              placeholder="Game name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button onClick={() => add(false)} disabled={!match.trim()}>
              <Plus size={13} /> Add
            </Button>
            <Button variant="ghost" onClick={() => add(true)} disabled={!match.trim()}>
              Not a game
            </Button>
          </div>
        </div>
      </Group>
    </>
  )
}
