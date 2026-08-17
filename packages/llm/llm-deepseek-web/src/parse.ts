/**
 * Split the web session's plain-text stream into visible text and tool calls.
 *
 * The web UI has no native tool-call channel, so calls arrive as agreed-upon
 * markers inside the text. dsh cannot tell the difference: the adapter emits
 * the same `tool-call` chunk grammar either way.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/parse
 */

export const TOOL_CALL_OPEN = '<tool_call>'
export const TOOL_CALL_CLOSE = '</tool_call>'

export type SplitEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; raw: string }

/** How much of `buf`'s tail could still grow into `marker`. */
function heldSuffixLen(buf: string, marker: string): number {
  const max = Math.min(buf.length, marker.length - 1)
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(marker.slice(0, n))) return n
  }
  return 0
}

/**
 * Incremental splitter. Feed arbitrary chunks; it withholds only the bytes that
 * could still turn into a marker, so text stays streamable.
 */
export class ToolCallSplitter {
  private buf = ''
  private inCall = false

  push(chunk: string): SplitEvent[] {
    this.buf += chunk
    const events: SplitEvent[] = []
    for (;;) {
      if (this.inCall) {
        const end = this.buf.indexOf(TOOL_CALL_CLOSE)
        if (end === -1) return events
        events.push({ kind: 'tool-call', raw: this.buf.slice(0, end).trim() })
        this.buf = this.buf.slice(end + TOOL_CALL_CLOSE.length)
        this.inCall = false
        continue
      }
      const start = this.buf.indexOf(TOOL_CALL_OPEN)
      if (start === -1) break
      if (start > 0) events.push({ kind: 'text', text: this.buf.slice(0, start) })
      this.buf = this.buf.slice(start + TOOL_CALL_OPEN.length)
      this.inCall = true
    }
    // 尾部可能是 <tool_call> 的半截,扣住等下一块,其余可以安全放行。
    const held = heldSuffixLen(this.buf, TOOL_CALL_OPEN)
    const emit = this.buf.slice(0, this.buf.length - held)
    this.buf = this.buf.slice(this.buf.length - held)
    if (emit) events.push({ kind: 'text', text: emit })
    return events
  }

  /** Drain whatever is left when the stream ends. */
  flush(): SplitEvent[] {
    const rest = this.buf
    this.buf = ''
    if (!rest) return []
    // 未闭合的工具调用是模型跑格式了;当作普通文本交出去,由上层决定是否重试。
    if (this.inCall) {
      this.inCall = false
      return [{ kind: 'text', text: TOOL_CALL_OPEN + rest }]
    }
    return [{ kind: 'text', text: rest }]
  }
}

export interface ParsedToolCall {
  name: string
  /** Raw JSON string, matching `ToolCallBlock.arguments`. */
  arguments: string
}

/** Parse one marker body; returns null when the model produced unusable JSON. */
export function parseToolCall(raw: string): ParsedToolCall | null {
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { name, arguments: args } = parsed as { name?: unknown; arguments?: unknown }
  if (typeof name !== 'string' || !name) return null
  return {
    name,
    arguments: JSON.stringify(args === undefined ? {} : args),
  }
}
