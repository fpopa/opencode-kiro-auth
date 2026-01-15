import type { KiroAuthDetails, RefreshParts } from './types'
import { KiroTokenRefreshError } from './errors'
import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth'

export async function refreshAccessToken(auth: KiroAuthDetails): Promise<KiroAuthDetails> {
  const url = `https://oidc.${auth.region}.amazonaws.com/token`
  const p = decodeRefreshToken(auth.refresh)
  if (!p.clientId || !p.clientSecret) throw new KiroTokenRefreshError('Missing creds', 'MISSING_CREDENTIALS')

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret })
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })

  if (!res.ok) {
    const txt = await res.text()
    let data: any = {}
    try {
      data = JSON.parse(txt)
    } catch {
      data = { message: txt }
    }
    throw new KiroTokenRefreshError(`Refresh failed: ${data.message || data.error_description || txt}`, data.error || `HTTP_${res.status}`)
  }

  const d = await res.json()
  const acc = d.access_token || d.accessToken
  if (!acc) throw new KiroTokenRefreshError('No access token', 'INVALID_RESPONSE')

  const upP: RefreshParts = { refreshToken: d.refresh_token || d.refreshToken || p.refreshToken, clientId: p.clientId, clientSecret: p.clientSecret, authMethod: 'idc' }
  return {
    refresh: encodeRefreshToken(upP),
    access: acc,
    expires: Date.now() + (d.expires_in || 3600) * 1000,
    authMethod: 'idc',
    region: auth.region,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    email: auth.email
  }
}
