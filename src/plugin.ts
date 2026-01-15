import { loadConfig } from './plugin/config'
import { AccountManager, generateAccountId } from './plugin/accounts'
import { accessTokenExpired, encodeRefreshToken } from './kiro/auth'
import { refreshAccessToken } from './plugin/token'
import { transformToCodeWhisperer } from './plugin/request'
import { parseEventStream } from './plugin/response'
import { transformKiroStream } from './plugin/streaming'
import { fetchUsageLimits } from './plugin/usage'
import { updateAccountQuota } from './plugin/usage'
import { authorizeKiroIDC } from './kiro/oauth-idc'
import { startIDCAuthServer } from './plugin/server'
import { KiroTokenRefreshError } from './plugin/errors'
import type { ManagedAccount } from './plugin/types'
import { KIRO_CONSTANTS } from './constants'
import * as logger from './plugin/logger'

const KIRO_PROVIDER_ID = 'kiro'
const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isNetworkError = (e: any) => e instanceof Error && /econnreset|etimedout|enotfound|network|fetch failed/i.test(e.message)
const extractModel = (url: string) => url.match(/models\/([^/:]+)/)?.[1] || null

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)
    return {
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          const am = await AccountManager.loadFromDisk(config.account_selection_strategy)
          return {
            apiKey: '',
            baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace('{{region}}', config.default_region || 'us-east-1'),
            async fetch(input: any, init?: any): Promise<Response> {
              const url = typeof input === 'string' ? input : input.url
              if (!KIRO_API_PATTERN.test(url)) return fetch(input, init)

              const body = init?.body ? JSON.parse(init.body) : {}
              const model = extractModel(url) || body.model || 'claude-opus-4-5'
              const think = model.endsWith('-thinking') || !!body.providerOptions?.thinkingConfig
              const budget = body.providerOptions?.thinkingConfig?.thinkingBudget || 20000

              let retry = 0
              while (true) {
                const count = am.getAccountCount()
                if (count === 0) throw new Error('No accounts. Login first.')
                const acc = am.getCurrentOrNext()
                if (!acc) {
                  const w = am.getMinWaitTime() || 60000
                  await sleep(w)
                  continue
                }

                if (count > 1 && am.shouldShowToast()) client.tui.showToast({ body: { message: `Using ${acc.email}`, variant: 'info' } }).catch(() => {})

                let auth = am.toAuthDetails(acc)
                if (accessTokenExpired(auth)) {
                  try {
                    auth = await refreshAccessToken(auth)
                    am.updateFromAuth(acc, auth)
                    await am.saveToDisk()
                  } catch (e) {
                    if (e instanceof KiroTokenRefreshError && e.code === 'invalid_grant') {
                      am.removeAccount(acc)
                      await am.saveToDisk()
                      continue
                    }
                    throw e
                  }
                }

                const prep = transformToCodeWhisperer(url, init?.body, model, auth, think, budget)
                try {
                  const res = await fetch(prep.url, prep.init)
                  if (res.ok) {
                    if (config.usage_tracking_enabled)
                      fetchUsageLimits(auth)
                        .then((u) => {
                          updateAccountQuota(acc, u, am)
                          am.saveToDisk()
                        })
                        .catch(() => {})
                    if (prep.streaming) {
                      const s = transformKiroStream(res, model, prep.conversationId)
                      return new Response(
                        new ReadableStream({
                          async start(c) {
                            try {
                              for await (const e of s) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
                              c.close()
                            } catch (err) {
                              c.error(err)
                            }
                          }
                        }),
                        { headers: { 'Content-Type': 'text/event-stream' } }
                      )
                    }
                    const text = await res.text()
                    const p = parseEventStream(text)
                    const oai: any = {
                      id: prep.conversationId,
                      object: 'chat.completion',
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [{ index: 0, message: { role: 'assistant', content: p.content }, finish_reason: p.stopReason === 'tool_use' ? 'tool_calls' : 'stop' }],
                      usage: { prompt_tokens: p.inputTokens || 0, completion_tokens: p.outputTokens || 0, total_tokens: (p.inputTokens || 0) + (p.outputTokens || 0) }
                    }
                    if (p.toolCalls.length > 0)
                      oai.choices[0].message.tool_calls = p.toolCalls.map((tc) => ({
                        id: tc.toolUseId,
                        type: 'function',
                        function: { name: tc.name, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) }
                      }))
                    return new Response(JSON.stringify(oai), { headers: { 'Content-Type': 'application/json' } })
                  }

                  if (res.status === 401 && retry < config.rate_limit_max_retries) {
                    retry++
                    continue
                  }
                  if (res.status === 429) {
                    am.markRateLimited(acc, 60000)
                    await am.saveToDisk()
                    continue
                  }
                  if ((res.status === 402 || res.status === 403) && count > 1) {
                    am.markUnhealthy(acc, 'Quota')
                    await am.saveToDisk()
                    continue
                  }
                  throw new Error(`Kiro Error: ${res.status}`)
                } catch (e) {
                  if (isNetworkError(e) && retry < config.rate_limit_max_retries) {
                    await sleep(5000 * Math.pow(2, retry))
                    retry++
                    continue
                  }
                  throw e
                }
              }
            }
          }
        },
        methods: [
          {
            id: 'idc',
            label: 'AWS Builder ID (IDC)',
            type: 'oauth',
            authorize: async () =>
              new Promise(async (resolve) => {
                const region = config.default_region
                const authData = await authorizeKiroIDC(region)
                const { url, waitForAuth } = await startIDCAuthServer(authData)
                resolve({
                  url,
                  instructions: 'Opening browser...',
                  method: 'auto',
                  callback: async () => {
                    try {
                      const res = await waitForAuth()
                      const am = await AccountManager.loadFromDisk(config.account_selection_strategy)
                      const acc: ManagedAccount = {
                        id: generateAccountId(),
                        email: res.email,
                        authMethod: 'idc',
                        region,
                        clientId: res.clientId,
                        clientSecret: res.clientSecret,
                        refreshToken: res.refreshToken,
                        accessToken: res.accessToken,
                        expiresAt: res.expiresAt,
                        rateLimitResetTime: 0,
                        isHealthy: true
                      }
                      try {
                        const u = await fetchUsageLimits({
                          refresh: encodeRefreshToken({ refreshToken: res.refreshToken, clientId: res.clientId, clientSecret: res.clientSecret, authMethod: 'idc' }),
                          access: res.accessToken,
                          expires: res.expiresAt,
                          authMethod: 'idc',
                          region,
                          clientId: res.clientId,
                          clientSecret: res.clientSecret,
                          email: res.email
                        })
                        am.updateUsage(acc.id, { usedCount: u.usedCount, limitCount: u.limitCount, realEmail: u.email })
                      } catch {}
                      am.addAccount(acc)
                      await am.saveToDisk()
                      return { type: 'success', key: res.accessToken }
                    } catch {
                      return { type: 'failed' }
                    }
                  }
                })
              })
          }
        ]
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
