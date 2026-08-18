/**
 * Decoding the site's completion stream, against bytes captured from it.
 *
 * The fixtures are real: one plain reply whose payload carries escaped quotes,
 * one deep-thinking reply that switches fragments mid-stream. They are what
 * proves the reply text arrives exact — the DOM path collapsed `\"` to `"` and
 * mixed code-block button labels into the same text.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/tests/sse
 */

import { describe, expect, it } from 'vitest'
import { CompletionStreamDecoder, type StreamEvent } from '../src/sse.ts'

/** Feed a whole captured stream, optionally cut into fixed-size chunks. */
function decode(raw: string, chunkSize = Infinity): StreamEvent[] {
  const decoder = new CompletionStreamDecoder()
  const events: StreamEvent[] = []
  for (let i = 0; i < raw.length; i += chunkSize) {
    events.push(...decoder.push(raw.slice(i, i + chunkSize)))
  }
  return events
}

function joined(events: StreamEvent[], kind: 'text' | 'reasoning'): string {
  return events.flatMap(e => e.kind === kind ? [e.delta] : []).join('')
}

const FENCED = [
  'event: ready',
  'data: {"request_message_id":11,"response_message_id":12,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1787021076.512405}',
  '',
  'data: {"v":{"response":{"message_id":12,"status":"WIP","accumulated_token_usage":41437,"fragments":[{"id":2,"type":"RESPONSE","content":"```","references":[],"stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"json"}',
  '',
  'data: {"v":"\\n"}',
  '',
  'data: {"v":"{\\""}',
  '',
  'data: {"v":"command"}',
  '',
  'data: {"v":"\\":"}',
  '',
  'data: {"v":" \\""}',
  '',
  'data: {"v":"find src -"}',
  '',
  'data: {"v":"name"}',
  '',
  'data: {"v":" \\\\\\""}',
  '',
  'data: {"v":"*.ts"}',
  '',
  'data: {"v":"\\\\"}',
  '',
  'data: {"v":"\\"\\""}',
  '',
  'data: {"v":"}\\n"}',
  '',
  'data: {"v":"```"}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":41520},{"p":"quasi_status","v":"FINISHED"}]}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  'event: close',
  'data: {"click_behavior":"none","auto_resume":false}',
  '',
  '',
].join('\n')

const THINKING = [
  'data: {"v":{"response":{"message_id":14,"thinking_enabled":true,"status":"WIP","fragments":[{"id":2,"type":"THINK","content":"我们需要","references":[],"stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"回答"}',
  '',
  'data: {"v":"问题"}',
  '',
  'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.034696342}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"1","references":[],"stage_id":1}]}',
  '',
  'data: {"p":"response/fragments/-1/content","v":"+"}',
  '',
  'data: {"v":"1=2"}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  '',
].join('\n')

describe('CompletionStreamDecoder', () => {
  it('reassembles the reply with escapes intact', () => {
    // 渲染路径会把 \" 折成 ",这份载荷正是因此损坏过。
    const events = decode(FENCED)
    expect(joined(events, 'text')).toBe(
      '```json\n{"command": "find src -name \\"*.ts\\""}\n```',
    )
    expect(joined(events, 'reasoning')).toBe('')
  })

  it('reports the site-provided token total and the finish', () => {
    const events = decode(FENCED)
    expect(events.filter(e => e.kind === 'usage')).toEqual([
      { kind: 'usage', totalTokens: 41437 },
      { kind: 'usage', totalTokens: 41520 },
    ])
    expect(events.at(-1)).toEqual({ kind: 'finished' })
  })

  it('routes THINK fragments to reasoning and later ones to text', () => {
    const events = decode(THINKING)
    expect(joined(events, 'reasoning')).toBe('我们需要回答问题')
    expect(joined(events, 'text')).toBe('1+1=2')
  })

  it('decodes identically when frames are split across chunks', () => {
    // CDP 按传输块推送,帧边界与块边界无关。
    for (const size of [1, 7, 64]) {
      expect(joined(decode(FENCED, size), 'text')).toBe(joined(decode(FENCED), 'text'))
      expect(joined(decode(THINKING, size), 'reasoning')).toBe(joined(decode(THINKING), 'reasoning'))
    }
  })

  it('reports an undecodable frame instead of swallowing it', () => {
    // 静默吞掉是协议变更唯一会留下的痕迹,所以要报出来;回复本身继续。
    const frames = ['data: not json', '', 'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"好"}', '', '']
    expect(decode(frames.join('\n'))).toEqual([
      { kind: 'undecodable', detail: 'not json' },
      { kind: 'text', delta: '好' },
    ])
  })

  it('ignores frames it parses but does not project', () => {
    const frames = [': heartbeat', '', 'data: {"p":"response/feedback","o":"SET","v":null}', '', '']
    expect(decode(frames.join('\n'))).toEqual([])
  })

  it('treats a leading delta frame as a delta, not as the opening frame', () => {
    // 开场帧按形状认(v 里有 response),不按「还没见过 path」认 —— 否则站点一改成
    // 先发 delta,那一帧就会被当开场帧、内容悄悄消失。
    const frames = [
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":1,"type":"RESPONSE","content":""}]}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"开头"}',
      '',
      '',
    ]
    expect(joined(decode(frames.join('\n')), 'text')).toBe('开头')
  })
})
