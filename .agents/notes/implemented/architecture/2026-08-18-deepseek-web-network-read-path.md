# Agent Note: The web route reads the site's own response stream, and only writes through the DOM

Status: implemented

English | [中文](2026-08-18-deepseek-web-network-read-path.zh.md)

## Problem

Three bugs in one day stalled `deepseek-web` turns mid-task, each a different symptom of the same cause. The bridge read replies from the rendered DOM, and rendering is not a transport.

- Snapshots of `innerText` were treated as deltas. The page rewrites text it has already rendered, so a rewrite broke the prefix relation and the fallback re-emitted the whole snapshot; four rewrites concatenated four copies of the reply and destroyed `<tool_call>` pairing.
- Markdown collapses `\"` to `"`, so every call carrying a quoted argument arrived as unparseable JSON.
- A rendered code block loses its backticks but keeps the language tag and its own copy/download button labels, so a compliant call arrived as `<tool_call>\n\njson\n复制\n下载\n{…}`.

Each fix was correct and none addressed the cause. `agent-loop` behaved correctly throughout: a reply with no `tool-call` block is a final answer, so the turn completed.

The DOM path was justified as the change-resistant option. It is not: `page-agent.ts` located replies through `.ds-markdown`, an obfuscated class that moves with the site's front-end releases, and it paid the rendering tax on top.

## Decision

Read the reply from the site's own `POST /api/v0/chat/completion` response; keep writing through the DOM.

The response is `text/event-stream` carrying JSON-Patch-style frames (`{p, o, v}`, where `p`/`o` repeat the previous frame when omitted) against one response object. `CompletionStreamDecoder` projects the four paths worth projecting: `response/fragments` appends register a fragment and its kind, `response/fragments/-1/content` appends route to text or reasoning by that kind (`THINK` is reasoning), `response/status` set to `FINISHED` ends the turn, and `accumulated_token_usage` reports the conversation's running total.

What this buys is not elegance — it is that deltas are append-only and never revised, escapes survive verbatim, and no UI chrome is mixed in. All three bugs above are impossible on this path.

Writing stays on the DOM deliberately. The request is the page's own: it carries the site's PoW challenge (`create_pow_challenge`, `DeepSeekHashV1`, difficulty 144000), its cookies, and its signed headers. Passively reading the bytes coming back touches none of that, so the browser fingerprint stays a real user's and no request is ever synthesized.

Three mechanics the path depends on:

- **The listener arms before the prompt is sent.** `compose` is what triggers the completion request, so `openReplyStream` runs first and `askExclusive` consumes it afterwards. Enabling `Network` after `compose` misses the request entirely — the first live run failed exactly this way.
- **`dataReceived` before `streamResourceContent` returns carries lengths only.** Those bytes come back once, in that call's `bufferedData`, so pre-stream events are dropped rather than double-counted.
- **The turn total is exact; its split is not.** `accumulated_token_usage` is one number covering prompt and completion, while dsh's `TokenUsage` splits them. The sum takes the reported value — compaction triggers on the sum — and the split is proportional to a 4-chars-per-token estimate of each side.

Streaming returns with it. Visible text is emitted as it lands, capped at `visibleEnd`: the first position that could open a tool call, including a marker the tail is still growing into. A call must never also reach the user as text, and text once emitted cannot be withdrawn; the withheld tail goes through `splitReply` at the end, which is also where a candidate that turned out to be prose gets released.

`splitReply`'s tolerance stays. Format drift is the site's system prompt outranking ours, which has nothing to do with rendering — the four recognized forms are still all needed.

## Consequences

`page-agent.ts` loses reply extraction, the `MutationObserver` push channel, the "text went quiet" completion heuristic, and every obfuscated-class selector (`.ds-markdown`, `.ds-virtual-list-visible-items`). `PageSnapshot` keeps only `loggedIn`, `hasInput`, `failed`, and `busy` — all read from semantic attributes or page text. `session.ts` loses its polling loop. The net change removes more code than it adds.

`BridgeEvent` becomes a union: reply content is incremental again, and token totals ride the same stream instead of being read back off the session, so the adapter consumes the bridge without calling into it.

`classify` now also serves `attach`, which previously hard-coded `unknown` for a page-reported attachment failure that may well be a login or rate-limit problem. HTTP status on the completion request maps through `classifyStatus`.

What this route still cannot promise: the SSE field names and paths are the site's private contract, and `Network.streamResourceContent` is an experimental CDP command. A change to either fails loudly — an unknown path is not projected, a missing stream raises `TRANSPORT` — rather than silently producing wrong text.

## Alternatives considered

- **Keeping the DOM read path and hardening the parser further.** This is what the day's three fixes did. Each was necessary, none was sufficient, and the fourth symptom was already implied by the third: anything the page does between the model's bytes and `innerText` is ours to undo.
- **Driving the request ourselves instead of the page.** It would remove the DOM entirely, but it means computing `DeepSeekHashV1` for every turn and reproducing the site's signed headers — a synthesized request where the whole premise of this route is that the browser's own session is the real one.
- **Streaming without a cap and de-duplicating later.** There is no later: `text-delta` cannot be withdrawn once emitted, so a call already shown as text would have to stay shown.

## Follow-up: what a failure costs, and what a silence hides

Two gaps surfaced from reviewing this change, both fixed here.

**Resetting the open conversation on every failure was too coarse.** The reset exists because a failed turn leaves what the page received unknowable, so continuing would build the next increment on a wrong baseline. That reasoning only holds after the prompt was submitted. Before it — a login that expired at `waitReady`, an attachment the site would not parse, a composer that could not be found — the page never saw the turn, and reopening a conversation throws away a valid one for nothing. `BridgeEvent` gains a `submitted` milestone and the reset is conditional on it.

The judgement is deliberately not the error kind. `transport` covers both a stream that died after submission (must reset) and a composer that was never found (need not), while `not-logged-in` from `waitReady` is the safest case of all to keep. Error kind and "what the page received" have no causal relation.

**A frame the decoder cannot read left no trace.** Skipping it is right — one unreadable line should not void a reply already received — but silence is exactly what a protocol change would produce. The decoder now reports it as an `undecodable` event, which the session forwards as `diagnostic` and the adapter routes to `ctx.logger`; the decoder itself stays a pure projection with no logger of its own. Tool-call parse failures take the same route, because that rate is this route's only health signal and a failure there ends the turn as `completed`.

The opening-frame test also changed from position to shape. `p === undefined && lastPath === ''` identified the snapshot by being first; a site that ever led with a delta frame would have had that frame taken for a snapshot and its content dropped. `isSnapshot` checks for a `response` field instead.

## Testing

`tests/sse.spec.ts` decodes streams captured from the site — one whose payload carries escaped quotes (the case the DOM path corrupted), one that switches from a `THINK` fragment to a `RESPONSE` fragment mid-stream — and asserts identical output when frames are cut at arbitrary chunk boundaries. `tests/stream.spec.ts` drives `DsWebAdapter` over bridge events: text emitted per delta, a call withheld from visible text, a partial marker never leaked, a prose candidate released at the end, and the turn total anchored to the reported value. Live runs over `dsh --profile` execute multi-step tool loops end to end.
