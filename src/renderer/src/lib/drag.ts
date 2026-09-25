import type { PointerEvent as ReactPointerEvent } from 'react'

export interface DragHandlers {
  /** Fired once the pointer has travelled past the threshold. */
  onStart?(): void
  onMove(dx: number, dy: number, event: PointerEvent): void
  /** `moved` is false for a plain click. `cancelled` is true when Escape was pressed. */
  onEnd?(moved: boolean, cancelled: boolean): void
  threshold?: number
}

/** Pointer-drag helper: threshold, Escape to cancel, and cleanup on its own. */
export function startDrag(down: ReactPointerEvent | PointerEvent, handlers: DragHandlers): void {
  const threshold = handlers.threshold ?? 3
  const x0 = down.clientX
  const y0 = down.clientY
  let moved = false

  const move = (e: PointerEvent): void => {
    const dx = e.clientX - x0
    const dy = e.clientY - y0
    if (!moved) {
      if (Math.hypot(dx, dy) < threshold) return
      moved = true
      handlers.onStart?.()
    }
    handlers.onMove(dx, dy, e)
  }
  const finish = (cancelled: boolean): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    handlers.onEnd?.(moved, cancelled)
  }
  const up = (): void => finish(false)
  const cancel = (): void => finish(true)
  const key = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    finish(true)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
}
