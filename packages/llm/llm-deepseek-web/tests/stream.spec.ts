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
import { DsWebAdapter, UNPARSABLE_CALL_CODE } from '../src/adapter.ts'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
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
  return markAgentLoopRequest({
    provider: 'deepseek-web',
    model: 'deepseek-web',
    sessionId: 's1',
    system: '你是助手。',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '看看' }], source: { kind: 'user' } }],
    tools: tools.map(name => ({ name, description: name, parameters: { type: 'object' } })),
  } as never)
}

/**
 * The same request with `count` user messages, so history grows turn over turn.
 *
 * The marker is a WeakSet on object identity, so a spread copy loses it — every
 * turn has to be marked as itself.
 */
function turn(count: number) {
  const base = request() as unknown as { messages: unknown[] }
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: 'user',
    content: [{ type: 'text', text: `第 ${i + 1} 个问题` }],
    source: { kind: 'user' },
  }))
  return markAgentLoopRequest({ ...base, messages } as never)
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
    expect(blocks(chunks).filter(b => b.type === 'tool-call')).toMatchObject([
      { type: 'tool-call', name: 'glob', arguments: '{"pattern":"*.ts"}' },
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

describe('tool-call identity', () => {
  /** Every tool-call id the adapter emitted for one request. */
  async function callIds(adapter: DsWebAdapter, options: never): Promise<string[]> {
    return blocks(await collect(adapter, options)).flatMap(
      block => block.type === 'tool-call' ? [block.id as string] : [],
    )
  }

  it('never repeats an id across turns', async () => {
    // 会话重放按 id 认 tool-call:两轮里同位置的同名调用撞成一个 id,
    // 同一个 tool-call 就会收到两次 start,整段历史加载失败。
    const reply = '<tool_call>{"name":"read","arguments":{"file_path":"a.ts"}}</tool_call>'
    const adapter = new DsWebAdapter({ session: replaying(deltas([reply])), useAttachment: () => false })

    const first = await callIds(adapter, turn(1))
    const second = await callIds(adapter, turn(2))

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0]).not.toBe(first[0])
  })

  it('distinguishes two same-named calls in one reply', async () => {
    const reply = [
      '<tool_call>{"name":"read","arguments":{"file_path":"a.ts"}}</tool_call>',
      '<tool_call>{"name":"read","arguments":{"file_path":"b.ts"}}</tool_call>',
    ].join('\n')
    const adapter = new DsWebAdapter({ session: replaying(deltas([reply])), useAttachment: () => false })

    const ids = await callIds(adapter, turn(1))
    expect(new Set(ids).size).toBe(2)
  })
})

describe('unparsable call enters the harness error path', () => {
  // 承重点:一个都没读懂却明显在尝试调用时,回合不能以 completed 收尾 —— 那正是
  // 「它说要做，然后不动了」的来源。报 error 才能进 agent/request-error 与
  // dsh-llm-retry,复用 harness 自己的反馈循环,而不是在这里再造一个重问机制。
  // 带标记所以意图明确,但躯体里没有可用载荷 —— jsonrepair 也造不出对象。
  // (缺括号那种反而修得回来,那时应该报 tool-calls,见下一条。)
  const brokenCall = '我来看看。\n<tool_call>\nglob\n</tool_call>'

  it('reports an error finish instead of stop', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of new DsWebAdapter({ session: replaying(deltas([brokenCall])) }).stream(request())) {
      chunks.push(chunk)
    }
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.any(String) as string, code: UNPARSABLE_CALL_CODE } },
    })
  })

  it('still reports tool-calls when at least one call survived', async () => {
    // 同轮里既有读懂的也有没读懂的:执行读懂的那些,别把整轮判成失败。
    const mixed = [
      '```json',
      '{"name":"glob","arguments":{"pattern":"*.ts"}}',
      '```',
      '',
      '```json',
      '{"name":"read","arguments":{"file_path":',   // 连字符串都没开始,修不出来
      '```',
    ].join('\n')
    const chunks: StreamChunk[] = []
    for await (const chunk of new DsWebAdapter({ session: replaying(deltas([mixed])) }).stream(request())) {
      chunks.push(chunk)
    }
    expect(chunks.find(c => c.type === 'finish')).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reports plain stop for a reply that never attempts a call', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of new DsWebAdapter({ session: replaying(deltas(['已经改好了。'])) }).stream(request())) {
      chunks.push(chunk)
    }
    expect(chunks.find(c => c.type === 'finish')).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('providerRetryPolicy', () => {
  const normal = Object.freeze({
    mode: 'normal' as const,
    maxRetries: 2,
    retryableCodes: Object.freeze(['RATE_LIMIT']),
    initialDelayMs: 1,
    maxDelayMs: 2,
    jitterRatio: 0,
  })

  it('extends the configured codes rather than replacing them', () => {
    const adapter = new DsWebAdapter({ session: replaying([]), retryPolicy: () => normal })
    const policy = adapter.providerRetryPolicy('deepseek-web')
    expect(policy).toMatchObject({ mode: 'normal', maxRetries: 2 })
    expect(policy?.mode === 'normal' && policy.retryableCodes).toEqual(['RATE_LIMIT', UNPARSABLE_CALL_CODE])
  })

  it('leaves the policy alone when the deployment opts out', () => {
    const adapter = new DsWebAdapter({
      session: replaying([]),
      retryPolicy: () => normal,
      retryOnUnparsableCall: () => false,
    })
    expect(adapter.providerRetryPolicy('deepseek-web')).toBe(normal)
  })

  it('falls back to seam defaults when no policy is injected', () => {
    expect(new DsWebAdapter({ session: replaying([]) }).providerRetryPolicy('deepseek-web')).toBeUndefined()
  })
})
