import { useState } from 'react'
import { AlertTriangle, Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/ui/Button'
import { refreshCapabilities, useApp } from '@/store/app'

/** Shown when no capture engine can run: what's missing and how to install it. */
export function SetupCard() {
  const problem = useApp((s) => s.capabilities?.problem)
  const [checking, setChecking] = useState(false)
  if (!problem) return null
  return (
    <section className="flex gap-4 rounded-xl border border-warn/40 bg-warn/5 p-5">
      <AlertTriangle size={20} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">{problem.title}</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">{problem.detail}</p>
        {problem.install && (
          <div className="mt-3 flex flex-col gap-1.5">
            {problem.install.map((command) => (
              <div
                key={command}
                className="flex max-w-xl items-center gap-2 rounded-md border border-line bg-bg px-3 py-1.5"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-xs select-text">{command}</code>
                <button
                  className="text-faint hover:text-fg"
                  aria-label={`Copy ${command}`}
                  onClick={() => window.podium.app.copyText(command)}
                >
                  <Copy size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <Button
          className="mt-4"
          disabled={checking}
          onClick={() => {
            setChecking(true)
            void refreshCapabilities().finally(() => setChecking(false))
          }}
        >
          <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
          Check again
        </Button>
      </div>
    </section>
  )
}
