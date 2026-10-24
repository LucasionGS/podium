import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { normalizeSettings } from '@core/settings'
import {
  assetName,
  checksumFor,
  compareVersions,
  describeInstall,
  detectInstall,
  elevationFailure,
  parseChecksums,
  parseRelease,
  pkgverOf,
  type InstallFacts
} from '@core/update/update'

describe('versions', () => {
  it('orders versions like semver', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(() => compareVersions('0.2.0.r3.gabc', '0.2.0')).toThrow()
  })
})

describe('releases', () => {
  it('reads GitHub’s latest release', () => {
    const release = parseRelease({
      tag_name: 'v0.3.0',
      html_url: 'https://github.com/x/y/releases/tag/v0.3.0',
      body: 'Notes',
      published_at: '2026-10-24T00:00:00Z',
      assets: [{ name: 'Podium-0.3.0.AppImage', browser_download_url: 'https://x/a', size: 5 }, { name: 1 }]
    })
    expect(release).toEqual({
      version: '0.3.0',
      url: 'https://github.com/x/y/releases/tag/v0.3.0',
      notes: 'Notes',
      publishedAt: '2026-10-24T00:00:00Z',
      assets: [{ name: 'Podium-0.3.0.AppImage', url: 'https://x/a', size: 5 }]
    })
    expect(() => parseRelease({ message: 'Not Found' })).toThrow(/isn’t a release/)
    expect(() => parseRelease({ tag_name: 'nightly' })).toThrow(/unexpected version/)
  })

  it('names the file each install kind updates from', () => {
    expect(assetName('appimage', '0.3.0')).toBe('Podium-0.3.0.AppImage')
    expect(assetName('deb', '0.3.0')).toBe('podium_0.3.0_amd64.deb')
    expect(assetName('pacman', '0.3.0')).toBe('podium-0.3.0.pacman')
    expect(assetName('aur', '0.3.0')).toBeNull()
  })

  it('reads checksums, also for names GitHub changed', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const sums = parseChecksums(`${a}  podium-0.3.0.pacman\n${b} *Podium Setup 0.3.0.exe\nnonsense\n`)
    expect(checksumFor(sums, 'podium-0.3.0.pacman')).toBe(a)
    expect(checksumFor(sums, 'Podium.Setup.0.3.0.exe')).toBe('b'.repeat(64))
    expect(checksumFor(sums, 'other')).toBeNull()
  })

  it('reads pkgver from a PKGBUILD', () => {
    expect(pkgverOf('pkgname=podium-bin\npkgver=0.3.0\npkgrel=1\n')).toBe('0.3.0')
    expect(pkgverOf("pkgver='0.3.0'\n")).toBe('0.3.0')
    expect(pkgverOf('pkgname=x\n')).toBeNull()
  })
})

describe('install kinds', () => {
  const facts = (over: Partial<InstallFacts>): InstallFacts => ({
    platform: 'linux',
    packaged: true,
    appImage: null,
    packageType: null,
    squirrel: false,
    ...over
  })

  it('tells how Podium was installed', () => {
    expect(detectInstall(facts({ packaged: false })).kind).toBe('dev')
    expect(detectInstall(facts({ appImage: '/home/me/Podium.AppImage' })).kind).toBe('appimage')
    expect(detectInstall(facts({ packageType: 'pacman\n' })).kind).toBe('pacman')
    expect(detectInstall(facts({ packageType: 'deb' })).kind).toBe('deb')
    expect(detectInstall(facts({ packageType: 'aur:podium-bin\n' }))).toEqual({
      kind: 'aur',
      aurPackage: 'podium-bin'
    })
    expect(detectInstall(facts({ packageType: 'aur:podium-git' }))).toEqual({
      kind: 'aur-git',
      aurPackage: 'podium-git'
    })
    expect(detectInstall(facts({ packageType: 'rpm' })).kind).toBe('unsupported')
    expect(detectInstall(facts({ platform: 'win32', squirrel: true })).kind).toBe('squirrel')
    // An NSIS install from before Squirrel.
    expect(detectInstall(facts({ platform: 'win32' })).kind).toBe('unsupported')
  })

  it('says which installs update themselves', () => {
    expect(describeInstall({ kind: 'aur', aurPackage: 'podium-bin' })).toMatchObject({ canInstall: true })
    expect(describeInstall({ kind: 'aur', aurPackage: 'podium-bin' }).method).toMatch(/podium-bin/)
    expect(describeInstall({ kind: 'aur-git', aurPackage: 'podium-git' })).toMatchObject({
      canInstall: false
    })
    expect(describeInstall({ kind: 'dev', aurPackage: null }).canInstall).toBe(false)
  })

  it('explains why pkexec ran nothing', () => {
    expect(elevationFailure(126)).toMatch(/password prompt was closed/)
    expect(elevationFailure(127)).toMatch(/polkit agent/)
    expect(elevationFailure(1)).toBeNull()
  })
})

describe('update settings', () => {
  it('checks for updates unless turned off', () => {
    expect(normalizeSettings({}).updates).toEqual(DEFAULT_SETTINGS.updates)
    expect(normalizeSettings({ updates: { check: false } }).updates.check).toBe(false)
    expect(normalizeSettings({ updates: 'yes' }).updates.check).toBe(true)
  })
})
