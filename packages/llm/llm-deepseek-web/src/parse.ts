/**
 * Split one complete web reply into visible text and tool calls.
 *
 * The web UI has no native tool-call channel, so calls arrive as agreed-upon
 * markers inside the reply text. dsh cannot tell the difference: the adapter
 * emits the same `tool-call` chunk grammar either way.
 *
 * Parsing runs once, on the final reply — never incrementally. The page
 * rewrites text it has already rendered (markdown reflow, escape fixes), so a
 * marker's two halves are not stable until generation stops.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/parse
 */

export const TOOL_CALL_OPEN = '<tool_call>'
export const TOOL_CALL_CLOSE = '</tool_call>'

/** The literal that opens a marked call; the regex below allows attributes after it. */
const TOOL_CALL_OPEN_PREFIX = '<tool_call'

/** The literal that opens a narrated call. */
const NARRATED_PREFIX = '[调用'

/** 开标签容忍属性与空白:模型常写成 `<tool_call name="read">`。 */
const OPEN_RE = /<tool_call\b[^>]*>/gi
const CLOSE_RE = /<\/tool_call\s*>/i

export type SplitEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; raw: string }

export interface ParsedToolCall {
  name: string
  /** Raw JSON string, matching `ToolCallBlock.arguments`. */
  arguments: string
}

/**
 * Parse one marker body; returns null when the model produced unusable JSON.
 *
 * The payload is the first balanced JSON object in `raw`, not `raw` itself. A
 * fenced block loses its backticks when the page renders it, and what survives
 * into `innerText` is the language tag plus the code block's own copy/download
 * button labels — `json\n复制\n下载\n{…}`. Parsing `raw` whole fails on that
 * debris; extracting the object skips any prefix and ignores any suffix.
 */
export function parseToolCall(raw: string): ParsedToolCall | null {
  const open = raw.indexOf('{')
  if (open === -1) return null
  const end = jsonObjectEnd(raw, open)
  if (end === -1) return null
  const parsed = safeJson(raw.slice(open, end))
  if (typeof parsed !== 'object' || parsed === null) return null
  const { name, arguments: args } = parsed as { name?: unknown; arguments?: unknown }
  if (typeof name !== 'string' || !name) return null
  return {
    name,
    arguments: JSON.stringify(args === undefined ? {} : args),
  }
}

/** Parse `text` as JSON, or undefined when it is unusable. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * End offset of the JSON object starting at `open`, or -1 when it never closes.
 * Brace counting skips string literals so a `{` inside an argument value does
 * not unbalance the scan.
 */
function jsonObjectEnd(text: string, open: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i + 1
  }
  return -1
}

/**
 * `[调用 read] {…}` — how the web model announces a call when it ignores the
 * protocol. The site's own system prompt outranks anything the composer says,
 * and this is the form it produces instead; the JSON that follows is the
 * argument object itself, not a `{name, arguments}` wrapper.
 */
const NARRATED_CALL_RE = /\[调用\s+([A-Za-z0-9_.-]+)\]\s*$/

/**
 * Recover calls the model emitted without the agreed marker, in either form it
 * actually uses: the narrated `[调用 name] {args}`, or a bare
 * `{"name":…,"arguments":…}` object. Both are restricted to `knownTools`, so
 * ordinary JSON in a reply is never mistaken for a call.
 */
function* recoverUnmarkedCalls(text: string, knownTools: ReadonlySet<string>): Generator<SplitEvent> {
  // emitted 是尚未交出的正文起点,scan 是下一个候选的搜索起点;
  // 合成一个游标会让被否决的候选连同它前面的正文一起消失。
  let emitted = 0
  let scan = 0
  for (;;) {
    const open = text.indexOf('{', scan)
    if (open === -1) break
    const end = jsonObjectEnd(text, open)
    if (end === -1) break
    const narrated = NARRATED_CALL_RE.exec(text.slice(emitted, open))
    const name = narrated?.[1]
    if (name !== undefined && knownTools.has(name)) {
      // 叙述式:名字在标记里,大括号里是参数本身,补成解析器认识的包装形式。
      const args: unknown = safeJson(text.slice(open, end))
      if (args !== undefined) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- exec 命中即有匹配起点
        const callStart = emitted + narrated!.index
        if (callStart > emitted) yield { kind: 'text', text: text.slice(emitted, callStart) }
        yield { kind: 'tool-call', raw: JSON.stringify({ name, arguments: args }) }
        emitted = scan = end
        continue
      }
    }
    const parsed = parseToolCall(text.slice(open, end))
    if (!parsed || !knownTools.has(parsed.name)) {
      scan = open + 1
      continue
    }
    if (open > emitted) yield { kind: 'text', text: text.slice(emitted, open) }
    yield { kind: 'tool-call', raw: text.slice(open, end) }
    emitted = scan = end
  }
  if (emitted < text.length) yield { kind: 'text', text: text.slice(emitted) }
}

/**
 * Split a complete reply.
 * @param text - the final reply body.
 * @param knownTools - tool names offered this request; gates bare-JSON recovery.
 * @returns visible text and tool-call bodies, in reply order.
 */
export function splitReply(text: string, knownTools: ReadonlySet<string>): SplitEvent[] {
  const events: SplitEvent[] = []
  let cursor = 0
  OPEN_RE.lastIndex = 0
  for (let open = OPEN_RE.exec(text); open !== null; open = OPEN_RE.exec(text)) {
    const bodyStart = open.index + open[0].length
    const rest = text.slice(bodyStart)
    const close = CLOSE_RE.exec(rest)
    // 未闭合说明回复被截断了;把剩下的全当调用体,解析失败会退回可见文本。
    const body = close === null ? rest : rest.slice(0, close.index)
    if (open.index > cursor) events.push(...recoverUnmarkedCalls(text.slice(cursor, open.index), knownTools))
    events.push({ kind: 'tool-call', raw: body.trim() })
    cursor = close === null ? text.length : bodyStart + close.index + close[0].length
    OPEN_RE.lastIndex = cursor
  }
  if (cursor < text.length) events.push(...recoverUnmarkedCalls(text.slice(cursor), knownTools))
  return events
}

/** Everything a reply could use to open a tool call, marked or not. */
const CALL_STARTS = [TOOL_CALL_OPEN_PREFIX, NARRATED_PREFIX, '{'] as const

/** How much of `text`'s tail could still grow into `marker`. */
function heldSuffixLen(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1)
  for (let n = max; n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) return n
  }
  return 0
}

/**
 * How much of a partial reply is safe to show as text.
 *
 * A tool call must not also reach the user as visible text, and text once
 * emitted cannot be withdrawn — so streaming stops at the first thing that
 * could open a call, including a marker the tail is still growing into. The
 * remainder is split once the reply is complete, which is also when a candidate
 * that turned out to be ordinary prose gets released.
 *
 * @param text - the reply so far; the site's deltas only ever append to it.
 * @returns the length of the prefix that cannot be part of a call.
 */
export function visibleEnd(text: string): number {
  let end = text.length
  for (const marker of CALL_STARTS) {
    const at = text.indexOf(marker)
    if (at !== -1 && at < end) end = at
    end = Math.min(end, text.length - heldSuffixLen(text, marker))
  }
  return end
}
