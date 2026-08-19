/**
 * 把一次组装完毕的 dsh 请求渲染成网页输入框实际收到的内容。
 *
 * 对话由 dsh 拥有；页面对前面轮次的记忆只是缓存，不是权威副本。所以一次请求按
 * **内容角色**切分，绝不按传输方式切分：
 *
 * - `preamble` 是每轮都必须**指示**给页面的部分。页面只把输入框文本当指令，所以
 *   这一半永远不能挪进附件，而且开场轮与续轮必须产出完全相同的一份——否则续用
 *   一条网页对话就会悄悄削弱指令。
 * - `history` 是对话正文。它可以并进输入框，也可以走附件；这个选择归适配器，且
 *   不允许改变模型收到了哪些指令。
 *
 * 按传输方式切分正是此前每个续轮都丢掉工具协议的原因：协议只存在于「走附件时」
 * 那一半里，而增量续轮的内容短到永远够不到附件阈值。
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/render
 */

import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './parse.ts'

/**
 * 收尾指令，开场轮与每个续轮共用同一份。
 *
 * 它不能说「只输出回复本身」：近处的指令压过远处的，那句话会被读成**禁止**输出
 * 工具调用标记，于是模型改成描述自己打算做什么，而不去做。
 */
const TASK_INSTRUCTION = [
  '## 你的任务',
  '',
  '接着上面的对话，以助手身份给出下一条回复。',
  '提问包含多个要点时，按提问的顺序逐条回答：先给出结论，再展开说明。',
  `需要用工具才能回答时，直接按约定的 ${TOOL_CALL_OPEN} 格式输出调用，不要只说明你打算做什么。`,
].join('\n')

/**
 * 工具调用协议的逐字文本——每个出口都重复这同一份。
 *
 * 它属于 {@link RenderedRequest.preamble}，因为附件是被当**文档**读的：模型能从
 * 文档里拿到工具**目录**（它叫得出只可能来自那里的工具名），却把**格式**规则当成
 * 可以转述的说明文字，而转述过的调用是解析不出来的。
 *
 * JSON 放在代码围栏里，是因为页面在我们读回之前会先渲染 markdown：围栏之外，
 * `\"` 会被渲染成 `"`，于是每个带引号参数的调用到手都是坏 JSON。
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

/** 正文走附件而非并进输入框时，输入框里的引导语。 */
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
 * 工具目录：名称、描述与参数 schema。
 *
 * 它属于正文而非指令——模型能可靠地从文档里读出目录，所以这部分可以走附件。调用
 * **格式**不行；格式在 {@link TOOL_CALL_PROTOCOL}，只在 preamble 里陈述一次。
 */
function renderTools(tools: readonly ToolSchema[]): string {
  const catalog = tools
    .map(tool => `- \`${tool.name}\`：${tool.description}\n  参数 JSON Schema：\n  \`\`\`json\n  ${JSON.stringify(tool.parameters)}\n  \`\`\``)
    .join('\n')

  return ['## 可用工具', '', catalog].join('\n')
}

/** 一次请求，按内容角色切成两半。 */
export interface RenderedRequest {
  /**
   * 每轮都必须进到输入框的内容：当前提问、任务要求、调用协议。开场轮与续轮完全
   * 一致——正是这一点让「续用网页对话」成为不改变语义的优化。
   */
  preamble: string
  /** 对话正文——并进输入框还是走附件，由适配器决定。 */
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
 * 指令那一半，一条对话的每一轮都完全相同。
 *
 * 提问在这里重述一遍而不是交给历史，是因为一轮会跨多个 step：从第二个 step 起，
 * 历史增量里只有工具输出，而提问一旦不在模型眼前，回答就会走样（问「有几个」时
 * 只把条目列一遍，不报数）。
 *
 * @param options - 提供本轮提问与任务的请求。
 * @returns 归输入框承载的文本。
 */
function buildPreamble(options: GenerateOptions): string {
  const sections: string[] = []
  const question = lastUserQuestion(options.messages)
  if (question) sections.push(`## 当前要回答的问题\n\n${renderBlocks(question.content)}`)
  sections.push(TASK_INSTRUCTION, TOOL_CALL_PROTOCOL)
  return sections.join('\n\n---\n\n')
}

/**
 * 只渲染网页对话还没见过的那些轮次。
 *
 * assistant 轮跳过：页面自己产出的，它本来就有。目录也不重发——开场轮已在同一条
 * 网页对话里给过，而 `resumeBlocker` 保证工具集没有变化。
 *
 * @param options - 完整请求；只用到 `fromIndex` 之后的尾部。
 * @param fromIndex - 页面已经持有的前置消息条数。
 * @returns 增量请求；没有新内容需要发送时返回 null。
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
 * 为一条尚无任何历史的网页对话渲染完整请求。
 *
 * @param options - 待渲染的请求。
 * @returns 开场请求；它的 preamble 与续轮的完全相同。
 */
export function renderRequest(options: GenerateOptions): RenderedRequest {
  const sections: string[] = []

  if (options.system) sections.push(`## 系统指令\n\n${options.system}`)
  if (options.tools?.length) sections.push(renderTools(options.tools))
  sections.push(`## 对话记录\n\n${options.messages.map((m, i) => renderMessage(m, i)).join('\n\n')}`)

  return { history: sections.join('\n\n---\n\n'), preamble: buildPreamble(options) }
}
