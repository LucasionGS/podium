import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  assetName,
  AUR_SNAPSHOT,
  checksumFor,
  compareVersions,
  elevationFailure,
  parseChecksums,
  pkgverOf,
  type Release
} from '@core/update/update'

// No Electron imports here, so the installers can be tested in plain Node (with a stand-in for pkexec).

export interface InstallContext {
  release: Release
  /** Scratch space for downloads and builds; emptied first. */
  workDir: string
  /** Progress from 0 to 1 (null when unknown) and what's happening. */
  onProgress(progress: number | null, message: string | null): void
  /** Runs a command as root. */
  elevate(command: string, args: string[]): Promise<void>
}

const tail = (text: string): string => text.trim().split('\n').at(-1)?.trim() ?? ''

/** Runs a command, handing each output line to `onLine`. Rejects with the last line when it fails. */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; onLine?: (line: string) => void } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let pending = ''
    const take = (data: Buffer): void => {
      const text = data.toString()
      output = (output + text).slice(-20_000)
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) options.onLine?.(line.trim())
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'ENOENT' ? new Error(`${command} isn’t installed.`) : error)
    )
    child.once('close', (code) => {
      if (code === 0) resolve(output)
      else {
        const failure = Object.assign(new Error(tail(output) || `${command} exited with ${code}`), { code })
        reject(failure)
      }
    })
  })
}

/** Runs a command as root through polkit, which asks for the password with the desktop's own dialog. */
export async function pkexec(command: string, args: string[]): Promise<void> {
  try {
    await run('pkexec', [command, ...args])
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'number')
      throw new Error(elevationFailure(code) ?? `${basename(command)} failed: ${(error as Error).message}`)
    if ((error as Error).message === 'pkexec isn’t installed.')
      throw new Error(
        'pkexec (polkit) isn’t installed, so Podium can’t ask for the password to install updates.'
      )
    throw error
  }
}

async function download(
  url: string,
  path: string,
  onBytes?: (bytes: number, total: number) => void
): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Podium updater' } })
  if (!res.ok || !res.body)
    throw new Error(`Downloading ${basename(path)} failed (${res.status} ${res.statusText}).`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      onBytes?.(bytes, total)
      callback(null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    meter,
    createWriteStream(path)
  )
  return hash.digest('hex')
}

/** Downloads a release file and checks it against the release's SHA256SUMS.txt. */
export async function downloadVerified(ctx: InstallContext, name: string, path: string): Promise<void> {
  const { release } = ctx
  const asset = release.assets.find((a) => a.name === name)
  if (!asset)
    throw new Error(`Release ${release.version} has no ${name}. Download it from the release page instead.`)
  const sumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS.txt')
  if (!sumsAsset) throw new Error(`Release ${release.version} has no checksums, so Podium won’t install it.`)
  const sumsRes = await fetch(sumsAsset.url, { headers: { 'User-Agent': 'Podium updater' } })
  if (!sumsRes.ok) throw new Error(`Downloading the checksums failed (${sumsRes.status}).`)
  const expected = checksumFor(parseChecksums(await sumsRes.text()), name)
  if (!expected) throw new Error(`The checksums don’t list ${name}, so Podium won’t install it.`)

  let lastPercent = -1
  const actual = await download(asset.url, path, (bytes, total) => {
    const size = total || asset.size
    const percent = size ? Math.floor((bytes / size) * 100) : -1
    if (percent === lastPercent) return
    lastPercent = percent
    ctx.onProgress(size ? Math.min(1, bytes / size) : null, `Downloading ${name}…`)
  })
  if (actual !== expected) {
    await rm(path, { force: true })
    throw new Error(`${name} doesn’t match its checksum; the download was corrupted. Try again.`)
  }
}

async function freshDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

/** Swaps the AppImage file for the new one. The running copy keeps working: it's mounted from the old file. */
export async function installAppImage(ctx: InstallContext, appImage: string): Promise<void> {
  const name = assetName('appimage', ctx.release.version)!
  const dir = dirname(appImage)
  try {
    await access(dir, 2) // W_OK
  } catch {
    throw new Error(
      `Podium can’t write to ${dir}, where its AppImage is. Download the new one from the release page.`
    )
  }
  // Next to the AppImage, so the final rename is atomic.
  const partial = join(dir, `.${basename(appImage)}.update`)
  try {
    await downloadVerified(ctx, name, partial)
    await chmod(partial, 0o755)
    await rename(partial, appImage)
  } finally {
    await rm(partial, { force: true })
  }
}

/** Installs the release's .deb or .pacman with the system package manager. */
export async function installSystemPackage(ctx: InstallContext, kind: 'deb' | 'pacman'): Promise<void> {
  await freshDir(ctx.workDir)
  const name = assetName(kind, ctx.release.version)!
  const path = join(ctx.workDir, name)
  await downloadVerified(ctx, name, path)
  ctx.onProgress(null, 'Installing… (enter your password when asked)')
  if (kind === 'deb') await ctx.elevate('/usr/bin/apt-get', ['install', '-y', '--allow-downgrades', path])
  else await ctx.elevate('/usr/bin/pacman', ['-U', '--noconfirm', path])
}

/**
 * Rebuilds the AUR package the way an AUR helper would: fetch its snapshot, makepkg as the user, then
 * pacman -U as root. Dependencies aren't installed; a missing one fails with makepkg's message.
 */
export async function installAurPackage(
  ctx: InstallContext,
  pkg: string,
  snapshotUrl = AUR_SNAPSHOT(pkg)
): Promise<void> {
  await freshDir(ctx.workDir)
  ctx.onProgress(null, `Downloading ${pkg} from the AUR…`)
  const tarball = join(ctx.workDir, `${pkg}.tar.gz`)
  await download(snapshotUrl, tarball)
  await run('tar', ['-xzf', tarball, '-C', ctx.workDir])
  const source = join(ctx.workDir, pkg)

  const pkgver = pkgverOf(await readFile(join(source, 'PKGBUILD'), 'utf8'))
  if (!pkgver) throw new Error(`The AUR's ${pkg} PKGBUILD has no version.`)
  if (compareVersions(pkgver, ctx.release.version) < 0) {
    throw new Error(
      `The AUR package ${pkg} isn’t updated to ${ctx.release.version} yet (it has ${pkgver}). Try again in a few minutes.`
    )
  }

  ctx.onProgress(null, `Building ${pkg} ${pkgver}…`)
  try {
    await run('makepkg', ['-f', '--noconfirm', '--nocolor'], {
      cwd: source,
      onLine: (line) => ctx.onProgress(null, line)
    })
  } catch (error) {
    const message = (error as Error).message
    if (message === 'makepkg isn’t installed.')
      throw new Error(
        `makepkg isn’t installed (it comes with base-devel). Update ${pkg} with your AUR helper instead.`
      )
    throw new Error(
      `Building ${pkg} failed: ${message.replace(/^==> ERROR: /, '')} Update it with your AUR helper instead.`
    )
  }
  const packages = (await run('makepkg', ['--packagelist'], { cwd: source }))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const built: string[] = []
  for (const path of packages)
    if (
      await access(path).then(
        () => true,
        () => false
      )
    )
      built.push(path)
  if (!built.length) throw new Error(`makepkg didn’t produce a package for ${pkg}.`)

  ctx.onProgress(null, 'Installing… (enter your password when asked)')
  await ctx.elevate('/usr/bin/pacman', ['-U', '--noconfirm', ...built])
}
