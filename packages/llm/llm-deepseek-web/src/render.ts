/**
 * Render one fully-assembled dsh request into what the web composer receives.
 *
 * dsh owns the conversation; the page's memory of earlier turns is a cache, not
 * the authority. So a request is split by ROLE, never by transport:
 *
 * - `preamble` is what the page must be *instructed* with on every turn. The
 *   page treats only composer text as an instruction, so this half can never
 *   move into an attachment, and an opening turn and a follow-up must produce
 *   the same one — otherwise resuming a conversation silently weakens it.
 * - `history` is conversation body. It may ride inline or as an attachment;
 *   that choice belongs to the adapter and must not change what the model is
 *   told.
 *
 * Splitting by transport is what previously dropped the tool protocol from
 * every follow-up: the protocol lived in the attachment-only half, while short
 * increments never reached the attachment threshold.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/render
 */

import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './parse.ts'

/**
 * The closing instruction, shared by the opening turn and every follow-up.
 *
 * It must not say "output only the reply itself": the near instruction outranks
 * the far one, so that phrasing reads as an instruction *against* emitting a
 * tool-call marker, and the model describes what it would do instead of doing
 * it.
 */
const TASK_INSTRUCTION = [
  '## 你的任务',
  '',
  '接着上面的对话，以助手身份给出下一条回复。',
  '提问包含多个要点时，按提问的顺序逐条回答：先给出结论，再展开说明。',
  `需要用工具才能回答时，直接按约定的 ${TOOL_CALL_OPEN} 格式输出调用，不要只说明你打算做什么。`,
].join('\n')

/**
 * The tool-call protocol, verbatim — the one text every surface repeats.
 *
 * It belongs to {@link RenderedRequest.preamble} because an attachment is read
 * as a document: the model takes the tool *catalog* from a document (it names
 * tools it could only have read there) while treating a *format* rule as prose
 * it may paraphrase, and a paraphrased call is an unparseable one.
 *
 * The JSON sits in a fenced block because the page renders markdown before we
 * read it back: outside a fence, `\"` renders as `"` and every call carrying a
 * quoted argument arrives as broken JSON.
 */
const TOOL_CALL_PROTOCOL = [
  '需要调用工具时，严格按下面这段输出，不要改写格式，也不要只描述你打算做什么：',
  '',
  TOOL_CALL_OPEN,
  '```json',
  '{"name": "工具名", "arguments": {…}}',
  '```',
  TOOL_CALL_CLOSE,
  '',
  '- `arguments` 必须是符合该工具 JSON Schema 的 JSON 对象',
  '- JSON 必须放在 ```json 代码块里，否则参数里的引号会在渲染时损坏',
  '- 一次可以连续输出多段工具调用',
].join('\n')

/** Composer lead-in when the history rides as a file instead of inline. */
export const ATTACHMENT_NOTE = '请阅读附件中的对话记录，然后按下面的要求作答。'

/** Render the blocks of one message; unknown block types degrade to a labeled placeholder. */
function renderBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        // 历史里的思考内容对续写没有约束力,标注来源避免模型把它当成用户指令。
        parts.push(`> （上一轮思考）${block.text}`)
        break
      case 'tool-call':
        parts.push(
          [
            TOOL_CALL_OPEN,
            '```json',
            JSON.stringify({ id: block.id, name: block.name, arguments: safeParse(block.arguments) }),
            '```',
            TOOL_CALL_CLOSE,
          ].join('\n'),
        )
        break
      case 'tool-result': {
        const inner = renderBlocks(block.content)
        parts.push(
          `【工具结果 ${block.toolCallId}${block.isError ? ' · 执行失败' : ''}】\n${inner}`,
        )
        break
      }
      case 'image':
        // 网页附件位只够承载这一份 Markdown,图片无法随行。
        parts.push('【图片：本通路不支持图片输入】')
        break
      default:
        parts.push(`【未知内容块：${(block as { type: string }).type}】`)
    }
  }
  return parts.join('\n\n')
}

/** Parse model-produced argument JSON, falling back to the raw string. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function renderMessage(message: Message, index: number): string {
  const role = message.role === 'assistant' ? '助手' : message.role === 'system' ? '系统' : '用户'
  return `### [${index + 1}] ${role}\n\n${renderBlocks(message.content)}`
}

/**
 * The tool catalog: names, descriptions, and argument schemas.
 *
 * Body, not instruction — the model reads a catalog out of a document reliably,
 * so this may ride as an attachment. The call *format* does not; it lives in
 * {@link TOOL_CALL_PROTOCOL} and is stated once, in the preamble.
 */
function renderTools(tools: readonly ToolSchema[]): string {
  const catalog = tools
    .map(tool => `- \`${tool.name}\`：${tool.description}\n  参数 JSON Schema：\n  \`\`\`json\n  ${JSON.stringify(tool.parameters)}\n  \`\`\``)
    .join('\n')

  return ['## 可用工具', '', catalog].join('\n')
}

/** One request, split by content role. */
export interface RenderedRequest {
  /**
   * What must reach the composer every turn: the live question, the task
   * instruction, and the call protocol. Identical for an opening turn and a
   * follow-up, which is what makes conversation resumption semantics-preserving.
   */
  preamble: string
  /** Conversation body — inline or attached, the adapter's choice. */
  history: string
}

/**
 * The most recent real user question, skipping tool-result carrier messages.
 *
 * Tool results arrive as user-role messages whose blocks are all `tool-result`,
 * so role alone cannot tell a question from a result.
 */
function lastUserQuestion(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (message.content.some(block => block.type === 'text')) return message
  }
  return undefined
}

/**
 * The instruction half, identical on every turn of a conversation.
 *
 * The question is restated here rather than left to the history because one
 * turn spans many steps: from the second step on, the history increment holds
 * only tool output, and a question that is no longer in front of the model gets
 * answered loosely (listing entries when asked to count them).
 *
 * @param options - the request whose question and task this describes.
 * @returns composer-bound text.
 */
function buildPreamble(options: GenerateOptions): string {
  const sections: string[] = []
  const question = lastUserQuestion(options.messages)
  if (question) sections.push(`## 当前要回答的问题\n\n${renderBlocks(question.content)}`)
  sections.push(TASK_INSTRUCTION, TOOL_CALL_PROTOCOL)
  return sections.join('\n\n---\n\n')
}

/**
 * Render only the turns the web conversation has not seen yet.
 *
 * Assistant turns are skipped: the page produced them and already holds them.
 * The catalog is not re-sent either — the opening turn gave it in this same web
 * conversation, and `resumeBlocker` guarantees the tool set has not changed.
 *
 * @param options - the full request; only the tail past `fromIndex` is used.
 * @param fromIndex - how many leading messages the page already holds.
 * @returns the incremental request, or null when nothing new needs sending.
 */
export function renderIncrement(
  options: GenerateOptions,
  fromIndex: number,
): RenderedRequest | null {
  const fresh = options.messages.slice(fromIndex).filter(message => message.role !== 'assistant')
  if (!fresh.length) return null
  return {
    history: fresh.map((message, i) => renderMessage(message, fromIndex + i)).join('\n\n'),
    preamble: buildPreamble(options),
  }
}

/**
 * Render a full request for a web conversation that holds nothing yet.
 *
 * @param options - the request to render.
 * @returns the opening request; its preamble equals a follow-up's.
 */
export function renderRequest(options: GenerateOptions): RenderedRequest {
  const sections: string[] = []

  if (options.system) sections.push(`## 系统指令\n\n${options.system}`)
  if (options.tools?.length) sections.push(renderTools(options.tools))
  sections.push(`## 对话记录\n\n${options.messages.map((m, i) => renderMessage(m, i)).join('\n\n')}`)

  return { history: sections.join('\n\n---\n\n'), preamble: buildPreamble(options) }
}
