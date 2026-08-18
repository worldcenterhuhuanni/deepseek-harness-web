# Agent Note: The web bridge parses one final snapshot, and tolerates every call form the page actually produces

Status: implemented

English | [中文](2026-08-18-deepseek-web-snapshot-parsing.zh.md)

## Problem

A `dsh --profile` run over the `deepseek-web` route stopped mid-task: the model asked for a tool, the turn ended, and nothing executed. The session log for turn 1 step 3 holds one assistant message whose text repeats the same paragraph four times, each repetition slightly different, and zero `tool-call` blocks. `turn/end` records `{ kind: 'completed' }`.

`agent-loop` behaved correctly. `ReactLoopAgent.step` continues to the next step whenever the assistant message carries tool calls, and ends the turn when it carries none. The provider handed it none, so the loop had to read the reply as a final answer.

The provider lost them in `WebSession.consume`. The page reports the newest reply as a **full body snapshot**, and the bridge turned that into a delta:

```
const delta = fresh.startsWith(emitted) ? fresh.slice(emitted.length) : fresh
```

DeepSeek's web UI rewrites text it has already rendered — markdown reflow, escape correction. The captured log shows one such rewrite verbatim: `-name ".ts\"` became `-name "*.ts"` between two snapshots. A rewrite breaks the `startsWith` prefix relation, and the fallback branch emitted the **entire snapshot** as if it were new output. `ToolCallSplitter` is append-only, so four rewrites concatenated four copies of the reply.

Concatenation destroyed marker pairing: a `<tool_call>` opened in one copy was followed by the next copy's prose, so its `</tool_call>` never arrived, and `flush()` surrendered the whole run as visible text. A second defect compounded it — the splitter matched the open marker with `indexOf('<tool_call>')`, while the model had written `<tool_call name="read">`, which that comparison cannot see.

## Decision

The bridge reports snapshots and the adapter parses exactly once, after generation stops.

`BridgeEvent`'s `text` now carries the complete reply body rather than an increment; `DsWebAdapter.stream` keeps only the newest one and runs `splitReply` on it at the end of the stream. Incremental parsing was arguing with a data source that revises itself: a marker's two halves are not stable until the page stops rewriting, so no amount of buffering makes a partial reply safe to split.

The cost is that visible text no longer streams token by token. This route exists to supply tokens to dsh, not to render a typing animation, and a turn that silently drops every tool call is a worse experience than one that appears all at once.

Parsing a complete reply also made format tolerance cheap, so `splitReply` recovers three ways the model drifts:

- **Attributes on the open marker.** `/<tool_call\b[^>]*>/` accepts `<tool_call name="read">`.
- **An unterminated call.** The body runs to end of text rather than degrading the run to prose.
- **A missing marker entirely.** A bare top-level `{"name":…,"arguments":…}` is claimed as a call — but only when its name appears in this request's tool list, so ordinary JSON in a reply is never mistaken for one. `jsonObjectEnd` counts braces outside string literals, so a `{` inside an argument value does not unbalance the scan.

## The protocol is advisory, so the parser carries the weight

Fixing the concatenation was not enough — three further live runs each stalled on a different format failure, and together they establish what this route can and cannot promise.

**The site's own system prompt outranks ours.** With the whole request riding as an attachment, a run answered `[调用 glob] {"pattern": …}`: it named a tool it could only have read from the attached catalog, while inventing its own call syntax. An attachment is read as a document, and only the composer text is read as an instruction. `TOOL_CALL_PROTOCOL` now rides in the composer every turn, and `renderBlocks` replays historical calls in the same fenced form, because the model imitates what it has seen. A CDP probe confirms the composer preserves that text byte for byte — the model receives the protocol and still departs from it. Placement raises the hit rate; it does not make the format a guarantee.

**A rendered code block loses its fences.** Once the model did comply, the reply arrived as `<tool_call>\n\njson\n复制\n下载\n{…}`: `innerText` keeps the language tag and the code block's own copy/download button labels, but not the backticks. `parseToolCall` now takes the first balanced JSON object out of the body instead of parsing the body whole, which skips that debris and also subsumes the fence-stripping it used to do.

So the tolerance in `splitReply` is not defensive coding — it is this route's operating condition. Four forms are recognized: the protocol's fenced call, an attribute-bearing or unterminated marker, a bare `{"name":…,"arguments":…}` wrapper, and the narrated `[调用 name] {args}`. The last two are gated on the request's tool names.

Fencing the JSON also removes the escape corruption behind the original report: outside a fence the page renders `\"` as `"`, so any call carrying a quoted argument arrived as broken JSON.

## Alternatives considered

- **Emitting the common prefix on rewrite.** Three lines, and it stops the concatenation. Refused because it does not repair the reply: text already emitted cannot be withdrawn, so the pre-rewrite `.ts\"` escape stays in the stream and its tool call still fails to parse. It treats the duplication and leaves the corruption.
- **Holding the model to the protocol.** Tried, and measured: the protocol reached the composer verbatim and the model still answered in its own syntax. Arguing with a system prompt we do not control is not a fix; recognizing the form the model actually emits is.
- **Streaming a stable prefix and parsing the tail at the end.** Keeps the typing animation, but needs a rule for how far behind the snapshot head text is safe to emit, and the rule has to know where a marker might begin — including the marker-less form, which has no opening token to look for. The complexity buys an animation on a route that polls the DOM every 120ms anyway.

## Consequences

A `deepseek-web` turn that asks for tools now runs them: the loop sees the `tool-call` blocks it was previously denied and takes its next step. The reply arrives as one piece when generation stops rather than growing token by token, and duplicated reply text disappears from the session log — it was never model output, only the bridge's own concatenation.

`ToolCallSplitter` is gone, and with it the held-suffix buffering that existed only to make marker matching safe across chunk boundaries. `splitReply(text, knownTools)` replaces it in the package's public exports.

Bare-JSON recovery is gated on the request's tool names, so a reply that discusses a `{"name":…,"arguments":…}` payload for a tool that is not on offer stays visible text. A reply that discusses one for a tool that *is* on offer would be claimed as a call; nothing here distinguishes the two, and the gate is what keeps that case narrow.

## Testing

`tests/parse.spec.ts` covers the splitter's format tolerance, including the reply from the captured session that produced zero calls. `tests/snapshot-stream.spec.ts` drives `DsWebAdapter` with successive rewritten snapshots and asserts one tool-call block, unduplicated text, and a `tool-calls` finish reason.
