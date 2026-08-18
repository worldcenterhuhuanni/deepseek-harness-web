import { describe, expect, it } from 'vitest'
import { parseToolCall, splitReply } from '../src/parse.ts'

const TOOLS = new Set(['bash', 'read', 'ls', 'glob', 'a', 'b', 'x'])

describe('splitReply', () => {
  it('passes plain text through unchanged', () => {
    expect(splitReply('你好，世界', TOOLS)).toEqual([{ kind: 'text', text: '你好，世界' }])
  })

  it('splits a marked call out of its surrounding text', () => {
    expect(splitReply('前文<tool_call>{"name":"ls"}</tool_call>后文', TOOLS)).toEqual([
      { kind: 'text', text: '前文' },
      { kind: 'tool-call', raw: '{"name":"ls"}' },
      { kind: 'text', text: '后文' },
    ])
  })

  it('accepts an open tag carrying attributes', () => {
    // 模型常写成 <tool_call name="read">;严格匹配裸标签会让整段调用退化成正文。
    expect(splitReply('<tool_call name="read">{"name":"read"}</tool_call>', TOOLS)).toEqual([
      { kind: 'tool-call', raw: '{"name":"read"}' },
    ])
  })

  it('emits several calls in one reply', () => {
    expect(splitReply('<tool_call>{"name":"a"}</tool_call><tool_call>{"name":"b"}</tool_call>', TOOLS)).toEqual([
      { kind: 'tool-call', raw: '{"name":"a"}' },
      { kind: 'tool-call', raw: '{"name":"b"}' },
    ])
  })

  it('recovers a call the model emitted without any marker', () => {
    expect(splitReply('先看看。\n{"name":"bash","arguments":{"command":"ls"}}', TOOLS)).toEqual([
      { kind: 'text', text: '先看看。\n' },
      { kind: 'tool-call', raw: '{"name":"bash","arguments":{"command":"ls"}}' },
    ])
  })

  it('leaves JSON that names no offered tool as text', () => {
    const reply = '配置长这样：{"name":"deepseek","arguments":{}}'
    expect(splitReply(reply, TOOLS)).toEqual([{ kind: 'text', text: reply }])
  })

  it('does not unbalance on braces inside argument strings', () => {
    const raw = '{"name":"bash","arguments":{"command":"echo \'{\'"}}'
    expect(splitReply(raw, TOOLS)).toEqual([{ kind: 'tool-call', raw }])
  })

  it('treats a truncated call as a call rather than dropping the tail', () => {
    // 回复被截断时开标签后的内容仍是调用体;解析失败会由 adapter 退回可见文本。
    expect(splitReply('<tool_call>{"name":"ls"', TOOLS)).toEqual([
      { kind: 'tool-call', raw: '{"name":"ls"' },
    ])
  })

  it('keeps a lone angle bracket as text', () => {
    expect(splitReply('1 < 2', TOOLS)).toEqual([{ kind: 'text', text: '1 < 2' }])
  })

  it('parses a marked call whose body is a rendered code block', () => {
    // 实测形态:模型写了开标签,代码块渲染后反引号没了,闭标签也没出现。
    const reply = '我先看看。\n<tool_call>\n\njson\n复制\n下载\n{"name": "glob", "arguments": {"pattern": "*.ts"}}'
    expect(splitReply(reply, TOOLS)).toEqual([
      { kind: 'text', text: '我先看看。\n' },
      { kind: 'tool-call', raw: 'json\n复制\n下载\n{"name": "glob", "arguments": {"pattern": "*.ts"}}' },
    ])
  })

  it('recovers the narrated form the web model actually emits', () => {
    // 站点自己的系统提示词压过输入框里的协议,模型改用这种写法宣告调用。
    const reply = '先看看结构。\n[调用 read] {"file_path": "/a/b.ts"}'
    expect(splitReply(reply, TOOLS)).toEqual([
      { kind: 'text', text: '先看看结构。\n' },
      { kind: 'tool-call', raw: '{"name":"read","arguments":{"file_path":"/a/b.ts"}}' },
    ])
  })

  it('recovers several narrated calls in one reply', () => {
    const reply = [
      '我来分析。',
      '[调用 read] {"file_path": "package.json"}',
      '[调用 bash] {"command": "ls"}',
    ].join('\n')
    expect(splitReply(reply, TOOLS).filter(event => event.kind === 'tool-call')).toHaveLength(2)
  })

  it('leaves a narrated name that is not an offered tool as text', () => {
    const reply = '[调用 deploy] {"target": "prod"}'
    expect(splitReply(reply, TOOLS)).toEqual([{ kind: 'text', text: reply }])
  })

  it('recovers every call from the reply that stalled the loop', () => {
    // 回归:这份回复曾一个调用都没解析出来,agent-loop 因此把该回合判成完成。
    const reply = [
      '先看看源码结构和实现细节。',
      '{"name": "bash", "arguments": {"command": "find src -name \'*.ts\'"}}',
      '<tool_call name="read">',
      '{"file_path": "README.md"}',
      '</tool_call>',
    ].join('\n')
    expect(splitReply(reply, TOOLS).filter(event => event.kind === 'tool-call')).toHaveLength(2)
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

  it('skips the debris a rendered code block leaves around the payload', () => {
    // 代码块渲染后反引号消失,留下语言标签和「复制/下载」按钮文字。
    expect(parseToolCall('json\n复制\n下载\n{"name":"glob","arguments":{"pattern":"*.ts"}}')).toEqual({
      name: 'glob',
      arguments: '{"pattern":"*.ts"}',
    })
  })

  it('rejects unusable payloads', () => {
    expect(parseToolCall('not json')).toBeNull()
    expect(parseToolCall('{"arguments":{}}')).toBeNull()
    expect(parseToolCall('"just a string"')).toBeNull()
  })
})
