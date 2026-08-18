/**
 * Decode the site's own completion stream.
 *
 * `POST /api/v0/chat/completion` answers with `text/event-stream` carrying
 * JSON-Patch-style frames against one response object. Reading it instead of
 * the rendered DOM is what makes the reply text exact: deltas are append-only
 * and never revised, escapes survive (`\"` stays `\"` where markdown rendering
 * would collapse it to `"`), and no UI chrome — code-block language tags,
 * copy/download button labels — is mixed in.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/sse
 */

/** One decoded piece of the reply, or the fact that it ended. */
export type StreamEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'reasoning'; delta: string }
  /** The conversation's running total, reported whenever the stream states it; the first and last observations bracket this turn. */
  | { kind: 'usage'; totalTokens: number }
  | { kind: 'finished' }
  /** A frame that did not parse as JSON; the reply continues without it. */
  | { kind: 'undecodable'; detail: string }

/** A patch frame; `p` and `o` are omitted when they repeat the previous frame. */
interface Patch {
  p?: string
  o?: string
  v?: unknown
}

/** The fragment kinds seen on this route; anything else is treated as reply text. */
const REASONING_FRAGMENT = 'THINK'

const CONTENT_PATH = 'response/fragments/-1/content'
const FRAGMENTS_PATH = 'response/fragments'
const STATUS_PATH = 'response/status'
const USAGE_FIELD = 'accumulated_token_usage'

/** How much of an undecodable frame to quote in the report. */
const UNDECODABLE_SAMPLE = 200

/** Whether a frame without a path is the opening whole-response frame. */
function isSnapshot(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'response' in value
}

/** A fragment header as it appears in the initial snapshot and in fragment appends. */
interface Fragment {
  type?: unknown
  content?: unknown
}

/**
 * Incremental decoder. Feed raw response bytes in arrival order; frames split
 * across chunk boundaries are buffered until complete.
 *
 * Frames omit `p`/`o` to mean "same target as the previous frame", so the
 * decoder is stateful and a stream must be decoded by exactly one instance.
 */
export class CompletionStreamDecoder {
  private buf = ''
  private lastPath = ''
  private lastOp = 'APPEND'
  /** Fragment kinds in arrival order; `-1` in a path means the last of these. */
  private readonly fragments: string[] = []

  /**
   * Decode whatever is complete in `chunk`.
   * @param chunk - raw bytes from the response, decoded as UTF-8.
   * @returns the events these bytes completed, in order.
   */
  push(chunk: string): StreamEvent[] {
    this.buf += chunk
    const events: StreamEvent[] = []
    for (;;) {
      const end = this.buf.indexOf('\n\n')
      if (end === -1) break
      const frame = this.buf.slice(0, end)
      this.buf = this.buf.slice(end + 2)
      this.frame(frame, events)
    }
    return events
  }

  /** Decode one complete `event:`/`data:` frame. */
  private frame(frame: string, out: StreamEvent[]): void {
    // `event: close` and `event: update_session` carry no reply content.
    const data = frame.split('\n').find(line => line.startsWith('data:'))
    if (data === undefined) return
    const body = data.slice('data:'.length)
    let patch: unknown
    try {
      patch = JSON.parse(body)
    } catch {
      // 忽略而不是中断整条回复:一行看不懂的帧不该让已经收到的内容作废。
      // 但要报出来 —— 静默吞掉是协议变更唯一会留下的痕迹。
      out.push({ kind: 'undecodable', detail: body.trim().slice(0, UNDECODABLE_SAMPLE) })
      return
    }
    if (typeof patch !== 'object' || patch === null) return
    const { p, o, v } = patch as Patch
    // `ready` frames describe the message ids, not the response object.
    if (v === undefined) return
    // 按形状判定,不按位置:开场帧的特征是 `v` 携带整个 response 对象。用
    // 「还没见过任何 path」当判据的话,站点一旦改成先发一个 delta 帧,那帧就会
    // 被当成开场帧、内容被悄悄丢掉。
    if (p === undefined && isSnapshot(v)) {
      this.snapshot(v, out)
      return
    }
    const path = p ?? this.lastPath
    const op = o ?? this.lastOp
    this.lastPath = path
    this.lastOp = op
    this.apply(path, op, v, out)
  }

  /** The opening frame: a whole response object, fragments included. */
  private snapshot(value: unknown, out: StreamEvent[]): void {
    const response = (value as { response?: { fragments?: unknown; [USAGE_FIELD]?: unknown } }).response
    if (!response) return
    // 这里的累计值是本轮开始前的基线,与末尾那次的差才是本轮的输出量。
    const usage = response[USAGE_FIELD]
    if (typeof usage === 'number') out.push({ kind: 'usage', totalTokens: usage })
    if (!Array.isArray(response.fragments)) return
    for (const fragment of response.fragments as Fragment[]) this.addFragment(fragment, out)
  }

  /** Register a fragment and emit whatever content it already carries. */
  private addFragment(fragment: Fragment, out: StreamEvent[]): void {
    const type = typeof fragment.type === 'string' ? fragment.type : ''
    this.fragments.push(type)
    if (typeof fragment.content === 'string' && fragment.content) this.content(fragment.content, out)
  }

  /** Route content to the block its fragment belongs to. */
  private content(delta: string, out: StreamEvent[]): void {
    const type = this.fragments.at(-1)
    out.push(type === REASONING_FRAGMENT ? { kind: 'reasoning', delta } : { kind: 'text', delta })
  }

  /** Apply one resolved patch. Unknown paths are state we do not project. */
  private apply(path: string, op: string, value: unknown, out: StreamEvent[]): void {
    if (op === 'BATCH') {
      if (!Array.isArray(value)) return
      for (const child of value as Patch[]) {
        if (child.p === undefined || child.v === undefined) continue
        this.apply(`${path}/${child.p}`, child.o ?? 'SET', child.v, out)
      }
      return
    }
    if (path === CONTENT_PATH) {
      if (typeof value === 'string') this.content(value, out)
      return
    }
    if (path === FRAGMENTS_PATH && Array.isArray(value)) {
      for (const fragment of value as Fragment[]) this.addFragment(fragment, out)
      return
    }
    if (path === STATUS_PATH && value === 'FINISHED') {
      out.push({ kind: 'finished' })
      return
    }
    if (path.endsWith(`/${USAGE_FIELD}`) && typeof value === 'number') {
      out.push({ kind: 'usage', totalTokens: value })
    }
  }
}
