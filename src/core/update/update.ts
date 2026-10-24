import type { InstallKind } from '@shared/ipc'

/** Update rules without any I/O: versions, releases, install kinds and the files that belong to them. */

export const REPOSITORY = 'LucasionGS/podium'
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
/** Squirrel asks for `<feed>/RELEASES`; GitHub redirects `latest/download/<file>` to the newest release's asset. */
export const SQUIRREL_FEED = `https://github.com/${REPOSITORY}/releases/latest/download`
export const AUR_SNAPSHOT = (pkg: string): string =>
  `https://aur.archlinux.org/cgit/aur.git/snapshot/${encodeURIComponent(pkg)}.tar.gz`
/** How often to look for a new release while Podium runs. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface Release {
  version: string
  url: string
  notes: string
  publishedAt: string | null
  assets: ReleaseAsset[]
}

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export const isVersion = (v: string): boolean => SEMVER.test(v.trim())

/** Semver ordering: negative when `a` is older than `b`. A prerelease is older than its release. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a.trim())
  const pb = SEMVER.exec(b.trim())
  if (!pa || !pb) throw new Error(`Can't compare versions “${a}” and “${b}”.`)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff) return diff
  }
  const [preA, preB] = [pa[4], pb[4]]
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const [x, y] = [partsA[i], partsB[i]]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const [nx, ny] = [/^\d+$/.test(x) ? Number(x) : null, /^\d+$/.test(y) ? Number(y) : null]
    if (nx !== null && ny !== null && nx !== ny) return nx - ny
    // Numeric identifiers sort before alphanumeric ones.
    if ((nx === null) !== (ny === null)) return nx !== null ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** A release as GitHub's API describes it (`/releases/latest`). */
export function parseRelease(body: unknown): Release {
  if (!isObject(body) || typeof body['tag_name'] !== 'string')
    throw new Error('GitHub sent something that isn’t a release.')
  const version = body['tag_name'].replace(/^v/, '')
  if (!isVersion(version))
    throw new Error(`The latest release has an unexpected version (${body['tag_name']}).`)
  const assets = Array.isArray(body['assets']) ? body['assets'] : []
  return {
    version,
    url:
      typeof body['html_url'] === 'string' ? body['html_url'] : `https://github.com/${REPOSITORY}/releases`,
    notes: typeof body['body'] === 'string' ? body['body'] : '',
    publishedAt: typeof body['published_at'] === 'string' ? body['published_at'] : null,
    assets: assets.flatMap((a): ReleaseAsset[] =>
      isObject(a) && typeof a['name'] === 'string' && typeof a['browser_download_url'] === 'string'
        ? [
            {
              name: a['name'],
              url: a['browser_download_url'],
              size: typeof a['size'] === 'number' ? a['size'] : 0
            }
          ]
        : []
    )
  }
}

export interface InstallFacts {
  platform: string
  packaged: boolean
  /** `$APPIMAGE`, set by the AppImage runtime. */
  appImage: string | null
  /** The `package-type` file next to the app's resources: electron-builder writes `deb` or `pacman`; the AUR
   * PKGBUILDs replace it with `aur:<package>`. */
  packageType: string | null
  /** Squirrel's `Update.exe` sits one folder above the app. */
  squirrel: boolean
}

export interface Install {
  kind: InstallKind
  /** The AUR package to rebuild, for `aur` and `aur-git`. */
  aurPackage: string | null
}

export function detectInstall(facts: InstallFacts): Install {
  const none = (kind: InstallKind): Install => ({ kind, aurPackage: null })
  if (!facts.packaged) return none('dev')
  if (facts.platform === 'win32') return none(facts.squirrel ? 'squirrel' : 'unsupported')
  if (facts.platform !== 'linux') return none('unsupported')
  if (facts.appImage) return none('appimage')
  const type = facts.packageType?.trim() ?? ''
  const aur = /^aur:([a-z0-9@._+-]+)$/.exec(type)
  if (aur) return { kind: aur[1]!.endsWith('-git') ? 'aur-git' : 'aur', aurPackage: aur[1]! }
  if (type === 'deb' || type === 'pacman') return none(type)
  return none('unsupported')
}

/** How this install gets its updates, for Settings. */
export function describeInstall(install: Install): { method: string; canInstall: boolean } {
  switch (install.kind) {
    case 'squirrel':
      return {
        method: 'Updates download in the background and install when Podium restarts.',
        canInstall: true
      }
    case 'appimage':
      return { method: 'The AppImage replaces itself with the new version.', canInstall: true }
    case 'deb':
      return { method: 'The new .deb is installed with apt, after your password.', canInstall: true }
    case 'pacman':
      return { method: 'The new package is installed with pacman, after your password.', canInstall: true }
    case 'aur':
      return {
        method: `The AUR package ${install.aurPackage} is built with makepkg and installed with pacman, after your password.`,
        canInstall: true
      }
    case 'aur-git':
      return {
        method: `${install.aurPackage} follows every commit: update it with your AUR helper (yay -Syu --devel).`,
        canInstall: false
      }
    case 'dev':
      return { method: 'This is a development build; it doesn’t update itself.', canInstall: false }
    default:
      return { method: 'Download new versions from the release page.', canInstall: false }
  }
}

/** The release file a system-package or AppImage install updates from (as electron-builder names them). */
export function assetName(kind: InstallKind, version: string): string | null {
  if (kind === 'appimage') return `Podium-${version}.AppImage`
  if (kind === 'deb') return `podium_${version}_amd64.deb`
  if (kind === 'pacman') return `podium-${version}.pacman`
  return null
}

/** `sha256sum` output: `<hex>  <name>`, or `<hex> *<name>` in binary mode. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim())
    if (match) sums.set(match[2]!, match[1]!.toLowerCase())
  }
  return sums
}

/** GitHub turns spaces in uploaded file names into dots; the checksum file still has the original names. */
export function checksumFor(sums: Map<string, string>, asset: string): string | null {
  return sums.get(asset) ?? [...sums].find(([name]) => name.replace(/ /g, '.') === asset)?.[1] ?? null
}

/** `pkgver=` from a PKGBUILD. */
export function pkgverOf(pkgbuild: string): string | null {
  const match = /^pkgver=(['"]?)([^'"\s]+)\1\s*$/m.exec(pkgbuild)
  return match ? match[2]! : null
}

/** pkexec's exit codes when nothing ran, as something to tell the user. */
export function elevationFailure(code: number | null): string | null {
  if (code === 126) return 'The password prompt was closed, so nothing was installed.'
  if (code === 127)
    return 'Podium wasn’t allowed to install the update. Make sure a polkit agent is running to ask for your password.'
  return null
}
