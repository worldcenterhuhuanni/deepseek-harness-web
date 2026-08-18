/**
 * The adapter itself: one dsh request in, one dsh chunk stream out, with a
 * browser-driven web session in the middle.
 *
 * Nothing here is provider-native. The web UI returns plain text, and this file
 * turns it into the same `StreamChunk` grammar an HTTP adapter emits — dsh
 * cannot tell which one produced a given tool call.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/adapter
 */

import {
  CallId,
  LlmAdapter,
  LlmError,
  isAgentLoopRequest,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeError, type WebSession } from './session.ts'
import { parseToolCall, splitReply, visibleEnd, type SplitEvent } from './parse.ts'
import { renderIncrement, renderRequest } from './render.ts'

/** The tool names this request offers; gates recovery of unmarked calls. */
function knownTools(options: GenerateOptions): ReadonlySet<string> {
  return new Set((options.tools ?? []).map(tool => tool.name))
}

/** Tool set identity; a changed set means the opening turn no longer describes the truth. */
function toolSignature(options: GenerateOptions): string {
  return (options.tools ?? []).map(tool => tool.name).join(',')
}

/** Beyond this many characters the request rides as an attachment. */
export const DEFAULT_INLINE_LIMIT = 4_000

/** A content block currently accumulating deltas. */
interface OpenBlock {
  index: number
  type: 'text' | 'reasoning'
  text: string
}

/** What the open web conversation has already been told. */
interface Conversation {
  sessionId: string
  /** Message ids delivered so far, in order; the page holds exactly these turns. */
  sentIds: string[]
  /** Tool names sent with the opening turn; a change invalidates the conversation. */
  toolNames: string
  /** System prompt sent with the opening turn. */
  system: string
}

/** Advisory catalog entry; the web session exposes exactly one conversational model. */
const WEB_MODEL = 'deepseek-web'

export interface DsWebAdapterOptions {
  session: WebSession
  displayName?: string
  /** Read per request, so a settings change reaches the next call without a restart. */
  inlineLimit?: () => number
  /** Send the conversation as a `.md` attachment when it exceeds the inline limit. */
  useAttachment?: () => boolean
  /** Where to report resume-vs-restart decisions; without it they are silent. */
  log?: (message: string) => void
}

/** Map a bridge failure onto a provider-neutral dsh code. */
function bridgeErrorCode(kind: BridgeError['kind']): string {
  switch (kind) {
    case 'not-logged-in':
      return 'MISSING_CREDENTIAL'
    case 'rate-limited':
      return 'RATE_LIMIT'
    case 'transport':
      return 'TRANSPORT'
    default:
      return 'UNKNOWN'
  }
}

export class DsWebAdapter extends LlmAdapter {
  private readonly session: WebSession
  private readonly inlineLimit: () => number
  private readonly useAttachment: () => boolean
  private readonly displayName: string
  private readonly log: ((message: string) => void) | undefined
  /**
   * The web conversation currently open, or null when the next request must
   * start one. ponytail: 只跟一条;并发的 subagent 会让前缀校验落空,
   * 各自退回新开会话 —— 慢但不会串话,要真并发得先做多标签页。
   */
  private conversation: Conversation | null = null

  constructor(options: DsWebAdapterOptions) {
    super()
    this.session = options.session
    this.inlineLimit = options.inlineLimit ?? (() => DEFAULT_INLINE_LIMIT)
    this.useAttachment = options.useAttachment ?? (() => true)
    this.displayName = options.displayName ?? 'DeepSeek 网页（已登录）'
    this.log = options.log
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: WEB_MODEL, name: this.displayName }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: this.displayName })
  }

  /**
   * Why the open web conversation cannot carry this request, or null when it can.
   *
   * It can only carry it when this is the same dsh session with the same system
   * prompt and tools, and everything already delivered is still an exact prefix
   * of the new history. Compaction rewrites that prefix, and then the page's
   * memory no longer matches what dsh believes — so we start over rather than
   * diverge. Returning the reason rather than a bare boolean is what makes an
   * unexpected new conversation diagnosable from the log.
   */
  private resumeBlocker(options: GenerateOptions): string | null {
    const open = this.conversation
    if (!open) return '尚无已打开的网页会话'
    const sessionId = String(options.sessionId ?? '')
    if (!sessionId) return 'dsh 未提供 sessionId'
    if (open.sessionId !== sessionId) return `dsh 会话已变（${open.sessionId} → ${sessionId}）`
    if (open.system !== (options.system ?? '')) return 'system 提示词与上轮不同'
    if (open.toolNames !== toolSignature(options)) return '工具集与上轮不同'
    if (options.messages.length <= open.sentIds.length) {
      return `历史没有增长（已发 ${open.sentIds.length} 条，本次 ${options.messages.length} 条）`
    }
    for (const [i, id] of open.sentIds.entries()) {
      if (options.messages[i]?.id !== id) return `历史第 ${i} 条被改写（compaction？）`
    }
    return null
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 只有 agent loop 的请求拥有那条网页对话。标题、摘要这类请求要一次问答就
    // 走人,让它们共用主标签页会把主对话导航掉,下一轮就得导航回去重载整段历史。
    // 所以它们在一次性标签页里跑,也完全不参与这里的会话记账。
    const isolated = !isAgentLoopRequest(options)
    // 续问只发新增:网页会话自己记着前面的轮次,重发全量既慢又会让历史重复叠加。
    const blocker = isolated ? '这是一次性请求（非 agent loop）' : this.resumeBlocker(options)
    const resumeAt = blocker === null ? this.conversation?.sentIds.length ?? 0 : 0
    this.log?.(
      blocker === null
        ? `复用网页会话，从第 ${resumeAt} 条起发增量`
        : `新开网页会话，原因：${blocker}`,
    )
    const rendered = resumeAt > 0 ? renderIncrement(options, resumeAt) : null
    const newChat = rendered === null
    const { document, companionPrompt } = rendered ?? renderRequest(options)
    const asAttachment = this.useAttachment() && document.length > this.inlineLimit()

    let nextIndex = 0
    let open: OpenBlock | null = null
    // 回复正文按到达顺序累积;shown 是已作为可见文本发出的长度。
    let reply = ''
    let shown = 0
    // 站点报的是会话累计值:首次观测是本轮的基线,末次是本轮结束后的总量。
    let totals: { baseline: number; final: number } | null = null
    // 提示词是否已经进入网页对话;决定失败后那条对话还能不能复用。
    let submitted = false
    // 内层 generator 拿不到 this,先取出来。
    const { log } = this
    // 放进对象里:它只在内层 generator 中被置真,写成局部 let 会被控制流分析判成恒假。
    const state = { sawToolCall: false }

    // 关掉当前块并补上 block-end,保证 finish 时没有未闭合块。
    const closeOpen = function* (): Generator<StreamChunk> {
      if (!open) return
      const block: ContentBlock =
        open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text }
      yield { type: 'block-end', index: open.index, block }
      open = null
    }

    // 返回当前打开的块,让调用方直接拿到 index 与累积缓冲,不必对闭包变量做非空断言。
    const ensureOpen = function* (type: 'text' | 'reasoning'): Generator<StreamChunk, OpenBlock> {
      if (open && open.type === type) return open
      yield* closeOpen()
      const index = nextIndex++
      const block: OpenBlock = { index, type, text: '' }
      open = block
      yield { type: 'block-start', index, blockType: type }
      return block
    }

    const emit = function* (kind: 'text' | 'reasoning', text: string): Generator<StreamChunk> {
      const block = yield* ensureOpen(kind)
      block.text += text
      yield kind === 'text'
        ? { type: 'text-delta', index: block.index, text }
        : { type: 'reasoning-delta', index: block.index, text }
    }

    const emitToolCall = function* (raw: string): Generator<StreamChunk> {
      const parsed = parseToolCall(raw)
      if (!parsed) {
        // 模型把格式跑飞了。退回成可见文本让人看得见,同时记一笔:这条路由的
        // 格式全靠模型配合,解析失败率是它唯一的健康指标,而回合会就此判成完成。
        log?.(`工具调用解析失败，已退回文本：${raw.slice(0, 200)}`)
        yield* emit('text', raw)
        return
      }
      yield* closeOpen()
      const index = nextIndex++
      // id 必须在整个会话里唯一,不只是这一次请求里。块序号每次请求都从 0 重来,
      // 所以拿它当 id 会让两轮里同位置的同名调用撞成一个 —— 会话重放时同一个
      // tool-call 收到两次 start,历史直接加载失败。真实 API 的 id 由服务端保证
      // 唯一,这条通路自己造 id,就得自己带够熵。
      const id = CallId(`web-${randomUUID().slice(0, 12)}-${parsed.name}`)
      state.sawToolCall = true
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: parsed.name, argumentsDelta: parsed.arguments }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: parsed.name, arguments: parsed.arguments },
      }
    }

    const emitPieces = function* (pieces: readonly SplitEvent[]): Generator<StreamChunk> {
      for (const piece of pieces) {
        if (piece.kind === 'tool-call') yield* emitToolCall(piece.raw)
        else yield* emit('text', piece.text)
      }
    }

    // CDP 用本地文件路径挂载附件,所以上下文先落盘,离开本轮时删掉。
    const attachment = asAttachment ? await writeContextFile(document) : undefined

    try {
      // exactOptionalPropertyTypes:可选字段要么不出现,要么有值,不能显式传 undefined。
      const events = this.session.ask({
        prompt: asAttachment ? companionPrompt : document,
        newChat,
        ...(isolated ? { isolated: true } : {}),
        ...(attachment ? { filePath: attachment.path } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })

      for await (const event of events) {
        // progress 是「正在上传/正在解析」这类链路状态,不是模型输出,不进 chunk 流。
        if (event.kind === 'progress') continue

        if (event.kind === 'thinking') {
          yield* emit('reasoning', event.text)
          continue
        }

        if (event.kind === 'submitted') {
          submitted = true
          continue
        }

        if (event.kind === 'diagnostic') {
          this.log?.(event.text)
          continue
        }

        if (event.kind === 'usage') {
          totals = totals === null
            ? { baseline: event.totalTokens, final: event.totalTokens }
            : { baseline: totals.baseline, final: event.totalTokens }
          continue
        }

        // 站点的流是纯追加的,所以正文可以边收边发。发到 visibleEnd 为止:
        // 之后的字节可能是一个调用的开头,而发出去的文本收不回来。
        reply += event.text
        const safe = visibleEnd(reply)
        if (safe > shown) {
          yield* emit('text', reply.slice(shown, safe))
          shown = safe
        }
      }

      // 收尾时才解析:一个调用的 JSON 只有完整时才可用,而扣住的尾巴里也可能
      // 只是普通正文,那部分在这里放行。
      yield* emitPieces(splitReply(reply.slice(shown), knownTools(options)))
      yield* closeOpen()

      if (nextIndex === 0) {
        throw new LlmError('DeepSeek 网页没有返回任何内容。', 'EMPTY_RESPONSE')
      }

      // 只有整轮成功才认账:失败时网页那边到底收到多少无从确认,
      // 记成已发会让下一轮的增量建立在错误的基线上。
      const sessionId = String(options.sessionId ?? '')
      if (!isolated) {
        this.conversation = sessionId
          ? {
            sessionId,
            sentIds: options.messages.map(message => message.id),
            toolNames: toolSignature(options),
            system: options.system ?? '',
          }
          : null
      }

      yield { type: 'usage', usage: turnUsage(document, reply, totals) }
      yield { type: 'finish', reason: state.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } }
    } catch (error) {
      // 未闭合的块必须先收口,否则 finish 会违反流语法校验。
      yield* closeOpen()
      // 提交之前失败,页面就没见过这一轮,已打开的对话仍然可以续用 —— 登录过期或
      // 附件没挂上之后不必白白重开一个对话。提交之后就另说了:页面收到了多少、
      // 产出了什么都无从确认,继续用会让下一轮的增量建立在错误的基线上。
      if (submitted && !isolated) this.conversation = null
      if (error instanceof BridgeError) {
        throw new LlmError(error.message, bridgeErrorCode(error.kind), { cause: error })
      }
      throw error
    } finally {
      await attachment?.cleanup()
    }
  }
}

/** Spill the rendered conversation to a `.md` file for CDP to attach. */
async function writeContextFile(document: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-'))
  const path = join(dir, 'context.md')
  await writeFile(path, document, 'utf8')
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Token usage for one turn, anchored to what the site itself reported.
 *
 * The completion stream states the conversation's running total before and
 * after the turn, so their difference is the turn's real cost — but it is one
 * number covering prompt and completion together, which dsh's `TokenUsage`
 * splits. So the total is exact and the split is proportional to a 4-chars-per-
 * token estimate of each side: dsh's compaction triggers on the sum, which is
 * the half that has to be right.
 *
 * Without a reported total, both sides fall back to that estimate — crude, and
 * hostile to CJK, but better than reporting nothing and never compacting.
 *
 * @param prompt - the rendered request.
 * @param reply - the reply text.
 * @param reported - the running totals bracketing this turn, when available.
 * @returns usage in dsh's shape.
 */
function turnUsage(
  prompt: string,
  reply: string,
  reported: { baseline: number; final: number } | null,
): TokenUsage {
  const estimatedInput = Math.ceil(prompt.length / 4)
  const estimatedOutput = Math.ceil(reply.length / 4)
  if (reported === null) return { inputTokens: estimatedInput, outputTokens: estimatedOutput }
  const total = Math.max(0, reported.final - reported.baseline)
  const estimatedTotal = estimatedInput + estimatedOutput
  const outputTokens = estimatedTotal === 0
    ? 0
    : Math.min(total, Math.round((total * estimatedOutput) / estimatedTotal))
  return { inputTokens: total - outputTokens, outputTokens }
}
