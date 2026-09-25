/** Valve's KeyValues text format (appmanifest_*.acf, libraryfolders.vdf). */
export type VdfValue = string | VdfObject
export interface VdfObject {
  [key: string]: VdfValue
}

export function parseVdf(text: string): VdfObject {
  let i = 0
  const skip = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++
      } else return
    }
  }
  const token = (): string | '{' | '}' | null => {
    skip()
    if (i >= text.length) return null
    const c = text[i]!
    if (c === '{' || c === '}') {
      i++
      return c
    }
    if (c === '"') {
      let out = ''
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const next = text[i + 1]!
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
        } else out += text[i++]
      }
      i++
      return out
    }
    let out = ''
    while (i < text.length && !/[\s{}"]/.test(text[i]!)) out += text[i++]
    return out
  }
  const object = (): VdfObject => {
    const result: VdfObject = {}
    for (;;) {
      const key = token()
      if (key === null || key === '}') return result
      if (key === '{') continue
      const value = token()
      if (value === null) return result
      result[key] = value === '{' ? object() : value === '}' ? '' : value
    }
  }
  return object()
}

/** Case-insensitive lookup; Steam isn't consistent about key casing across versions. */
export function vdfGet(object: VdfValue | undefined, ...path: string[]): VdfValue | undefined {
  let current: VdfValue | undefined = object
  for (const key of path) {
    if (!current || typeof current === 'string') return undefined
    const match: string | undefined = Object.keys(current).find((k) => k.toLowerCase() === key.toLowerCase())
    current = match === undefined ? undefined : current[match]
  }
  return current
}

export const vdfString = (object: VdfValue | undefined, ...path: string[]): string | null => {
  const value = vdfGet(object, ...path)
  return typeof value === 'string' ? value : null
}
