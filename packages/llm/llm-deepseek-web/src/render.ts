/**
 * Render one fully-assembled dsh request into the single Markdown document the
 * web composer receives.
 *
 * Every request is stateless: dsh owns the conversation, so the whole history
 * is re-sent each turn and the web session never carries state between turns.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/render
 */

import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './parse.ts'

/**
 * The closing instruction, shared by the opening turn and every follow-up.
 *
 * It must not say "output only the reply itself". The tool protocol sits far
 * away — at the top of the opening turn, which usually rides as an attachment —
 * while this instruction sits right after the question, and the near instruction
 * wins: "only the reply itself" reads as an instruction *against* emitting a
 * tool-call marker, so the model describes what it would do instead of doing it.
 * The fix is to stop contradicting the protocol here, not to repeat the protocol.
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
 * It rides in the composer, not only in the attachment. An attachment is read
 * as a document: the model takes the tool *catalog* from it (it names tools it
 * could only have read there) while treating the *format* rule as prose it may
 * paraphrase, and a paraphrased call is an unparseable one. The composer text
 * is the only part of a request the page treats as an instruction.
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

function renderTools(tools: readonly ToolSchema[]): string {
  const catalog = tools
    .map(tool => `- \`${tool.name}\`：${tool.description}\n  参数 JSON Schema：\n  \`\`\`json\n  ${JSON.stringify(tool.parameters)}\n  \`\`\``)
    .join('\n')

  return [
    '## 可用工具',
    '',
    catalog,
    '',
    '## 工具调用格式（严格遵守）',
    '',
    TOOL_CALL_PROTOCOL,
  ].join('\n')
}

/** The rendered request, split into what goes in the composer vs. the attachment. */
export interface RenderedRequest {
  /** Full Markdown document — used as the attachment body, or as composer text when short. */
  document: string
  /** Short instruction shown in the composer when the document rides as a file. */
  companionPrompt: string
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
 * Render only the turns the web conversation has not seen yet.
 *
 * The page keeps its own history, so a follow-up carries just the new user
 * turns and tool results — assistant turns are skipped because the page
 * produced them itself and already has them.
 *
 * @param options - the full request; only the tail past `fromIndex` is used.
 * @param fromIndex - how many leading messages the page already holds.
 * @returns the incremental document, or null when nothing new needs sending.
 */
export function renderIncrement(
  options: GenerateOptions,
  fromIndex: number,
): RenderedRequest | null {
  const fresh = options.messages.slice(fromIndex).filter(message => message.role !== 'assistant')
  if (!fresh.length) return null

  // 工具目录与调用格式不重发:首轮已在同一个网页对话里给过,而 resumeBlocker 保证
  // 工具集未变,所以那份说明依然有效。续轮要做的只是别再用措辞把它压掉。
  const sections = [fresh.map((message, i) => renderMessage(message, fromIndex + i)).join('\n\n')]

  // 当前这一轮的提问必须在每个 step 都在场:一轮里的多个 step 共享同一个提问,
  // 它在本轮结束前不是历史。而增量的边界是「已发送的消息条数」,提问在第一个 step
  // 就发出去了,于是从第二个 step 起被切在边界外 —— 模型拿着工具输出自由发挥,
  // 漏掉提问里的具体要求(问「有几个」时只列举、不报数)。
  //
  // 只补提问,不按「轮」重画边界:那样会把本轮之前所有 step 的工具结果一起重发
  // (一轮五次工具调用,第五步要重发前四次的输出),而缺的只有提问这一条。
  const carriesResult = fresh.some(message => message.content.some(block => block.type === 'tool-result'))
  if (carriesResult) {
    const question = lastUserQuestion(options.messages.slice(0, fromIndex))
    if (question) sections.push(`## 当前要回答的问题\n\n${renderBlocks(question.content)}`)
  }

  sections.push(TASK_INSTRUCTION)

  return {
    document: sections.join('\n\n---\n\n'),
    companionPrompt: `请阅读附件中的新增内容，继续以助手身份作答。\n\n${TOOL_CALL_PROTOCOL}`,
  }
}

export function renderRequest(options: GenerateOptions): RenderedRequest {
  const sections: string[] = []

  if (options.system) sections.push(`## 系统指令\n\n${options.system}`)
  if (options.tools?.length) sections.push(renderTools(options.tools))

  sections.push(
    `## 对话记录\n\n${options.messages.map((m, i) => renderMessage(m, i)).join('\n\n')}`,
  )
  sections.push(TASK_INSTRUCTION)

  return {
    document: sections.join('\n\n---\n\n'),
    companionPrompt: `请阅读附件中的对话记录，按其中「你的任务」一节作答。\n\n${TOOL_CALL_PROTOCOL}`,
  }
}
