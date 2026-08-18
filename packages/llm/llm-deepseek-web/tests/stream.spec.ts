/**
 * What the adapter emits while the site's stream arrives.
 *
 * The stream is append-only, so visible text goes out as it lands — but a tool
 * call must not also reach the user as text, and text once emitted cannot be
 * withdrawn. So streaming stops at the first thing that could open a call, and
 * the withheld tail is split after the reply completes.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/tests/stream
 */

import { describe, expect, it } from 'vitest'
import { DsWebAdapter } from '../src/adapter.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BridgeError, type AskRequest, type BridgeEvent, type WebSession } from '../src/session.ts'

/** A session that replays one turn's bridge events in order. */
function replaying(events: BridgeEvent[]): WebSession {
  return {
    ask(_request: AskRequest): AsyncGenerator<BridgeEvent> {
      return (async function* () {
        for (const event of events) yield event
      })()
    },
  } as unknown as WebSession
}

function deltas(text: string[]): BridgeEvent[] {
  return text.map(part => ({ kind: 'text' as const, text: part }))
}

function request(tools: string[] = ['glob', 'read']) {
  return {
    provider: 'deepseek-web',
    model: 'deepseek-web',
    sessionId: 's1',
    system: '你是助手。',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '看看' }], source: { kind: 'user' } }],
    tools: tools.map(name => ({ name, description: name, parameters: { type: 'object' } })),
  } as never
}

/** The same request with `count` user messages, so history grows turn over turn. */
function turn(count: number) {
  const base = request() as unknown as { messages: unknown[] }
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: 'user',
    content: [{ type: 'text', text: `第 ${i + 1} 个问题` }],
    source: { kind: 'user' },
  }))
  return { ...base, messages } as never
}

async function collect(adapter: DsWebAdapter, options: never): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function blocks(chunks: StreamChunk[]) {
  return chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
}

function textOf(chunks: StreamChunk[]): string {
  return blocks(chunks).flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('recovering an open web conversation after a failure', () => {
  /** A session whose *next* turn can be told to fail, before or after submitting. */
  function scripted() {
    const seen: AskRequest[] = []
    let mode: 'ok' | 'fail-before-submit' | 'fail-after-submit' = 'ok'
    const session = {
      ask(request: AskRequest): AsyncGenerator<BridgeEvent> {
        seen.push(request)
        // 只影响下一轮:第三轮要成功,才能看出适配器还认不认那条对话。
        const turn = mode
        mode = 'ok'
        return (async function* () {
          if (turn === 'fail-before-submit') throw new BridgeError('连接中断。', 'transport')
          if (turn === 'fail-after-submit') {
            yield { kind: 'submitted' }
            throw new BridgeError('连接中断。', 'transport')
          }
          yield { kind: 'text', text: 'ok' }
        })()
      },
    } as unknown as WebSession
    return { session, seen, fail: (how: 'fail-before-submit' | 'fail-after-submit') => { mode = how } }
  }

  /** Open a conversation, fail one turn the given way, then see if the next turn continues it. */
  async function continuesAfter(how: 'fail-before-submit' | 'fail-after-submit'): Promise<boolean> {
    const { session, seen, fail } = scripted()
    const adapter = new DsWebAdapter({ session, useAttachment: () => false })
    await collect(adapter, turn(1))
    fail(how)
    await collect(adapter, turn(2)).then(() => undefined, () => undefined)
    seen.length = 0
    await collect(adapter, turn(3))
    return seen[0]?.newChat === false
  }

  it('keeps the conversation when the prompt never reached the page', async () => {
    // 登录过期、附件没挂上都发生在提交之前:页面没见过这一轮,不必白白重开一个对话。
    expect(await continuesAfter('fail-before-submit')).toBe(true)
  })

  it('drops the conversation once the prompt was submitted', async () => {
    // 提交之后页面收到了多少、产出了什么都无从确认,续用会让下一轮的增量基线是错的。
    expect(await continuesAfter('fail-after-submit')).toBe(false)
  })
})

describe('streaming from the site stream', () => {
  it('emits visible text as it arrives', async () => {
    const adapter = new DsWebAdapter({ session: replaying(deltas(['先看', '看这个', '目录。'])), useAttachment: () => false })
    const chunks = await collect(adapter, request())
    // 逐块到达就逐块发出:一次一个 delta,不是收完再发一整段。
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text)).toEqual(['先看', '看这个', '目录。'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('withholds a call from the visible text and emits it as a call', async () => {
    const adapter = new DsWebAdapter({
      session: replaying(deltas(['先看看。\n', '<tool_call>\n', '{"name": "glob", ', '"arguments": {"pattern": "*.ts"}}', '\n</tool_call>'])),
      useAttachment: () => false,
    })
    const chunks = await collect(adapter, request())
    expect(textOf(chunks)).toBe('先看看。\n')
    expect(blocks(chunks).filter(b => b.type === 'tool-call')).toEqual([
      { type: 'tool-call', id: 'web-1-glob', name: 'glob', arguments: '{"pattern":"*.ts"}' },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('never leaks a partial marker as text', async () => {
    // 尾部可能正在长成标记;发出去就收不回来了。
    const adapter = new DsWebAdapter({
      session: replaying(deltas(['答案是 42', '<tool', '_call>{"name":"read","arguments":{}}</tool_call>'])),
      useAttachment: () => false,
    })
    const chunks = await collect(adapter, request())
    expect(textOf(chunks)).toBe('答案是 42')
  })

  it('releases a withheld candidate that turned out to be prose', async () => {
    // `{` 会封住流式,但它未必是调用;整段收完后这部分正文照样要放行。
    const adapter = new DsWebAdapter({
      session: replaying(deltas(['配置是 ', '{"port": 8080}', ' 就这样。'])),
      useAttachment: () => false,
    })
    const chunks = await collect(adapter, request())
    expect(textOf(chunks)).toBe('配置是 {"port": 8080} 就这样。')
    expect(blocks(chunks).filter(b => b.type === 'tool-call')).toEqual([])
  })

  it('anchors the turn total to what the site reported', async () => {
    const adapter = new DsWebAdapter({
      session: replaying([
        { kind: 'usage', totalTokens: 41437 },
        { kind: 'text', text: '好的' },
        { kind: 'usage', totalTokens: 41520 },
      ]),
      useAttachment: () => false,
    })
    const usage = (await collect(adapter, request())).find(c => c.type === 'usage')
    // 站点报的是一个数,覆盖提示词与回复;总和必须等于它,拆分只能是估的。
    const { inputTokens, outputTokens } = (usage as { usage: { inputTokens: number; outputTokens: number } }).usage
    expect(inputTokens + outputTokens).toBe(41520 - 41437)
    // 回复只有两个字,压倒性的份额属于提示词。
    expect(outputTokens).toBeLessThan(inputTokens)
  })

  it('falls back to an estimate when the stream reports no total', async () => {
    const adapter = new DsWebAdapter({ session: replaying(deltas(['12345678'])), useAttachment: () => false })
    const usage = (await collect(adapter, request())).find(c => c.type === 'usage')
    expect(usage).toMatchObject({ usage: { outputTokens: 2 } })
  })
})
