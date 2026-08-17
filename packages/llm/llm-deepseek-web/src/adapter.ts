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
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeError, type WebSession } from './session.ts'
import { ToolCallSplitter, parseToolCall, type SplitEvent } from './parse.ts'
import { renderIncrement, renderRequest } from './render.ts'

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
    // 续问只发新增:网页会话自己记着前面的轮次,重发全量既慢又会让历史重复叠加。
    const blocker = this.resumeBlocker(options)
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

    const splitter = new ToolCallSplitter()
    let nextIndex = 0
    let open: OpenBlock | null = null
    let outputChars = 0
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
        // 模型把格式跑飞了。不静默丢弃:退回成可见文本,让上层看得见发生了什么。
        yield* emit('text', raw)
        return
      }
      yield* closeOpen()
      const index = nextIndex++
      const id = CallId(`web-${index}-${parsed.name}`)
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

        outputChars += event.text.length
        yield* emitPieces(splitter.push(event.text))
      }

      yield* emitPieces(splitter.flush())
      yield* closeOpen()

      if (nextIndex === 0) {
        throw new LlmError('DeepSeek 网页没有返回任何内容。', 'EMPTY_RESPONSE')
      }

      // 只有整轮成功才认账:失败时网页那边到底收到多少无从确认,
      // 记成已发会让下一轮的增量建立在错误的基线上。
      const sessionId = String(options.sessionId ?? '')
      this.conversation = sessionId
        ? {
          sessionId,
          sentIds: options.messages.map(message => message.id),
          toolNames: toolSignature(options),
          system: options.system ?? '',
        }
        : null

      yield { type: 'usage', usage: estimateUsage(document, outputChars) }
      yield { type: 'finish', reason: state.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } }
    } catch (error) {
      // 未闭合的块必须先收口,否则 finish 会违反流语法校验。
      yield* closeOpen()
      this.conversation = null
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
 * The web session reports no token counts, but dsh's compaction triggers on
 * them — reporting nothing would mean compaction never fires on long sessions.
 *
 * ponytail: 4 chars/token is a crude CJK-hostile estimate; swap in a real
 * tokenizer if compaction starts firing at visibly wrong points.
 */
function estimateUsage(prompt: string, outputChars: number): TokenUsage {
  return {
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: Math.ceil(outputChars / 4),
  }
}
