import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import lockfile from 'proper-lockfile'
import type { AccountStorage, UsageStorage } from './types'
import * as logger from './logger'

const LOCK_OPTIONS = {
  stale: 10000,
  retries: { retries: 5, minTimeout: 100, maxTimeout: 1000, factor: 2 }
}

function getBaseDir(): string {
  const platform = process.platform
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

export function getStoragePath(): string {
  return join(getBaseDir(), 'kiro-accounts.json')
}

export function getUsagePath(): string {
  return join(getBaseDir(), 'kiro-usage.json')
}

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    await fs.mkdir(dirname(path), { recursive: true })
  } catch (error) {
    logger.error(`Failed to create directory ${dirname(path)}`, error)
    throw error
  }

  try {
    await fs.access(path)
  } catch {
    try {
      await fs.writeFile(path, '{}')
    } catch (error) {
      logger.error(`Failed to initialize file ${path}`, error)
      throw error
    }
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS)
    return await fn()
  } catch (error) {
    logger.error(`File lock failed for ${path}`, error)
    throw error
  } finally {
    if (release) {
      try {
        await release()
      } catch (error) {
        logger.warn(`Failed to release lock for ${path}`, error)
      }
    }
  }
}

export async function loadAccounts(): Promise<AccountStorage> {
  const path = getStoragePath()
  return withLock(path, async () => {
    // Try loading from our storage first
    try {
      const content = await fs.readFile(path, 'utf-8')
      const parsed = JSON.parse(content)
      if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
        return parsed
      }
    } catch {
      // Fall through to Kiro IDE fallback
    }

    // Fallback: try loading from Kiro IDE cache
    const kiroAccount = await tryLoadKiroIDEAccount()
    if (kiroAccount) {
      return { version: 1, accounts: [kiroAccount], activeIndex: 0 }
    }
    return { version: 1, accounts: [], activeIndex: -1 }
  })
}

async function tryLoadKiroIDEAccount() {
  try {
    const kiroTokenPath = join(homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json')
    const tokenContent = await fs.readFile(kiroTokenPath, 'utf-8')
    const token = JSON.parse(tokenContent)

    if (!token.accessToken || !token.refreshToken) return null

    const clientIdHash = token.clientIdHash
    if (!clientIdHash) return null

    const clientPath = join(homedir(), '.aws', 'sso', 'cache', `${clientIdHash}.json`)
    const clientContent = await fs.readFile(clientPath, 'utf-8')
    const client = JSON.parse(clientContent)

    const expiresAt =
      typeof token.expiresAt === 'string' ? new Date(token.expiresAt).getTime() : token.expiresAt

    return {
      id: 'kiro-ide-pro',
      email: 'pro@kiro.dev',
      realEmail: 'pro@kiro.dev',
      authMethod: 'idc' as const,
      region: (token.region || 'us-east-1') as 'us-east-1' | 'us-west-2',
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt,
      rateLimitResetTime: 0,
      isHealthy: true
    }
  } catch {
    return null
  }
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  const path = getStoragePath()
  try {
    await withLock(path, async () => {
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      await fs.writeFile(tmp, JSON.stringify(storage, null, 2))
      await fs.rename(tmp, path)
    })
  } catch (error) {
    logger.error(`Failed to save accounts to ${path}`, error)
    throw error
  }
}

export async function loadUsage(): Promise<UsageStorage> {
  const path = getUsagePath()
  return withLock(path, async () => {
    try {
      const content = await fs.readFile(path, 'utf-8')
      const parsed = JSON.parse(content)
      if (!parsed || typeof parsed.usage !== 'object' || parsed.usage === null) {
        return { version: 1, usage: {} }
      }
      return parsed
    } catch {
      return { version: 1, usage: {} }
    }
  })
}

export async function saveUsage(storage: UsageStorage): Promise<void> {
  const path = getUsagePath()
  try {
    await withLock(path, async () => {
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      await fs.writeFile(tmp, JSON.stringify(storage, null, 2))
      await fs.rename(tmp, path)
    })
  } catch (error) {
    logger.error(`Failed to save usage to ${path}`, error)
    throw error
  }
}
