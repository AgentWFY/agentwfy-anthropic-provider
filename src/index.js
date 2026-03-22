/**
 * Anthropic provider plugin.
 * Uses Claude Pro/Max subscription via OAuth (PKCE).
 */

const PROVIDER_ID = 'anthropic'
const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'
const DEFAULT_BASE_URL = 'https://api.anthropic.com'

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14'

const CONFIG_KEYS = {
  modelId: 'plugin.anthropic-provider.modelId',
  maxTokens: 'plugin.anthropic-provider.maxTokens',
  oauthAccess: 'plugin.anthropic-provider.oauthAccess',
  oauthRefresh: 'plugin.anthropic-provider.oauthRefresh',
  oauthExpires: 'plugin.anthropic-provider.oauthExpires',
  hideThinking: 'plugin.anthropic-provider.hideThinking',
  hideIntermediateSteps: 'plugin.anthropic-provider.hideIntermediateSteps',
}

/** Convert tools from ProviderSessionConfig format to Anthropic API format */
function convertTools(tools) {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}

// ── SSE parser ──

async function* parseSSE(response) {
  if (!response.body) throw new Error('Response body is null')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent
  let dataLines = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (let line of lines) {
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          if (dataLines.length > 0) {
            yield { event: currentEvent, data: dataLines.join('\n') }
            dataLines = []
            currentEvent = undefined
          }
          continue
        }
        if (line.startsWith(':')) continue
        const colonIndex = line.indexOf(':')
        if (colonIndex === -1) continue
        const field = line.slice(0, colonIndex)
        let val = line.slice(colonIndex + 1)
        if (val.startsWith(' ')) val = val.slice(1)
        if (field === 'event') currentEvent = val
        else if (field === 'data') dataLines.push(val)
      }
    }
    buffer += decoder.decode(new Uint8Array(), { stream: false })
    if (buffer) {
      const line = buffer
      if (line !== '' && !line.startsWith(':')) {
        const colonIndex = line.indexOf(':')
        if (colonIndex !== -1) {
          const field = line.slice(0, colonIndex)
          let val = line.slice(colonIndex + 1)
          if (val.startsWith(' ')) val = val.slice(1)
          if (field === 'event') currentEvent = val
          else if (field === 'data') dataLines.push(val)
        }
      }
    }
    if (dataLines.length > 0) {
      yield { event: currentEvent, data: dataLines.join('\n') }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Context overflow detection ──
// Anthropic returns: { "error": { "type": "invalid_request_error", "message": "prompt is too long: 213462 tokens > 200000 maximum" } }

function isContextOverflow(responseText) {
  try {
    const body = JSON.parse(responseText)
    const err = body && body.error
    return err && err.type === 'invalid_request_error'
      && typeof err.message === 'string'
      && err.message.startsWith('prompt is too long')
  } catch {
    return false
  }
}

// ── Context compaction ──

const COMPACTION_SYSTEM_PROMPT = 'You are a conversation summarizer. Produce a concise, structured summary that another LLM will use to continue the work. Never refuse, never add commentary.'

const COMPACTION_PROMPT = `Summarize the conversation above into a structured context checkpoint. Use this format:

## Goal
[What the user is trying to accomplish]

## Progress
- [x] [Completed tasks]
- [ ] [In-progress tasks]

## Key Decisions
- [Important decisions and rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [File paths, function names, data, or references needed to continue]

Be concise. Preserve exact file paths, function names, and error messages.`

const COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages since the last summary. Update the existing summary provided in <previous-summary> tags.

RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from in-progress to completed when done
- UPDATE Next Steps based on what was accomplished
- If something is no longer relevant, remove it

Use the same format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Progress
- [x] [Include previously done items AND newly completed items]
- [ ] [Current work — update based on progress]

## Key Decisions
- [Preserve all previous, add new]

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Be concise. Preserve exact file paths, function names, and error messages.`

const COMPACTION_MARKER = '[Context compacted'
const SERIALIZE_MAX_CHARS = 100_000

function serializeMessages(messages) {
  const parts = []
  let totalChars = 0
  for (const msg of messages) {
    if (totalChars >= SERIALIZE_MAX_CHARS) break
    const role = msg.role === 'assistant' ? 'Assistant' : 'User'
    if (!Array.isArray(msg.content)) continue
    const textParts = []
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) textParts.push(block.text.slice(0, 2000))
      else if (block.type === 'tool_use') textParts.push(`[Tool call: ${block.name}]`)
      else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : ''
        textParts.push(`[Tool result: ${content.slice(0, 500)}]`)
      }
    }
    if (textParts.length > 0) {
      const entry = `${role}: ${textParts.join('\n')}`
      parts.push(entry)
      totalChars += entry.length
    }
  }
  return parts.join('\n\n')
}

// ── Retry ──

const MAX_RETRIES = 2
const INITIAL_DELAY_MS = 500

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status === 529 || status >= 500
}

function getRetryDelay(attempt, headers) {
  // Respect Retry-After header if present
  const retryAfter = headers && headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (!isNaN(seconds) && seconds > 0 && seconds <= 60) return seconds * 1000
  }
  // Exponential backoff with jitter
  const base = INITIAL_DELAY_MS * Math.pow(2, attempt)
  return base + Math.random() * base * 0.5
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('aborted')); return }
    const done = (fn, val) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(val) }
    const onAbort = () => done(reject, new Error('aborted'))
    const timer = setTimeout(() => done(resolve), ms)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ── Helpers ──

function formatTokens(tokens) {
  if (tokens >= 1000) return (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(tokens)
}

function addCacheBreakpoints(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') {
      const content = msg.content
      if (content && content.length > 0) {
        content[content.length - 1].cache_control = { type: 'ephemeral' }
      }
      break
    }
  }
}

// ── OAuth token refresh (main process, Node.js fetch) ──

let _refreshLock = null

async function getApiKey(getConfig, setConfig) {
  const access = getConfig(CONFIG_KEYS.oauthAccess, '')
  const refresh = getConfig(CONFIG_KEYS.oauthRefresh, '')
  const expires = getConfig(CONFIG_KEYS.oauthExpires, 0)

  if (!access || !refresh) {
    return ''
  }

  // Token still valid (60s buffer)
  if (Date.now() < expires - 60_000) {
    return access
  }

  // Need refresh — serialize concurrent attempts
  if (_refreshLock) {
    await _refreshLock
    const updatedAccess = getConfig(CONFIG_KEYS.oauthAccess, '')
    const updatedExpires = getConfig(CONFIG_KEYS.oauthExpires, 0)
    if (updatedAccess && Date.now() < updatedExpires - 60_000) {
      return updatedAccess
    }
  }

  let resolve
  _refreshLock = new Promise(r => { resolve = r })

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refresh,
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error(`[anthropic-provider] Token refresh failed (${response.status}): ${text}`)
      // Return expired access token — the API call will fail with 401
      // which is better than silently returning empty
      return access
    }

    const payload = await response.json()
    if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== 'number') {
      console.error('[anthropic-provider] Token refresh response missing fields')
      return access
    }

    const newAccess = payload.access_token
    const newRefresh = payload.refresh_token
    const newExpires = Date.now() + payload.expires_in * 1000 - 5 * 60 * 1000

    setConfig(CONFIG_KEYS.oauthAccess, newAccess)
    setConfig(CONFIG_KEYS.oauthRefresh, newRefresh)
    setConfig(CONFIG_KEYS.oauthExpires, newExpires)

    return newAccess
  } catch (err) {
    console.error('[anthropic-provider] Token refresh error:', err)
    return access
  } finally {
    resolve()
    _refreshLock = null
  }
}

// ── Session class ──

class AnthropicSession {
  constructor(config, providerConfig, initialMessages, initialDisplayMessages) {
    this._config = config
    this._providerConfig = providerConfig
    this._messages = initialMessages ? initialMessages.slice() : []
    this._displayMessages = initialDisplayMessages ? initialDisplayMessages.slice() : []
    this._listeners = new Set()
    this._abortController = null
    this._lastInputTokens = 0
    this._pendingToolIds = new Set()
    this._truncationRetries = 0
    if (initialMessages) {
      this._repairOrphanedToolUse()
      this._mergeConsecutiveSameRole()
    }
  }

  _mergeConsecutiveSameRole() {
    let modified = false
    for (let i = 1; i < this._messages.length; i++) {
      const prev = this._messages[i - 1]
      const msg = this._messages[i]
      if (prev.role === msg.role && Array.isArray(prev.content) && Array.isArray(msg.content)) {
        prev.content.push(...msg.content)
        this._messages.splice(i, 1)
        i--
        modified = true
      }
    }
    return modified
  }

  send(event) {
    switch (event.type) {
      case 'user_message':
        this._handleUserMessage(event.text, event.images)
        break
      case 'exec_js_result':
        this._handleExecJsResult(event.id, event.content, event.isError)
        break
      case 'abort':
        if (this._abortController) this._abortController.abort()
        break
    }
  }

  on(listener) {
    this._listeners.add(listener)
    listener({ type: 'status_line', text: this._buildStatusLine() })
  }

  off(listener) {
    this._listeners.delete(listener)
  }

  getDisplayMessages() {
    const msgs = this._displayMessages
    if (!this._providerConfig.hideIntermediateSteps && !this._providerConfig.hideThinking) {
      return msgs.slice()
    }
    const result = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      if (msg.role === 'user') {
        result.push(msg)
        continue
      }
      // For assistant messages: skip intermediate steps if enabled
      if (this._providerConfig.hideIntermediateSteps) {
        const next = msgs[i + 1]
        if (next && next.role !== 'user') continue // not the last assistant in this group
      }
      // Filter out thinking blocks if enabled
      if (this._providerConfig.hideThinking && msg.blocks.some(b => b.type === 'thinking')) {
        result.push({ ...msg, blocks: msg.blocks.filter(b => b.type !== 'thinking') })
      } else {
        result.push(msg)
      }
    }
    return result
  }

  getState() {
    return { messages: this._messages.slice(), displayMessages: this._displayMessages.slice() }
  }

  _buildStatusLine() {
    const parts = [this._providerConfig.modelId]
    if (this._lastInputTokens > 0) {
      parts.push(formatTokens(this._lastInputTokens))
    }
    return parts.join(' · ')
  }

  _emitStatusLine() {
    this._emit({ type: 'status_line', text: this._buildStatusLine() })
  }

  _buildHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Authorization': `Bearer ${apiKey}`,
      'user-agent': 'claude-cli/2.1.75',
      'x-app': 'cli',
      'anthropic-beta': BETA_HEADER,
    }
  }

  async _compactMessages() {
    const msgs = this._messages
    if (msgs.length <= 6) return false

    const keepFromEnd = Math.max(6, Math.ceil(msgs.length / 2))
    let splitIdx = msgs.length - keepFromEnd
    // Find a user message that starts a new turn (not a tool_result continuation)
    while (splitIdx < msgs.length) {
      const msg = msgs[splitIdx]
      if (msg.role === 'user' && Array.isArray(msg.content)
        && !msg.content.some(b => b.type === 'tool_result')) {
        break
      }
      splitIdx++
    }
    if (splitIdx <= 0 || splitIdx >= msgs.length - 2) return false

    const oldMessages = msgs.slice(0, splitIdx)
    const keptMessages = msgs.slice(splitIdx)

    // Check if there's a previous compaction summary to build upon
    let previousSummary = null
    if (oldMessages.length > 0 && oldMessages[0].role === 'user' && Array.isArray(oldMessages[0].content)) {
      const firstText = oldMessages[0].content.find(b => b.type === 'text')
      if (firstText && firstText.text && firstText.text.startsWith(COMPACTION_MARKER)) {
        previousSummary = firstText.text
      }
    }

    let summary
    try {
      const apiKey = await this._providerConfig.getApiKey()
      if (!apiKey) return false

      const conversationText = serializeMessages(oldMessages)
      let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
      if (previousSummary) {
        promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
        promptText += COMPACTION_UPDATE_PROMPT
      } else {
        promptText += COMPACTION_PROMPT
      }

      const response = await fetch(`${DEFAULT_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: this._buildHeaders(apiKey),
        body: JSON.stringify({
          model: this._providerConfig.modelId,
          system: [{ type: 'text', text: COMPACTION_SYSTEM_PROMPT }],
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: promptText }],
          }],
          max_tokens: 4096,
        }),
      })

      if (!response.ok) {
        console.error('[anthropic-provider] Compaction summarization failed:', response.status)
        return false
      }

      const result = await response.json()
      summary = (result.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
    } catch (err) {
      console.error('[anthropic-provider] Compaction summarization error:', err)
      return false
    }

    if (!summary) return false

    const compactionText = `[Context compacted — ${oldMessages.length} earlier messages summarized]\n\n${summary}`
    this._messages = [
      { role: 'user', content: [{ type: 'text', text: compactionText }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Understood, I have the context from the summary. Continuing.' }] },
      ...keptMessages,
    ]
    this._displayMessages.push({
      role: 'assistant',
      blocks: [{ type: 'text', text: compactionText }],
      timestamp: Date.now(),
    })
    this._emit({ type: 'state_changed' })
    return true
  }

  _emitError(error, partialBlocks) {
    const blocks = partialBlocks ? [...partialBlocks] : []
    blocks.push({ type: 'error', text: error })
    this._displayMessages.push({ role: 'assistant', blocks, timestamp: Date.now() })
    this._emit({ type: 'error', error })
  }

  _emit(event) {
    for (const listener of this._listeners) {
      listener(event)
    }
  }

  _repairOrphanedToolUse() {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const msg = this._messages[i]
      if (msg.role !== 'assistant') continue
      const toolUseIds = []
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) toolUseIds.push(block.id)
        }
      }
      if (toolUseIds.length === 0) return

      const resolved = new Set()
      for (let j = i + 1; j < this._messages.length; j++) {
        const next = this._messages[j]
        if (next.role === 'user' && Array.isArray(next.content)) {
          for (const block of next.content) {
            if (block.type === 'tool_result' && block.tool_use_id) resolved.add(block.tool_use_id)
          }
        }
      }

      const unresolved = toolUseIds.filter(id => !resolved.has(id))
      if (unresolved.length === 0) return

      const toolResults = unresolved.map(id => ({
        type: 'tool_result',
        tool_use_id: id,
        content: 'Tool execution was interrupted.',
        is_error: true,
      }))

      // Merge into the next user message if it exists (Anthropic requires strict alternation),
      // otherwise insert a new user message
      const nextIdx = i + 1
      if (nextIdx < this._messages.length && this._messages[nextIdx].role === 'user') {
        const nextMsg = this._messages[nextIdx]
        const existing = Array.isArray(nextMsg.content) ? nextMsg.content : []
        nextMsg.content = [...toolResults, ...existing]
      } else {
        this._messages.splice(nextIdx, 0, { role: 'user', content: toolResults })
      }
      return
    }
  }

  _handleUserMessage(text, images) {
    const content = [{ type: 'text', text }]
    if (images) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        })
      }
    }

    // Anthropic requires strict role alternation. If the last message is already
    // a user message (e.g. after repair merged tool_results), append to it.
    const last = this._messages[this._messages.length - 1]
    if (last && last.role === 'user') {
      last.content = [...(Array.isArray(last.content) ? last.content : []), ...content]
    } else {
      this._messages.push({ role: 'user', content })
    }

    const blocks = [{ type: 'text', text }]
    if (images) {
      for (const img of images) {
        blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data })
      }
    }
    this._displayMessages.push({ role: 'user', blocks, timestamp: Date.now() })
    this._emit({ type: 'state_changed' })

    this._stream()
  }

  _handleExecJsResult(id, content, isError) {
    const resultContent = content.map(c => {
      if (c.type === 'text') return { type: 'text', text: c.text }
      if (c.type === 'image') {
        return {
          type: 'image',
          source: { type: 'base64', media_type: c.mimeType, data: c.data },
        }
      }
      return { type: 'text', text: '' }
    })
    this._messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: resultContent,
        is_error: isError,
      }],
    })

    const lastAssistant = this._displayMessages.length > 0
      ? this._displayMessages[this._displayMessages.length - 1]
      : null
    if (lastAssistant && lastAssistant.role === 'assistant') {
      lastAssistant.blocks.push({ type: 'exec_js_result', id, content, isError })
    }

    this._pendingToolIds.delete(id)
    if (this._pendingToolIds.size === 0) {
      // All tool results received — safe to persist now
      this._emit({ type: 'state_changed' })
      this._stream()
    }
  }

  async _stream() {
    this._abortController = new AbortController()
    const signal = this._abortController.signal

    const apiKey = await this._providerConfig.getApiKey()
    if (!apiKey) {
      this._emitError('Not authenticated. Open provider settings to log in.')
      return
    }

    const modelId = this._providerConfig.modelId
    const url = `${DEFAULT_BASE_URL}/v1/messages`
    const maxTokens = this._providerConfig.maxTokens || 16384

    const headers = this._buildHeaders(apiKey)

    const system = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: this._config.systemPrompt, cache_control: { type: 'ephemeral' } },
    ]

    // Deep-copy messages for cache breakpoint mutation
    const convertedMessages = this._messages.map(m => ({
      role: m.role,
      content: m.content.map(c => ({ ...c })),
    }))
    addCacheBreakpoints(convertedMessages)

    const body = {
      model: modelId,
      system,
      messages: convertedMessages,
      stream: true,
      max_tokens: maxTokens,
    }

    body.tools = convertTools(this._config.tools)
    body.thinking = { type: 'adaptive' }

    this._emit({ type: 'start' })
    this._emitStatusLine()

    const bodyJson = JSON.stringify(body)
    let response
    let lastError = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        try {
          await sleep(getRetryDelay(attempt - 1, response?.headers), signal)
        } catch {
          this._emit({ type: 'done' })
          return
        }
      }

      try {
        response = await fetch(url, { method: 'POST', headers, body: bodyJson, signal })
      } catch (err) {
        if (signal.aborted) {
          this._emit({ type: 'done' })
          return
        }
        lastError = err instanceof Error ? err.message : String(err)
        continue // network error → retry
      }

      if (response.ok) {
        lastError = null
        break
      }

      // Non-retryable error responses
      if (!isRetryableStatus(response.status)) {
        const text = await response.text().catch(() => '')
        if (isContextOverflow(text) && await this._compactMessages()) {
          this._stream()
          return
        }
        this._emitError(`Anthropic API error (${response.status}): ${text || response.statusText}`)
        return
      }

      // Retryable status — consume body before retry
      lastError = `Anthropic API error (${response.status}): ${await response.text().catch(() => response.statusText)}`
    }

    if (lastError) {
      this._emitError(lastError)
      return
    }

    let assistantText = ''
    let thinkingText = ''
    const assistantContent = []
    const toolCalls = new Map()
    const pendingTools = []
    let inputTokens = 0
    let currentBlockType = null
    let currentBlockIndex = -1
    let streamDone = false

    try {
      for await (const sseEvent of parseSSE(response)) {
        if (signal.aborted || streamDone) break

        let data
        try {
          data = JSON.parse(sseEvent.data)
        } catch {
          continue
        }

        const eventType = sseEvent.event || data.type

        switch (eventType) {
          case 'message_start': {
            const message = data.message
            if (message && message.usage) {
              inputTokens = (message.usage.input_tokens || 0)
                + (message.usage.cache_read_input_tokens || 0)
                + (message.usage.cache_creation_input_tokens || 0)
            }
            break
          }

          case 'content_block_start': {
            currentBlockIndex = data.index != null ? data.index : assistantContent.length
            const block = data.content_block
            currentBlockType = block ? block.type : null

            if (currentBlockType === 'text') {
              assistantContent.push({ type: 'text', text: block.text || '' })
            } else if (currentBlockType === 'thinking') {
              assistantContent.push({ type: 'thinking', thinking: block.thinking || '' })
            } else if (currentBlockType === 'redacted_thinking') {
              assistantContent.push({ type: 'redacted_thinking', data: block.data || '' })
            } else if (currentBlockType === 'tool_use') {
              const id = block.id || ''
              const name = block.name || ''
              assistantContent.push({ type: 'tool_use', id, name, input: {} })
              toolCalls.set(currentBlockIndex, { id, name, arguments: '' })
            }
            break
          }

          case 'content_block_delta': {
            const delta = data.delta
            if (!delta) break
            const deltaType = delta.type
            const contentIndex = data.index != null ? data.index : currentBlockIndex

            if (deltaType === 'text_delta' && typeof delta.text === 'string') {
              assistantText += delta.text
              const textBlock = assistantContent[contentIndex]
              if (textBlock) textBlock.text = (textBlock.text || '') + delta.text
              this._emit({ type: 'text_delta', delta: delta.text })
            } else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
              thinkingText += delta.thinking
              const thinkBlock = assistantContent[contentIndex]
              if (thinkBlock) thinkBlock.thinking = (thinkBlock.thinking || '') + delta.thinking
              if (!this._providerConfig.hideThinking) {
                this._emit({ type: 'thinking_delta', delta: delta.thinking })
              }
            } else if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
              const thinkBlock = assistantContent[contentIndex]
              if (thinkBlock) thinkBlock.signature = (thinkBlock.signature || '') + delta.signature
            } else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const entry = toolCalls.get(contentIndex)
              if (entry) {
                entry.arguments += delta.partial_json
              }
            }
            break
          }

          case 'content_block_stop': {
            const contentIndex = data.index != null ? data.index : currentBlockIndex
            if (currentBlockType === 'tool_use') {
              const entry = toolCalls.get(contentIndex)
              if (entry) {
                let args = {}
                try { args = JSON.parse(entry.arguments) } catch {}
                const toolBlock = assistantContent[contentIndex]
                if (toolBlock) toolBlock.input = args
                pendingTools.push({
                  id: entry.id,
                  name: entry.name,
                  description: typeof args.description === 'string' ? args.description : 'Executing code',
                  code: typeof args.code === 'string' ? args.code : '',
                })
              }
            }
            currentBlockType = null
            break
          }

          case 'message_delta':
            break

          case 'message_stop':
            streamDone = true
            break

          case 'error': {
            const error = data.error
            const msg = (error && error.message) ? error.message : 'Unknown Anthropic API error'
            const partialBlocks = []
            if (thinkingText) partialBlocks.push({ type: 'thinking', text: thinkingText })
            if (assistantText) partialBlocks.push({ type: 'text', text: assistantText })
            this._emitError(msg, partialBlocks)
            return
          }
        }
      }
    } catch (err) {
      if (signal.aborted) {
        this._emit({ type: 'done' })
        return
      }
      const partialBlocks = []
      if (thinkingText) partialBlocks.push({ type: 'thinking', text: thinkingText })
      if (assistantText) partialBlocks.push({ type: 'text', text: assistantText })
      this._emitError(err instanceof Error ? err.message : String(err), partialBlocks)
      return
    }

    // Handle tool_use blocks that were started but never finalized
    // (no content_block_stop — happens when max_tokens truncates mid-block).
    // Keep them in the message and add error tool_results so the model
    // sees what happened and tries a different approach.
    const finalizedToolIds = new Set(pendingTools.map(pt => pt.id))
    const truncatedToolIds = []
    for (const block of assistantContent) {
      if (block.type === 'tool_use' && block.id && !finalizedToolIds.has(block.id)) {
        truncatedToolIds.push(block.id)
      }
    }

    this._messages.push({ role: 'assistant', content: assistantContent })

    if (truncatedToolIds.length > 0) {
      this._messages.push({
        role: 'user',
        content: truncatedToolIds.map(id => ({
          type: 'tool_result',
          tool_use_id: id,
          content: 'Your response was truncated by the output token limit before this tool call could be completed. Try a shorter response or split the work into smaller tool calls.',
          is_error: true,
        })),
      })
    }

    const blocks = []
    if (thinkingText) blocks.push({ type: 'thinking', text: thinkingText })
    if (assistantText) blocks.push({ type: 'text', text: assistantText })
    for (const pt of pendingTools) {
      blocks.push({ type: 'exec_js', id: pt.id, description: pt.description, code: pt.code })
    }
    this._displayMessages.push({ role: 'assistant', blocks, timestamp: Date.now() })

    if (inputTokens > 0) {
      this._lastInputTokens = inputTokens
      this._emitStatusLine()
    }

    // Truncated tool calls: persist and auto-retry so the model sees the error
    if (truncatedToolIds.length > 0) {
      this._truncationRetries++
      this._emit({ type: 'state_changed' })
      if (this._truncationRetries > 3) {
        this._truncationRetries = 0
        this._emit({ type: 'done' })
      } else {
        this._stream()
      }
      return
    }
    this._truncationRetries = 0

    if (pendingTools.length > 0) {
      for (const pt of pendingTools) {
        this._pendingToolIds.add(pt.id)
      }
      for (const pt of pendingTools) {
        this._emit({ type: 'exec_js', id: pt.id, description: pt.description, code: pt.code })
      }
      return
    }

    // No pending tools — safe to persist
    this._emit({ type: 'state_changed' })
    this._emit({ type: 'done' })
  }
}

// ── Factory ──

function createFactory(getConfig, setConfig) {
  function readProviderConfig() {
    return {
      modelId: getConfig(CONFIG_KEYS.modelId, DEFAULT_MODEL_ID),
      maxTokens: getConfig(CONFIG_KEYS.maxTokens, 16384),
      hideThinking: getConfig(CONFIG_KEYS.hideThinking, false),
      hideIntermediateSteps: getConfig(CONFIG_KEYS.hideIntermediateSteps, false),
      getApiKey: () => getApiKey(getConfig, setConfig),
    }
  }

  return {
    id: PROVIDER_ID,
    name: 'Anthropic',
    settingsView: 'plugin.anthropic-provider.settings',

    getStatusLine() {
      return getConfig(CONFIG_KEYS.modelId, DEFAULT_MODEL_ID)
    },

    createSession(config) {
      return new AnthropicSession(config, readProviderConfig())
    },

    restoreSession(config, state) {
      const s = state || {}
      const apiMessages = Array.isArray(s.messages) ? s.messages : []
      const displayMessages = Array.isArray(s.displayMessages) ? s.displayMessages : []
      return new AnthropicSession(config, readProviderConfig(), apiMessages, displayMessages)
    },
  }
}

// ── Plugin entry point ──

module.exports = {
  activate(api) {
    api.registerProvider(createFactory(
      (key, fallback) => api.getConfig(key, fallback),
      (key, value) => api.setConfig(key, value),
    ))
  },
}
