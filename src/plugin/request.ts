import * as crypto from 'crypto'
import * as os from 'os'
import type { KiroAuthDetails, PreparedRequest, CodeWhispererMessage, CodeWhispererRequest } from './types'
import { KIRO_CONSTANTS } from '../constants'
import { resolveKiroModel } from './models'

export function transformToCodeWhisperer(url: string, body: any, model: string, auth: KiroAuthDetails, think = false, budget = 20000): PreparedRequest {
  const req = typeof body === 'string' ? JSON.parse(body) : body
  const { messages, tools, system } = req
  if (!messages || messages.length === 0) throw new Error('No messages')

  const resolved = resolveKiroModel(model)
  const convId = crypto.randomUUID()
  let sys = system || ''
  if (think) {
    const pfx = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
    sys = sys.includes('<thinking_mode>') ? sys : sys ? `${pfx}\n${sys}` : pfx
  }

  const msgs = mergeAdjacentMessages([...messages])
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && lastMsg.role === 'assistant' && getContentText(lastMsg) === '{') msgs.pop()

  const cwTools = tools ? convertToolsToCodeWhisperer(tools) : []
  const history: CodeWhispererMessage[] = []
  let start = 0

  if (sys) {
    const first = msgs[0]
    if (first && first.role === 'user') {
      history.push({ userInputMessage: { content: `${sys}\n\n${getContentText(first)}`, modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } })
      start = 1
    } else history.push({ userInputMessage: { content: sys, modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } })
  }

  for (let i = start; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = [],
        imgs: any[] = []
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') uim.content += p.text || ''
          else if (p.type === 'tool_result') trs.push({ content: [{ text: getContentText(p) }], status: 'success', toolUseId: p.tool_use_id })
          else if (p.type === 'image' && p.source) imgs.push({ format: p.source.media_type?.split('/')[1] || 'png', source: { bytes: p.source.data } })
        }
      } else uim.content = getContentText(m)
      if (imgs.length) uim.images = imgs
      if (trs.length) uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage) history.push({ assistantResponseMessage: { content: 'Continue' } })
      history.push({ userInputMessage: uim })
    } else if (m.role === 'assistant') {
      const arm: any = { content: '' }
      const tus: any[] = []
      let th = ''
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') arm.content += p.text || ''
          else if (p.type === 'thinking') th += p.thinking || p.text || ''
          else if (p.type === 'tool_use') tus.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      } else arm.content = getContentText(m)
      if (th) arm.content = arm.content ? `<thinking>${th}</thinking>\n\n${arm.content}` : `<thinking>${th}</thinking>`
      if (tus.length) arm.toolUses = tus
      const prev = history[history.length - 1]
      if (prev && prev.assistantResponseMessage) history.push({ userInputMessage: { content: 'Continue', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } })
      history.push({ assistantResponseMessage: arm })
    }
  }

  const curMsg = msgs[msgs.length - 1]
  if (!curMsg) throw new Error('Empty')
  let curContent = ''
  const curTrs: any[] = [],
    curImgs: any[] = []
  if (curMsg.role === 'assistant') {
    const arm: any = { content: '' }
    let th = ''
    if (Array.isArray(curMsg.content)) {
      for (const p of curMsg.content) {
        if (p.type === 'text') arm.content += p.text || ''
        else if (p.type === 'thinking') th += p.thinking || p.text || ''
        else if (p.type === 'tool_use') {
          if (!arm.toolUses) arm.toolUses = []
          arm.toolUses.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      }
    } else arm.content = getContentText(curMsg)
    if (th) arm.content = arm.content ? `<thinking>${th}</thinking>\n\n${arm.content}` : `<thinking>${th}</thinking>`
    history.push({ assistantResponseMessage: arm })
    curContent = 'Continue'
  } else {
    const prev = history[history.length - 1]
    if (prev && !prev.assistantResponseMessage) history.push({ assistantResponseMessage: { content: 'Continue' } })
    if (Array.isArray(curMsg.content)) {
      for (const p of curMsg.content) {
        if (p.type === 'text') curContent += p.text || ''
        else if (p.type === 'tool_result') curTrs.push({ content: [{ text: getContentText(p) }], status: 'success', toolUseId: p.tool_use_id })
        else if (p.type === 'image' && p.source) curImgs.push({ format: p.source.media_type?.split('/')[1] || 'png', source: { bytes: p.source.data } })
      }
    } else curContent = getContentText(curMsg)
    if (!curContent) curContent = curTrs.length ? 'Tool results provided.' : 'Continue'
  }

  const request: CodeWhispererRequest = {
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: convId,
      history,
      currentMessage: { userInputMessage: { content: curContent, modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR } }
    }
  }
  const uim = request.conversationState.currentMessage.userInputMessage
  if (uim) {
    if (curImgs.length) uim.images = curImgs
    const ctx: any = {}
    if (curTrs.length) ctx.toolResults = deduplicateToolResults(curTrs)
    if (cwTools.length) ctx.tools = cwTools
    if (Object.keys(ctx).length) uim.userInputMessageContext = ctx
  }

  const machineId = crypto
    .createHash('sha256')
    .update(auth.profileArn || auth.clientId || 'KIRO_DEFAULT_MACHINE')
    .digest('hex')
  const osP = os.platform(),
    osR = os.release(),
    nodeV = process.version.replace('v', ''),
    kiroV = KIRO_CONSTANTS.KIRO_VERSION
  const osN = osP === 'win32' ? `windows#${osR}` : osP === 'darwin' ? `macos#${osR}` : `${osP}#${osR}`
  const ua = `aws-sdk-js/1.0.0 ua/2.1 os/${osN} lang/js md/nodejs#${nodeV} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroV}-${machineId}`

  return {
    url: KIRO_CONSTANTS.BASE_URL.replace('{{region}}', auth.region),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${auth.access}`,
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroV}-${machineId}`,
        'user-agent': ua,
        Connection: 'close'
      },
      body: JSON.stringify(request)
    },
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId
  }
}

export function mergeAdjacentMessages(msgs: any[]): any[] {
  const merged: any[] = []
  for (const m of msgs) {
    if (!merged.length) merged.push({ ...m })
    else {
      const last = merged[merged.length - 1]
      if (last && m.role === last.role) {
        if (Array.isArray(last.content) && Array.isArray(m.content)) last.content.push(...m.content)
        else if (typeof last.content === 'string' && typeof m.content === 'string') last.content += '\n' + m.content
        else if (Array.isArray(last.content) && typeof m.content === 'string') last.content.push({ type: 'text', text: m.content })
        else if (typeof last.content === 'string' && Array.isArray(m.content)) last.content = [{ type: 'text', text: last.content }, ...m.content]
      } else merged.push({ ...m })
    }
  }
  return merged
}

export function convertToolsToCodeWhisperer(tools: any[]): any[] {
  return tools
    .filter((t) => !['web_search', 'websearch'].includes((t.name || t.function?.name || '').toLowerCase()))
    .map((t) => ({
      toolSpecification: {
        name: t.name || t.function?.name,
        description: (t.description || t.function?.description || '').substring(0, 9216),
        inputSchema: { json: t.input_schema || t.function?.parameters || {} }
      }
    }))
}

function getContentText(m: any): string {
  if (!m) return ''
  if (typeof m === 'string') return m
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content))
    return m.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('')
  return m.text || ''
}

function deduplicateToolResults(trs: any[]): any[] {
  const u: any[] = [],
    s = new Set()
  for (const t of trs) {
    if (!s.has(t.toolUseId)) {
      s.add(t.toolUseId)
      u.push(t)
    }
  }
  return u
}
