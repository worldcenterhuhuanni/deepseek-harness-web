/**
 * What the composer actually receives.
 *
 * The regressions that motivated these, in order. A follow-up closed with
 * "output only the reply itself", which sits nearer the question than the
 * protocol and therefore outranked it — the model narrated its intent and dsh
 * saw a plain stop. Removing that contradiction was not enough: a request that
 * rode as an attachment answered with `[调用 glob] {…}`, naming a tool it could
 * only have read from the attached catalog while inventing its own syntax,
 * because the page reads an attachment as a document and only composer text as
 * an instruction. The protocol then moved into a composer-bound half — but that
 * half was selected by TRANSPORT, and a short follow-up never reached the
 * attachment threshold, so from the second turn on the protocol reached the
 * model on no path at all.
 *
 * Hence the split is now by ROLE, and the load-bearing assertion is that an
 * opening turn and a follow-up produce the SAME preamble: resuming a web
 * conversation must not silently weaken the instructions.
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
  it('carries the tool catalog with schemas in the history half', () => {
    const { history } = renderRequest(options({ tools: TOOLS }))
    expect(history).toContain('list_dir')
    expect(history).toContain('JSON Schema')
  })

  it('never tells the model to output only the reply itself', () => {
    const { preamble } = renderRequest(options({ tools: TOOLS }))
    expect(preamble).not.toContain('只输出回复本身')
    expect(preamble).toContain('不要只说明你打算做什么')
  })
})

describe('renderIncrement', () => {
  it('sends only the new non-assistant turns', () => {
    const { history } = renderIncrement(options({ tools: TOOLS }), 2) ?? { history: '' }
    expect(history).toContain('第二个问题')
    expect(history).not.toContain('第一个问题')
    expect(history).not.toContain('第一个回答')
  })

  it('does not re-send the catalog or the schemas', () => {
    // 首轮已在同一个网页对话里给过,且 resumeBlocker 保证工具集未变。
    const { history } = renderIncrement(options({ tools: TOOLS }), 2) ?? { history: '' }
    expect(history).not.toContain('JSON Schema')
    expect(history).not.toContain('list_dir')
  })

  it('returns null when nothing new needs sending', () => {
    expect(renderIncrement(options({ tools: TOOLS }), 3)).toBeNull()
  })
})

describe('preamble equivalence', () => {
  // 这条是承重断言:增量只是历史的传输优化,不允许削弱指令。协议、任务措辞、
  // 当前提问一旦只出现在其中一条路径上,多轮之后模型就会失去格式约束,
  // 输出退化成叙述,adapter 看不到调用便报 stop,任务静默中断。
  it('is identical between an opening turn and a follow-up', () => {
    const full = options({ tools: TOOLS })
    expect(renderIncrement(full, 2)?.preamble).toBe(renderRequest(full).preamble)
  })

  it('is identical with and without tools declared', () => {
    expect(renderIncrement(options(), 2)?.preamble).toBe(renderIncrement(options({ tools: TOOLS }), 2)?.preamble)
  })

  it('states the call protocol verbatim, fenced', () => {
    for (const preamble of [
      renderRequest(options({ tools: TOOLS })).preamble,
      renderIncrement(options({ tools: TOOLS }), 2)?.preamble ?? '',
    ]) {
      expect(preamble).toContain(TOOL_CALL_OPEN)
      expect(preamble).toContain('```json')
      expect(preamble).toContain('{"name": "工具名", "arguments": {…}}')
    }
  })

  it('restates the live question on a tool-result step', () => {
    // 一轮的第二个 step:增量里只有工具结果,提问在第一个 step 就发过了。
    const withResult = options({
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: '那个目录下有几个文件夹' }] },
        { id: 'm2', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
        { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb\nc' }] }] },
      ],
      tools: TOOLS,
    })
    const rendered = renderIncrement(withResult, 1)
    expect(rendered?.preamble).toContain('当前要回答的问题')
    expect(rendered?.preamble).toContain('那个目录下有几个文件夹')
    expect(rendered?.history).toContain('a\nb\nc')
  })
})

describe('history rendering', () => {
  it('replays historical calls in a form the model will not re-emit', () => {
    // 用协议格式回放会让模型整段照抄(实测连我们生成的 id 一起复述),被认出来后就
    // 会把同一处编辑重做一遍。格式示范由每轮在场的 preamble 承担,历史只要可读。
    const { history } = renderRequest(options({
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
    expect(history).toContain('【已执行 c1 · read_file】')
    expect(history).toContain('参数：{"path":"a.ts"}')
    // 承重点:历史里不能出现协议标记,否则模型会当成待发出的调用照抄。
    expect(history).not.toContain(TOOL_CALL_OPEN)
  })
})
