import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { writeFileAtomic } from './settings'

/**
 * Upload tokens, kept out of settings.json and encrypted with the OS keyring when one is available
 * (Keychain, DPAPI, libsecret/KWallet). Without a keyring they're stored as they are, still only in
 * the user's profile.
 */

interface SecretsFile {
  version: 1
  tokens: Record<string, { encrypted: boolean; value: string }>
}

let data: SecretsFile | null = null
const file = (): string => join(app.getPath('userData'), 'secrets.json')

async function load(): Promise<SecretsFile> {
  if (data) return data
  try {
    const raw = JSON.parse(await readFile(file(), 'utf8')) as Partial<SecretsFile>
    data = { version: 1, tokens: typeof raw.tokens === 'object' && raw.tokens ? raw.tokens : {} }
  } catch {
    data = { version: 1, tokens: {} }
  }
  return data
}

const save = async (): Promise<void> => writeFileAtomic(file(), JSON.stringify(data, null, 2))

export async function getToken(id: string): Promise<string | null> {
  const entry = (await load()).tokens[id]
  if (!entry) return null
  if (!entry.encrypted) return entry.value
  try {
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
  } catch (error) {
    // The keyring changed (another machine, a reset keyring): the user has to enter the token again.
    console.warn('[secrets] could not decrypt the token for', id, error)
    return null
  }
}

/** Saves a token; null or an empty string removes it. */
export async function setToken(id: string, token: string | null): Promise<void> {
  const secrets = await load()
  const value = token?.trim()
  if (!value) delete secrets.tokens[id]
  else if (safeStorage.isEncryptionAvailable())
    secrets.tokens[id] = { encrypted: true, value: safeStorage.encryptString(value).toString('base64') }
  else secrets.tokens[id] = { encrypted: false, value }
  await save()
}

/** Which ids have a token. */
export async function tokenIds(): Promise<string[]> {
  return Object.keys((await load()).tokens)
}

/** Drops tokens of targets that no longer exist. */
export async function pruneTokens(keep: string[]): Promise<void> {
  const secrets = await load()
  const stale = Object.keys(secrets.tokens).filter((id) => !keep.includes(id))
  if (!stale.length) return
  for (const id of stale) delete secrets.tokens[id]
  await save()
}
