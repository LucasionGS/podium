import { create } from 'zustand'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  /** Optional third button, e.g. "Don't save". */
  alternateLabel?: string
  danger?: boolean
  resolve: (answer: 'confirm' | 'alternate' | 'cancel') => void
}

export interface PromptRequest {
  title: string
  label: string
  value: string
  confirmLabel: string
  resolve: (value: string | null) => void
}

interface FeedbackState {
  toasts: Toast[]
  confirm: ConfirmRequest | null
  prompt: PromptRequest | null
}

export const useFeedback = create<FeedbackState>(() => ({ toasts: [], confirm: null, prompt: null }))

let nextId = 1

export function toast(message: string, kind: Toast['kind'] = 'info'): void {
  const id = nextId++
  useFeedback.setState((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
  setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 3500)
}

export const dismissToast = (id: number): void =>
  useFeedback.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))

export function confirm(
  request: Omit<ConfirmRequest, 'resolve'>
): Promise<'confirm' | 'alternate' | 'cancel'> {
  return new Promise((resolve) => {
    useFeedback.setState({
      confirm: {
        ...request,
        resolve: (answer) => {
          useFeedback.setState({ confirm: null })
          resolve(answer)
        }
      }
    })
  })
}

/** Asks for a line of text (Electron has no window.prompt). Resolves with null when cancelled. */
export function promptText(request: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    useFeedback.setState({
      prompt: {
        ...request,
        resolve: (value) => {
          useFeedback.setState({ prompt: null })
          resolve(value)
        }
      }
    })
  })
}
