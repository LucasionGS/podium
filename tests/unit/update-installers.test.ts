import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Release } from '@core/update/update'
import {
  installAppImage,
  installAurPackage,
  installSystemPackage,
  type InstallContext
} from '../../src/main/update/installers'

// The installers against a local stand-in for GitHub's release downloads, with pkexec replaced by a recorder.

let work: string
let server: Server
let base: string
const files = new Map<string, Buffer>()
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'podium-update-'))
  server = createServer((req, res) => {
    const data = files.get(decodeURIComponent(req.url!.slice(1)))
    if (!data) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Length': data.length }).end(data)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(work, { recursive: true, force: true })
})

/** Publishes a release with the given files (and their SHA256SUMS.txt, unless told otherwise). */
function release(version: string, assets: Record<string, Buffer>, sums = true): Release {
  const names = Object.keys(assets)
  for (const [name, data] of Object.entries(assets)) files.set(`${version}/${name}`, data)
  if (sums) {
    const text = names.map((n) => `${sha(assets[n]!)}  ${n}`).join('\n')
    files.set(`${version}/SHA256SUMS.txt`, Buffer.from(text))
    names.push('SHA256SUMS.txt')
  }
  return {
    version,
    url: `${base}/${version}`,
    notes: '',
    publishedAt: null,
    assets: names.map((name) => ({ name, url: `${base}/${version}/${encodeURIComponent(name)}`, size: 0 }))
  }
}

function context(rel: Release, name: string): InstallContext & { elevated: string[][]; progress: number[] } {
  const elevated: string[][] = []
  const progress: number[] = []
  return {
    release: rel,
    workDir: join(work, name),
    onProgress: (p) => p !== null && progress.push(p),
    elevate: async (command, args) => void elevated.push([command, ...args]),
    elevated,
    progress
  }
}

describe('update installers', () => {
  it('replaces the AppImage in place', async () => {
    const appImage = join(work, 'Podium.AppImage')
    writeFileSync(appImage, 'old')
    const fresh = Buffer.from('#!/bin/sh\necho new\n'.repeat(1000))
    const ctx = context(release('0.3.0', { 'Podium-0.3.0.AppImage': fresh }), 'appimage')
    await installAppImage(ctx, appImage)
    expect(readFileSync(appImage)).toEqual(fresh)
    expect(statSync(appImage).mode & 0o111).toBeTruthy()
    expect(ctx.progress.at(-1)).toBe(1)
  })

  it('refuses downloads that don’t match their checksum, or have none', async () => {
    const appImage = join(work, 'Keep.AppImage')
    writeFileSync(appImage, 'old')
    const bad = release('0.3.1', { 'Podium-0.3.1.AppImage': Buffer.from('new') })
    files.set('0.3.1/SHA256SUMS.txt', Buffer.from(`${'0'.repeat(64)}  Podium-0.3.1.AppImage`))
    await expect(installAppImage(context(bad, 'bad'), appImage)).rejects.toThrow(/doesn’t match its checksum/)
    const unsigned = release('0.3.2', { 'Podium-0.3.2.AppImage': Buffer.from('new') }, false)
    await expect(installAppImage(context(unsigned, 'unsigned'), appImage)).rejects.toThrow(/no checksums/)
    expect(readFileSync(appImage, 'utf8')).toBe('old')
  })

  it('installs system packages through the elevated package manager', async () => {
    const rel = release('0.4.0', {
      'podium_0.4.0_amd64.deb': Buffer.from('deb'),
      'podium-0.4.0.pacman': Buffer.from('pacman')
    })
    const deb = context(rel, 'deb')
    await installSystemPackage(deb, 'deb')
    expect(deb.elevated).toEqual([
      ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', join(work, 'deb', 'podium_0.4.0_amd64.deb')]
    ])
    const pacman = context(rel, 'pacman')
    await installSystemPackage(pacman, 'pacman')
    expect(pacman.elevated[0]!.slice(0, 3)).toEqual(['/usr/bin/pacman', '-U', '--noconfirm'])
    expect(readFileSync(pacman.elevated[0]![3]!, 'utf8')).toBe('pacman')
  })

  const hasMakepkg = (() => {
    try {
      execFileSync('makepkg', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  /** An AUR snapshot tarball of a tiny package at the given version. */
  function aurSnapshot(pkgver: string): string {
    const dir = mkdtempSync(join(work, 'aur-src-'))
    mkdirSync(join(dir, 'podium-test'))
    writeFileSync(
      join(dir, 'podium-test', 'PKGBUILD'),
      [
        'pkgname=podium-test',
        `pkgver=${pkgver}`,
        'pkgrel=1',
        "arch=('any')",
        'package() { install -d "$pkgdir/opt/podium-test"; echo hi > "$pkgdir/opt/podium-test/hi"; }',
        ''
      ].join('\n')
    )
    const tarball = join(dir, 'podium-test.tar.gz')
    execFileSync('tar', ['-czf', tarball, '-C', dir, 'podium-test'])
    files.set(`aur/${pkgver}.tar.gz`, readFileSync(tarball))
    return `${base}/aur/${pkgver}.tar.gz`
  }

  it.skipIf(!hasMakepkg)('builds the AUR package with makepkg and installs what it built', async () => {
    const ctx = context(release('0.5.0', {}), 'aur')
    await installAurPackage(ctx, 'podium-test', aurSnapshot('0.5.0'))
    expect(ctx.elevated).toHaveLength(1)
    const [command, ...args] = ctx.elevated[0]!
    expect([command, args[0], args[1]]).toEqual(['/usr/bin/pacman', '-U', '--noconfirm'])
    expect(args[2]).toMatch(/podium-test-0\.5\.0-1-any\.pkg\.tar\.\w+$/)
    expect(statSync(args[2]!).size).toBeGreaterThan(0)
  })

  it.skipIf(!hasMakepkg)('waits for the AUR to catch up with the release', async () => {
    const ctx = context(release('0.6.0', {}), 'aur-late')
    await expect(installAurPackage(ctx, 'podium-test', aurSnapshot('0.5.9'))).rejects.toThrow(
      /isn’t updated to 0\.6\.0 yet \(it has 0\.5\.9\)/
    )
    expect(ctx.elevated).toEqual([])
  })
})
