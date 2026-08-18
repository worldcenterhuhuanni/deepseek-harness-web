/**
 * What the composer actually receives.
 *
 * The regression that motivated these: a follow-up turn closed with "output only
 * the reply itself", which sits right after the question and therefore outranks
 * the tool protocol at the top of the opening turn — so the model narrated its
 * intent ("let me look at that directory") and never emitted a call, and dsh saw
 * a plain stop. Removing that contradiction was not enough: a run whose whole
 * request rode as an attachment answered with `[调用 glob] {"pattern": …}`,
 * naming a tool it could only have read from the attached catalog while
 * inventing its own call syntax. The page reads an attachment as a document and
 * only the composer text as an instruction, so the protocol now rides in the
 * composer on every turn — opening and follow-up alike.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/tests/render
 */

import { describe, expect, it } from 'vitest'
import { renderIncrement, renderRequest } from '../src/render.ts'
import { TOOL_CALL_OPEN } from '../src/parse.ts'

const TOOLS = [
  { name: 'list_dir', description: '列出目录', parameters: { type: 'object', properties: {} } },
  { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } },
]

function options(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'deepseek-web',
    model: 'deepseek-web',
    system: '你是助手。',
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '第一个回答' }] },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: '第二个问题' }] },
    ],
    ...overrides,
  } as never
}

describe('renderRequest', () => {
  it('carries the tool catalog with schemas and the call syntax', () => {
    const { document } = renderRequest(options({ tools: TOOLS }))
    expect(document).toContain('list_dir')
    expect(document).toContain('JSON Schema')
    expect(document).toContain(TOOL_CALL_OPEN)
  })

  it('never tells the model to output only the reply itself', () => {
    const { document } = renderRequest(options({ tools: TOOLS }))
    expect(document).not.toContain('只输出回复本身')
    expect(document).toContain('不要只说明你打算做什么')
  })
})

describe('renderIncrement', () => {
  it('never contradicts the tool protocol', () => {
    const rendered = renderIncrement(options({ tools: TOOLS }), 2)
    expect(rendered).not.toBeNull()
    expect(rendered?.document).not.toContain('只输出回复本身')
    expect(rendered?.document).toContain('不要只说明你打算做什么')
  })

  it('does not re-send the catalog or the schemas', () => {
    const rendered = renderIncrement(options({ tools: TOOLS }), 2)
    // 首轮已在同一个网页对话里给过,且 resumeBlocker 保证工具集未变。
    expect(rendered?.document).not.toContain('JSON Schema')
    expect(rendered?.document).not.toContain('list_dir')
  })

  it('sends only the new non-assistant turns', () => {
    const rendered = renderIncrement(options({ tools: TOOLS }), 2)
    expect(rendered?.document).toContain('第二个问题')
    expect(rendered?.document).not.toContain('第一个问题')
    expect(rendered?.document).not.toContain('第一个回答')
  })

  it('re-attaches the question on a tool-result turn', () => {
    // 工具调用第二步:增量里只有工具结果,提问在第一步就发过了。
    const withResult = options({
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: '那个目录下有几个文件夹' }] },
        { id: 'm2', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
        { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb\nc' }] }] },
      ],
      tools: TOOLS,
    })
    const rendered = renderIncrement(withResult, 1)
    expect(rendered?.document).toContain('当前要回答的问题')
    expect(rendered?.document).toContain('那个目录下有几个文件夹')
    expect(rendered?.document).toContain('a\nb\nc')
  })

  it('does not re-attach the question when the turn already carries one', () => {
    const rendered = renderIncrement(options({ tools: TOOLS }), 2)
    expect(rendered?.document).not.toContain('当前要回答的问题')
  })

  it('keeps the same closing instruction with or without tools', () => {
    const withTools = renderIncrement(options({ tools: TOOLS }), 2)
    const without = renderIncrement(options(), 2)
    expect(without?.document).toContain(TOOL_CALL_OPEN)
    expect(without?.document).toBe(withTools?.document)
  })

  it('returns null when nothing new needs sending', () => {
    expect(renderIncrement(options({ tools: TOOLS }), 3)).toBeNull()
  })
})

describe('composer-borne tool protocol', () => {
  it('states the protocol in the composer, not only in the attachment', () => {
    // 附件里的格式约定会被当成可以转述的说明文字,而转述过的调用解析不了。
    const opening = renderRequest(options({ tools: TOOLS }))
    expect(opening.companionPrompt).toContain(TOOL_CALL_OPEN)
    expect(opening.companionPrompt).toContain('```json')

    const followup = renderIncrement(options({ tools: TOOLS }), 2)
    expect(followup?.companionPrompt).toContain(TOOL_CALL_OPEN)
    expect(followup?.companionPrompt).toContain('```json')
  })

  it('replays historical calls in the fenced form the protocol asks for', () => {
    // 模型会模仿历史里见过的写法;历史用裸 JSON 就等于示范了一种会被渲染破坏的格式。
    const { document } = renderRequest(options({
      tools: TOOLS,
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: '看看' }] },
        {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
        },
      ],
    }))
    expect(document).toContain('```json\n{"id":"c1","name":"read_file"')
  })
})
