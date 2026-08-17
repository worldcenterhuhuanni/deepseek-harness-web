import { describe, expect, it } from 'vitest'
import { ToolCallSplitter, parseToolCall } from '../src/parse.ts'

/** Feed a whole reply one chunk at a time and collect everything the splitter emits. */
function run(chunks: string[]) {
  const splitter = new ToolCallSplitter()
  const events = chunks.flatMap(chunk => splitter.push(chunk))
  return [...events, ...splitter.flush()]
}

describe('ToolCallSplitter', () => {
  it('passes plain text through unchanged', () => {
    expect(run(['你好', '，世界'])).toEqual([
      { kind: 'text', text: '你好' },
      { kind: 'text', text: '，世界' },
    ])
  })

  it('splits a marker arriving across chunk boundaries', () => {
    const events = run(['前文<tool', '_call>{"name":"ls"}</tool', '_call>后文'])
    expect(events).toEqual([
      { kind: 'text', text: '前文' },
      { kind: 'tool-call', raw: '{"name":"ls"}' },
      { kind: 'text', text: '后文' },
    ])
  })

  it('withholds a partial marker instead of leaking it as text', () => {
    const splitter = new ToolCallSplitter()
    // 只喂到半截标记时,不能把 "<tool" 当正文放出去。
    expect(splitter.push('答案是 42<tool')).toEqual([{ kind: 'text', text: '答案是 42' }])
    expect(splitter.push('_call>{"name":"x"}</tool_call>')).toEqual([
      { kind: 'tool-call', raw: '{"name":"x"}' },
    ])
  })

  it('emits several calls in one reply', () => {
    const events = run(['<tool_call>{"name":"a"}</tool_call><tool_call>{"name":"b"}</tool_call>'])
    expect(events).toEqual([
      { kind: 'tool-call', raw: '{"name":"a"}' },
      { kind: 'tool-call', raw: '{"name":"b"}' },
    ])
  })

  it('returns an unterminated call as visible text rather than dropping it', () => {
    // 模型跑格式时不能静默吞掉内容,否则上层看到的是凭空消失的一段回复。
    expect(run(['<tool_call>{"name":"ls"'])).toEqual([
      { kind: 'text', text: '<tool_call>{"name":"ls"' },
    ])
  })

  it('keeps a lone angle bracket as text', () => {
    expect(run(['1 < 2'])).toEqual([{ kind: 'text', text: '1 < 2' }])
  })
})

describe('parseToolCall', () => {
  it('extracts name and re-serializes arguments', () => {
    expect(parseToolCall('{"name":"read","arguments":{"path":"a.ts"}}')).toEqual({
      name: 'read',
      arguments: '{"path":"a.ts"}',
    })
  })

  it('defaults missing arguments to an empty object', () => {
    expect(parseToolCall('{"name":"list"}')).toEqual({ name: 'list', arguments: '{}' })
  })

  it('tolerates a fenced code block around the payload', () => {
    expect(parseToolCall('```json\n{"name":"read","arguments":{}}\n```')).toEqual({
      name: 'read',
      arguments: '{}',
    })
  })

  it('rejects unusable payloads', () => {
    expect(parseToolCall('not json')).toBeNull()
    expect(parseToolCall('{"arguments":{}}')).toBeNull()
    expect(parseToolCall('"just a string"')).toBeNull()
  })
})
