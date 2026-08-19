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

import { jsonrepair } from 'jsonrepair'

/** 协议约定的开标签；也用于历史回放与 {@link visibleEnd} 的扣留判断。 */
export const TOOL_CALL_OPEN = '<tool_call>'
/** 协议约定的闭标签；模型漏写它时边界改由围栏结束确定。 */
export const TOOL_CALL_CLOSE = '</tool_call>'

/** The literal that opens a marked call; the regex below allows attributes after it. */
const TOOL_CALL_OPEN_PREFIX = '<tool_call'

/** The literal that opens a narrated call. */
const NARRATED_PREFIX = '[调用'

/** 开标签容忍属性与空白:模型常写成 `<tool_call name="read">`。 */
const OPEN_RE = /<tool_call\b[^>]*>/gi

/**
 * 协议要求载荷放在 ```json 围栏里，所以围栏就是一个调用的边界。
 * 末尾允许缺失闭合围栏：回复被截断时，最后一个块收不到 ``` 。
 */
const FENCE_RE = /```json[^\n]*\n([\s\S]*?)(?:\n```|$)/g

/** 同一模式的非全局副本：用来在一段文本里定位第一个围栏，不触碰 FENCE_RE 的 lastIndex。 */
const FENCE_ONE = /```json[^\n]*\n[\s\S]*?(?:\n```|$)/
const CLOSE_RE = /<\/tool_call\s*>/i

/**
 * 切分回复得到的一段结果：可见文本，或一个调用的躯体。
 *
 * `raw` 在解析成功时携带规范化后的 JSON（含修复结果），失败时保留原文，由适配器
 * 记一条 warn 后退回可见文本。
 */
export type SplitEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; raw: string }

/** 一个已解析出来的调用。 */
export interface ParsedToolCall {
  /** 工具名；调用方负责校验它是否属于本轮提供的工具。 */
  name: string
  /** 参数的 JSON 文本，与 `ToolCallBlock.arguments` 对齐。 */
  arguments: string
}

/**
 * 解析一段标记躯体；模型给出的 JSON 不可用时返回 null。
 *
 * 载荷取的是 `raw` 里**第一个平衡的 JSON 对象**，而不是 `raw` 整体：代码块渲染后
 * 反引号消失，留在 `innerText` 里的是语言标签加代码块自己的「复制/下载」按钮文字
 * （`json\n复制\n下载\n{…}`），整段 parse 必然失败，而只取对象能跳过任何前缀、
 * 忽略任何后缀。
 * @param raw - 标记躯体或围栏内的原始文本。
 * @returns 解析出的调用；JSON 不可用或缺 `name` 时返回 null。
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
 * 修一次模型写坏的载荷；无从修复时返回 null。
 *
 * 它之所以安全，一是围栏已经把边界圈定在一个调用之内，二是修完仍须通过三道闸门：
 * 能解析、带 `name`、且 `name` 是本轮提供的工具。除了长 `arguments` 末尾漏掉的
 * 右括号，它还能救回被截断的字符串，以及模型惯用的单引号／尾逗号写法。修出来的
 * `arguments` 可能不完整，那时工具执行层会拒绝它，模型据此改正——这比让回合悄悄
 * 自称完成要好。
 * @param json - 围栏内的原始载荷文本。
 * @returns 修复后的 JSON 文本；jsonrepair 认为无从修复时返回 null。
 */
function repairPayload(json: string): string | null {
  try {
    return jsonrepair(json)
  } catch {
    // JSONRepairError：输入无从修复（散文、半个键名）。它不是调用，交给调用方按文本处理。
    return null
  }
}

/**
 * 解析一段载荷，原样解析不出来就修一次再试。
 *
 * 两条恢复路径共用它，所以带标记的调用和裸围栏得到同样的待遇——模型漏掉最外层
 * 括号这件事，跟它有没有写标记无关。
 * @param payload - 来自标记躯体或围栏的载荷文本。
 * @returns 调用；修完仍然得不到调用时返回 null。
 */
function parseOrRepair(payload: string): ParsedToolCall | null {
  const direct = parseToolCall(payload)
  if (direct !== null) return direct
  const repaired = repairPayload(payload)
  return repaired === null ? null : parseToolCall(repaired)
}

/**
 * `[调用 read] {…}` — how the web model announces a call when it ignores the
 * protocol. The site's own system prompt outranks anything the composer says,
 * and this is the form it produces instead; the JSON that follows is the
 * argument object itself, not a `{name, arguments}` wrapper.
 */
const NARRATED_CALL_RE = /\[调用\s+([A-Za-z0-9_.-]+)\]\s*$/

/**
 * 恢复围栏之外的调用，覆盖模型实际用的两种写法：叙述式 `[调用 name] {args}`，
 * 以及裸的 `{"name":…,"arguments":…}` 对象。两者都以 `knownTools` 为闸门，所以
 * 回复里普通的 JSON 不会被误当成调用。
 */
function* recoverBareCalls(text: string, knownTools: ReadonlySet<string>): Generator<SplitEvent> {
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
 * 先恢复围栏里的调用，再退回到无围栏的写法。
 *
 * 围栏正是协议要求的载荷边界，所以每一块各自独立解析。跨整段回复数括号做不到这
 * 件事：只要一块漏了最后的 `}`，它后面的每一块都会被吞进来，整段退化成可见文本
 * ——而循环会把那读成一个已完成的回合。
 * @param text - 已经不含 `<tool_call>` 标记的回复文本。
 * @param knownTools - 本轮提供的工具名。
 * @returns 按回复顺序排列的可见文本与调用躯体。
 */
function* recoverUnmarkedCalls(text: string, knownTools: ReadonlySet<string>): Generator<SplitEvent> {
  let emitted = 0
  FENCE_RE.lastIndex = 0
  for (let fence = FENCE_RE.exec(text); fence !== null; fence = FENCE_RE.exec(text)) {
    const payload = fence[1] ?? ''
    const parsed = parseOrRepair(payload)
    if (!parsed || !knownTools.has(parsed.name)) continue
    if (fence.index > emitted) yield* recoverBareCalls(text.slice(emitted, fence.index), knownTools)
    yield { kind: 'tool-call', raw: JSON.stringify({ name: parsed.name, arguments: safeJson(parsed.arguments) }) }
    emitted = fence.index + fence[0].length
    FENCE_RE.lastIndex = emitted
  }
  if (emitted < text.length) yield* recoverBareCalls(text.slice(emitted), knownTools)
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
    // 缺闭合标记不等于回复被截断:模型常漏写 `</tool_call>` 而后面还有更多调用。
    // 协议要求标记内是一个 ```json 围栏,所以边界止于该围栏的结束;吞掉剩余全文
    // 会让后面每一个调用都消失 —— 一次 5 个调用只剩第一个,任务随即停在半路。
    // 连围栏结束都没有才是真截断,那时保留「剩下全是调用体」。
    const fence = close === null ? FENCE_ONE.exec(rest) : null
    let body: string
    let nextCursor: number
    if (close !== null) {
      body = rest.slice(0, close.index)
      nextCursor = bodyStart + close.index + close[0].length
    } else if (fence !== null) {
      body = fence[0]
      nextCursor = bodyStart + fence.index + fence[0].length
    } else {
      body = rest
      nextCursor = text.length
    }
    if (open.index > cursor) events.push(...recoverUnmarkedCalls(text.slice(cursor, open.index), knownTools))
    // 带标记的调用不过 knownTools 闸门:标记本身已经是明确意图,未知工具名交给
    // 执行层报错,模型据此改名重试。修不好则保留原文,由适配器退回可见文本。
    const marked = parseOrRepair(body)
    events.push({
      kind: 'tool-call',
      raw: marked === null
        ? body.trim()
        : JSON.stringify({ name: marked.name, arguments: safeJson(marked.arguments) }),
    })
    cursor = nextCursor
    OPEN_RE.lastIndex = cursor
  }
  if (cursor < text.length) events.push(...recoverUnmarkedCalls(text.slice(cursor), knownTools))
  return events
}

/** Everything a reply could use to open a tool call, marked or not. */
const CALL_STARTS = [TOOL_CALL_OPEN_PREFIX, NARRATED_PREFIX, '```json', '{'] as const

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
