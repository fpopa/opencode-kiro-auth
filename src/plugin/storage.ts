import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { xdgConfig } from 'xdg-basedir'
import type { AccountStorage, UsageStorage } from './types'
import * as logger from './logger'

const LOCK_OPTIONS = {
  stale: 10000,
  retries: { retries: 5, minTimeout: 100, maxTimeout: 1000, factor: 2 }
}

function getBaseDir(): string {
  return join(xdgConfig || join(process.env.HOME || '', '.config'), 'opencode')
}

export function getStoragePath(): string {
  return join(getBaseDir(), 'kiro-accounts.json')
}
export function getUsagePath(): string {
  return join(getBaseDir(), 'kiro-usage.json')
}

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(dirname(path), { recursive: true })
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, '{}')
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS)
    return await fn()
  } catch (error) {
    logger.error(`File lock failed for ${path}`, error)
    throw error
  } finally {
    if (release) await release()
  }
}

export async function loadAccounts(): Promise<AccountStorage> {
  try {
    const content = await fs.readFile(getStoragePath(), 'utf-8')
    return JSON.parse(content)
  } catch {
    return { version: 1, accounts: [], activeIndex: -1 }
  }
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  const path = getStoragePath()
  await withLock(path, async () => {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(storage, null, 2))
    await fs.rename(tmp, path)
  })
}

export async function loadUsage(): Promise<UsageStorage> {
  try {
    const content = await fs.readFile(getUsagePath(), 'utf-8')
    return JSON.parse(content)
  } catch {
    return { version: 1, usage: {} }
  }
}

export async function saveUsage(storage: UsageStorage): Promise<void> {
  const path = getUsagePath()
  await withLock(path, async () => {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(storage, null, 2))
    await fs.rename(tmp, path)
  })
}
