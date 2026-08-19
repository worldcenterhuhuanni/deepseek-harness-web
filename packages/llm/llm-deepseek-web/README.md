# dsh-llm-deepseek-web

English | [中文](README.zh.md)

Bridge a **signed-in chat.deepseek.com session** into dsh's LLM seam, with no API key and no browser extension.

The plugin drives a real Chrome over the Chrome DevTools Protocol (launched by the plugin itself, with its own profile, leaving your daily browser alone): the login, cookies, and fingerprint are all genuine, with none of the automation traces Playwright leaves. The page returns plain text, and the plugin turns it into dsh's `StreamChunk` grammar — tool calls included, which dsh cannot tell apart from a native one.

## Enabling it

**Your running Chrome is left alone.** The plugin launches its own instance with a separate profile, and the two coexist.

1. Mount the plugin in the **user layer** of a dsh profile, changing no upstream file in the repository:

   ```sh
   node packages/llm/llm-deepseek-web/launcher/install-profile.mjs
   ```

   The script idempotently writes two places under `$DSH_HOME/profiles/web/`: a dependency in `package.json` (`link:` to this package, letting pnpm manage the profile's `node_modules`) and one insert in `cordis.patch.yml`. The user patch layer applies after every bundle layer (see `packages/boot/app-boot/src/profile.ts`), so `packages/bundle/base/` needs no edit and upstream updates never conflict. A profile name may follow, defaulting to `web`; `dsh web --dump-config` confirms the row reached the composed tree.

2. Start dsh and find "DeepSeek 网页（已登录）" under **Settings → Models**. It has no API-key field — the credential is your browser session.

3. Make it the default model (`$DSH_HOME/settings.yaml`):

   ```yaml
   agent-default-model:
     provider: deepseek-web
     model: deepseek-web
   ```

4. On the first message the plugin opens a browser window at chat.deepseek.com. **Sign in once there**; the profile is reused from then on.

### Why your already-running Chrome cannot be reused

The debugging port is a **launch argument**, and a running process cannot open one after the fact — otherwise any local program could silently hijack the browser you are using. And while an instance is running, `--remote-debugging-port` is merely handed to it, the new process exits, and no port opens.

So the plugin starts a separate instance under its own `--user-data-dir`, fully coexisting with your daily browser. To drive a browser you started yourself, turn `autoLaunch` off and launch it with a debugging port.

## Layout

| File | Responsibility |
|------|------|
| `src/cdp.ts` | Minimal CDP client: target discovery, command exchange, file-input population |
| `src/page-agent.ts` | The injected page script, with selectors carried over from a production content script |
| `src/session.ts` | Drives one turn: navigate, fill, send, consume the reply |
| `src/render.ts` | Renders `GenerateOptions` by content role into `preamble` + `history` |
| `src/parse.ts` | Splits the page's text into visible text and tool calls |
| `src/adapter.ts` | The `LlmAdapter` implementation |

## Configuration

| Field | Default | Meaning |
|------|------|------|
| `endpoint` | `http://127.0.0.1:9222` | Chrome DevTools endpoint |
| `autoLaunch` | `true` | Launch a separate instance when the endpoint does not answer |
| `userDataDir` | `$DSH_HOME/deepseek-web-profile` | Profile directory for the launched browser |
| `chromePath` | autodetected | Chrome executable; `CHROME_PATH` also applies |
| `inlineLimit` | `4000` | Conversation body beyond this many characters rides as a `.md` attachment; never affects the always-composer `preamble` |
| `useAttachment` | `true` | Turn off to keep the body in the composer too; a fallback for when the site rejects `.md` |
| `retryPolicy` | seam defaults | Retry policy for this route, on the same schema the official `llm-deepseek` uses |
| `retryOnUnparsableCall` | `true` | Resend the turn under the retry policy when no call could be parsed, instead of counting the turn as finished |
| `idleTimeoutMs` | `180000` | How long the page may show no activity before the turn fails |
| `hardTimeoutMs` | `600000` | Absolute ceiling for one turn |
| `deepThinking` | `false` | The site's deep-thinking mode; it markedly delays the first token |
| `webSearch` | `false` | The site's web search. **It is on by default there**: 32.7s to first token measured with it on, 2.9s with it off |
| `retryOnBlockedPage` | `true` | Resend the turn when the site refuses to send, switching to a different web conversation first |
| `sendableTimeoutMs` | `5000` | Ceiling for the send key to become usable; a timeout is treated as the site disabling it |
| `submitTimeoutMs` | `3000` | Ceiling for one submit method to take effect before the next is tried |
| `attachTimeoutMs` | `120000` | Ceiling for the upload plus the site's parse; raise it for large files or slow networks |
| `loginHints` | see `DEFAULT_PAGE_HINTS` | Notice words that mean "not signed in" |
| `failHints` | see `DEFAULT_PAGE_HINTS` | Notice words that mean this attachment failed to mount |
| `busyHints` | see `DEFAULT_PAGE_HINTS` | Notice words that mean an attachment is still uploading or parsing |
| `blockedHints` | see `DEFAULT_PAGE_HINTS` | Notice words that mean the site refuses to send; add to this when the site rewords |

Everything except `endpoint` is read per request, so an edit applies to the next call.

## Design notes

**One dsh session maps to one web conversation, and a follow-up sends only what is new.** The web conversation remembers earlier turns, so a follow-up carries just the new user messages and tool results; assistant messages are skipped, since the page produced them and replaying them would duplicate them.

Reuse is decided by a **message-id prefix check**: same dsh session, unchanged system prompt and tool set, and everything already sent still an exact prefix of the new history. Compaction rewrites that prefix, and then a fresh conversation starts. This avoids re-sending everything each turn without letting the page's memory silently diverge from what dsh believes.

**The site's search and thinking toggles are turned off at the start.** A new conversation restores them to the site's defaults, and web search defaults to on — measured, it moves first-token latency from 2.9s to 32.7s.

**`Emulation.setFocusEmulationEnabled`, not `Page.bringToFront`.** This profile may hold more than one tab, and an inactive tab reports `document.hidden === true`, which the site degrades on (animations stop, rendering is deferred). Focus emulation makes the page believe it is visible and focused without raising the window or stealing keyboard focus — `bringToFront` flips visibility at the cost of the browser jumping at you every turn. `setWebLifecycleState('active')` governs the freeze/discard lifecycle and cannot move visibility.

**Sending goes through the element's `click()`, not synthetic input events.** Of the three submit paths, only this one is reliably effective in practice. Synthetic events depend on window and focus state, while this plugin's normal shape is running in the background; a DOM call is unaffected. Synthetic events remain the fallback.

**The reply is read from the site's own SSE response, not from the DOM.** `POST /api/v0/chat/completion` answers with `text/event-stream`, carrying JSON-Patch-style frames against one response object. Subscribing with `Network.streamResourceContent` yields the model's raw output: append-only deltas that never rewrite themselves, escapes intact (`\"` stays `\"`, while a rendered `innerText` folds it to `"`), and none of the language tag or copy/download button text a code block contributes.

Reading the DOM produced three classes of bug, all artifacts of the rendering layer and none of them present on this path: concatenating snapshots that rewrite themselves as if they were deltas, escapes eaten by markdown, and code-block debris polluting a JSON payload.

**Only reading changed; writing still goes through the DOM.** The request is the page's own — it carries the site's proof-of-work challenge (`create_pow_challenge`, `DeepSeekHashV1`, difficulty 144000), cookies, and signed headers, and we only read the bytes that come back. So the composer is still filled with `Input.insertText` and sending still clicks an element, the fingerprint stays that of a human operating the page, and the proof of work is never touched.

**The subscription must be in place before sending.** The reply request goes out inside `compose`; putting `Network.enable` and the event subscription after it means that request is never observed.

**A `dataReceived` before `streamResourceContent` returns reports only a length.** Those bytes arrive at once in that call's `bufferedData`, so events from before the stream was established are dropped rather than counted twice.

**Failure bookkeeping has two independent dimensions: whether the content baseline still holds, and whether the page carrying it still works.**

The content dimension tests whether the prompt already entered the conversation (the `submitted` milestone). Failing before submission (an expired login, an attachment that never mounted, a composer that could not be found) leaves the page unaware of this turn and the baseline intact; failing after submission leaves what the page received and produced unknowable, so the baseline is discarded — otherwise the next increment builds on a wrong starting point.

The channel dimension tests whether the site is still willing to let this page send. Once an upload fails, the site leaves a broken attachment card in the composer, disables the send key, and demands it be removed first — the conversation content has not changed by one character, the baseline is perfectly valid, and yet this page will never send anything again. With only the content dimension the page keeps being reused: all three submit methods fail in turn, the error reads "the page may have changed", the retry mounts another attachment, and the residue piles up until every turn from then on fails to send. So `page-blocked` is recorded on the channel dimension alone, and the next turn switches to a different web conversation (`newChat` plus full history) instead of staying on that page.

**State is read inside the composer only, never off the whole page.** The site puts its attachment failure and busy notices in the composer, while `document.body.innerText` holds the entire transcript — so once the conversation itself discusses words like 「解析失败」, 「处理中」, or `Loading`, content gets read as state. The transcript never loses those words, so every turn from then on fails: the attachment is reported as failed (with a "site notice" quoted from the model's own reply), or `busy` stays true until the two-minute timeout. Hence `snapshot()` matches within `composerBox()` only; a hit outside the composer is recorded in `failedElsewhere` and surfaces solely as a clue in the timeout message, never as a verdict.

**"This mount failed" and "this page cannot send" are two states with different verdicts.** `failed` means this attempt did not mount and mounting again may well work; `blocked` means residue from an earlier attempt is still sitting in the composer and the site keeps the send key disabled. The first retries under its original classification, the second becomes `page-blocked` and switches channels.

**Every hint table comes from configuration, never from the injected script.** One reworded notice is enough to blind a hardcoded table — which is exactly how this failure happened: `请删除异常文件再发送` was not in the original table, so the mount was reported ready and nothing surfaced until all three submit methods had failed, under a message unrelated to the cause. The default tables have one home in `DEFAULT_PAGE_HINTS`, the four `*Hints` config fields reference it, and a line added in cordis.yml takes effect on the next read — no plugin release needed.

**A send that fails has to explain itself.** Both the verdict and the message come from the page text at that moment: a hit in the refusal table reports the site's own wording as `page-blocked`, and no hit quotes the composer verbatim (`hint`) into the error. Waiting for the send key works the same way — if it never becomes usable the site has disabled it deliberately, all three submit methods are then certain to fail, and reporting the page's reason beats trying them and guessing.

**Link progress goes to the logger, not into the chunk stream.** Mounting an attachment can take two minutes and must report something meanwhile; but the chunk stream is the model-output channel, whose contents must all be reconstructable from the session log, so `progress` and `diagnostic` share the one `ctx.logger` exit.

**Anything we cannot read leaves a trace.** The bridge has no logger of its own, so it reports diagnostics as `diagnostic` events that the adapter routes to `ctx.logger`. There are two today: a reply frame that will not parse as JSON (the only trace a protocol change leaves), and a tool call that will not parse (this route's format rests entirely on the model's cooperation, and the parse-failure rate is its only health signal — a failure that also gets the turn counted as finished).

**Completion and usage are both self-reported by the stream.** A `response/status` of `FINISHED` ends the turn, with no need for a heuristic like "text unchanged for N polls". `accumulated_token_usage` gives a running conversation total, and the difference across the turn is its real cost — one number covering prompt and completion, so `TokenUsage` takes that exact total and splits input/output by a character-based estimate.

**The split is estimated; the total is not.** dsh's compaction triggers on the total, and that is the half that has to be right.

**Requests must queue.** One tab is one physical resource: two concurrent `ask()` calls each run `Input.insertText` into the same composer, the site receives both prompts concatenated, and it answers whichever instruction it read last — the user's "answer" turns out to be a generated title.

**Auxiliary requests use a throwaway tab and never compete with the main conversation.** dsh generates the session title through an extra LLM request. It needs one exchange and never returns, while the main conversation continues indefinitely — `isAgentLoopRequest` separates them: the main request binds its own tab (`mainTargetId`), and an auxiliary request runs in a new tab that closes when done, taking no part in conversation bookkeeping.

Physical isolation rather than time-sharing, because of which side pays: letting an auxiliary request navigate the main tab loads an empty new conversation (fast) while the main request has to reload its whole history to come back (tens of seconds on a long conversation). The lighter side pays.

For the record, why this used to degrade: `resolveTarget` looked for "the first DeepSeek tab" every time, so a title request navigated the main conversation's page away; the conversation record survived while its page did not, and the next turn could only start over.

**Tool calls are a text protocol: body streams out, calls are parsed only once the reply is complete.** The prompt injects each tool's JSON Schema and asks the model for `<tool_call>…</tool_call>`. A call's JSON is usable only when complete, while the body can go out as it lands — so streaming stops at `visibleEnd`: the first position that could open a call, including a partial marker the tail is still growing into, because emitted text cannot be withdrawn and a call must never also appear as visible text. The withheld tail goes to `splitReply` at the end of the reply, which releases it as text when it turns out to be ordinary prose (a paragraph discussing JSON, say).

A call that will not parse is not dropped silently: `agent-loop` counts zero tool-call blocks as a finished turn and the task stops halfway, so it falls back to visible text where a human can see what happened.

**When none of them parse, the finish is `error`, not `stop` — the harness's own feedback loop takes over.** This route cannot promise the model writes a parsable call, so the recovery that matters is not one more repair heuristic but the two feedback channels the harness already has: calls that did parse go out as usual, wrong arguments are rejected by the tool executor and the error reaches the next turn with its `tool-result` for the model to act on; and when nothing parsed while the reply plainly attempted a call, the turn ends with `{ kind: 'error', code: UNPARSABLE_TOOL_CALL }`, entering `agent/request-error` and the [`dsh-llm-retry`](../llm-retry/README.md) behind it, which resends the turn under this provider's retry policy. The adapter appends `UNPARSABLE_TOOL_CALL` to the configured `retryableCodes` through `providerRetryPolicy()` — appending rather than replacing, so the deployment's own codes, delays, and attempt ceiling stay authoritative; `retryOnUnparsableCall: false` opts out. A turn that mixes parsed and unparsed calls still reports `tool-calls`, because discarding the calls that did parse costs more than a retry saves.

**The protocol must reach the composer, and attention is still not ours.** The site's own system prompt outranks anything we say: with the format rule in the attachment only, the model reads the tool catalog out of it (it names tools it could only have read there) while treating the format as prose it may paraphrase — measured output included `[调用 glob] {"pattern": …}`, a syntax of its own invention. So a request is split by **content role**, never by transport: `preamble` (this turn's question, the task instruction, and `TOOL_CALL_PROTOCOL`) always reaches the composer, and only `history` (conversation body and tool catalog) may move into an attachment. Even so this raises the hit rate rather than guaranteeing anything. Historical calls are **not** replayed in this format; the next note says why.

**Historical calls are not replayed in the protocol format.** Replaying them in it was deliberate — let the model see the correct syntax. But it copies them wholesale, our generated `id` (`web-<uuid12>-<name>`) included, and once such a restatement is recognized it redoes the same edit a second time. The protocol now rides in `preamble` every turn, so the demonstration no longer depends on history, and history renders as `【已执行 <id> · <tool>】` plus one line of arguments: readable, matchable against its tool result, and unlike an instruction waiting to be issued.

**A missing closing tag does not mean the reply was truncated.** The model often writes `<tool_call>` and omits `</tool_call>` while more calls follow. The old behavior took **everything after the open tag** as that one call's body, so five calls in a turn left only the first executed, the rest vanishing along with their fences, and the task stopped halfway. The boundary now ends at the first ```json fence inside the marker; only when no fence end exists at all is it treated as a genuine truncation. A marked call skips the tool-set gate — the marker is already an explicit intent, and an unknown tool name is rejected by the executor for the model to correct.

**The fence is the call's boundary, and each block parses on its own.** The protocol asks for the payload inside a ```json fence, so parsing splits on fences first and reads JSON within a block. Brace counting across the whole reply cannot do this: once the model drops the outermost `}` at the end of long `arguments` (one `edit` carrying two code blocks), counting runs past that block into the next, depth never returns to zero, and both calls degrade into visible text — whereupon `agent-loop` counts zero tool-call blocks, calls the turn finished, and the task stops silently halfway. A malformed payload inside a block gets one pass through [`jsonrepair`](https://github.com/josdejong/jsonrepair) before a retry: besides the dropped closing brace it also recovers a truncated string and the single-quote / trailing-comma spelling the model falls back to, and it throws on input it cannot fix. Repair is safe only inside the known boundary a fence provides, and a repaired payload still has to parse, carry a `name`, and name a tool offered this turn — three gates before it is accepted. Repaired `arguments` may be incomplete, and the tool then rejects them for the model to retry — better than silently calling the turn finished.

**Hence the parser has to be extremely tolerant.** This is not defensive programming but a standing condition of the route — we cannot constrain the output format, only recognize the forms the model actually uses. Seven are recognized today:

| Form | Origin |
|---|---|
| `<tool_call>` plus a `json` code block | What the protocol prescribes |
| A ```json fence with no `<tool_call>` marker | The model drops the marker but keeps the fence (most common) |
| A fence missing the outermost `}` | A brace dropped at the end of long `arguments`; `jsonrepair` fixes it |
| A truncated string, single quotes, a trailing comma | Same, covered by `jsonrepair` |
| `<tool_call name="read">` with attributes, or no closing tag | The model omitted it, or the reply was truncated |
| A bare `{"name":…,"arguments":…}` | The model wrote no marker at all |
| `[调用 read] {args}` | Its own syntax, when the site's system prompt outranks the protocol |

The last two are gated on this turn's tool names, so ordinary JSON in a reply is never mistaken for a call. The payload is the **first balanced JSON object** rather than the whole passage: a rendered code block loses its backticks, and what survives in `innerText` is the language tag plus the block's own copy/download button text (`json\n复制\n下载\n{…}`), on which parsing the whole passage necessarily fails. A parse failure is not dropped silently; it falls back to visible text.

**A long context rides as an attachment, but only the body does.** Conversation body beyond `inlineLimit` is spilled to a `.md` file, mounted with `DOM.setFileInputFiles`, and the temporary file is removed at the end of the turn; `preamble` takes no part in that decision. Size decides the transport and must not decide which instructions the model receives — it once did: the protocol hung on the attachment path's companion text alone, while an increment's body was far too short to reach the threshold, so from the second turn on the protocol reached the model on no path at all.

**Token usage is estimated.** The page reports no token count, yet dsh's compaction depends on one — without it a long session never compacts. The current estimate is 4 characters per token.

## One-click launch

`launcher/` chains "check the environment → install dependencies → build when needed → mount the profile → start the Web UI → open the browser" into one step that runs on a double-click; a missing Node is installed too (nvm on macOS, winget on Windows), and steps already satisfied are skipped.

| Platform | Double-click | Implementation |
| --- | --- | --- |
| macOS / Linux | `launcher/launchMac.command` | The same file |
| Windows | `launcher/launchWindow.cmd` | `launcher/launch.ps1` |

`--rebuild` / `-Rebuild` forces a rebuild, and `--self-test` / `-SelfTest` runs the internal version-check cases only. Ports are taken from 3080 upward, skipping ones in use.

**A stale build is rebuilt automatically, decided by timestamp rather than by "does the file exist".** This bears on correctness: dsh itself runs `src` through tsx, but this plugin is loaded by Node as `main: lib/index.js` out of the profile's `node_modules`, so editing `src` without rebuilding still runs the old code — while the launch reports success at every step, which is the hardest class of problem to find. The launcher therefore compares whether any `.ts` under `packages/*/*/src` or `apps/*/src` is newer than `apps/cli/lib/bin.js` (`find … -print -quit`, stopping at the first hit); a change under `tests/` does not count, because tsdown packages `src` only. Restart the launcher after editing source and there is nothing to remember about `--rebuild`.

Command line without the double-click, equivalent to "mount the profile + `pnpm dsh web`" and just as idempotent (on the default port 3080):

```sh
pnpm --filter @deepseek-ai/dsh-llm-deepseek-web start
```

`~/.dsh/` is not under version control, so cloning this repository and running `pnpm dsh web` **directly** will not mount this plugin (dsh only generates an empty profile skeleton): one of the entry points above has to run `install-profile.mjs` once.

Downloading the `.command` straight from GitHub loses its executable bit and it will not open on a double-click, so distribute it zipped (a zip preserves the permission bits).

## Model Experience

### Preamble: the instructions that reach the composer every turn

#### What the model sees

One Markdown block of fixed structure, always sent as composer text regardless of transport: this turn's question (the last user message carrying a text block, skipping tool-result carriers), the task instruction below, and the tool-call protocol. The protocol asks the model to write a call as a `json` code block wrapped in `<tool_call>`, with `{"name": …, "arguments": …}` as the payload, and states that `arguments` must satisfy that tool's JSON Schema, that the JSON must sit inside the code block (or quotes in the arguments break when the page renders them), and that several calls may follow one another; the authoritative text is `TOOL_CALL_PROTOCOL` in `src/render.ts` and is not transcribed here, because it contains markdown code fences of its own and cannot nest in the `markdown` block this section requires. The site's own system prompt outranks all three, so they raise compliance rather than guarantee it.

##### Task instruction, verbatim

```markdown
## 你的任务

接着上面的对话，以助手身份给出下一条回复。
提问包含多个要点时，按提问的顺序逐条回答：先给出结论，再展开说明。
需要用工具才能回答时，直接按约定的 <tool_call> 格式输出调用，不要只说明你打算做什么。
```

#### Token effect

Fixed, resent every turn: the protocol and task instruction total roughly 200 characters, plus the length of this turn's question. An opening turn and a follow-up produce a byte-identical preamble — a deliberate contract, asserted by the equivalence check in `tests/render.spec.ts`, that `renderIncrement` and `renderRequest` agree. Omitting it once left the protocol reaching the model on no path at all from the second turn onward.

#### KV Cache effect

Independent: the web route exposes no KV cache, and this package takes no part in dsh-side prefix reuse. Resending the preamble every turn does not affect the site's reuse of its existing conversation context, because it arrives as the new turn's user input appended at the end.

### Conversation history: body and tool catalog

#### What the model sees

An opening turn carries the system prompt, the tool catalog (each tool's name, description, and argument JSON Schema), and the whole transcript in `### [n] 用户/助手/系统` sections; a follow-up carries only the non-assistant messages added since the last send (new user questions and tool results). Historical tool calls render as `【已执行 <id> · <tool>】` plus one line of arguments and **not** in the protocol format: replaying them in it once served to demonstrate the correct syntax, but the model was measured copying them wholesale (our generated id included), and a recognized restatement redoes the same edit twice; the demonstration is now carried by the preamble that is present every turn. Image blocks render as placeholders; this route does not support image input.

#### Token effect

Conditional: beyond `inlineLimit` (4000 characters by default) the body transfers as a `.md` attachment, otherwise it joins the composer text; the content is the same either way. A follow-up sends only the increment, so a multi-step task does not resend earlier steps' tool output. The site reports a running conversation token total, and the difference across the turn is the real cost; the total is taken as reported and the input/output split is proportional to a 4-characters-per-token estimate.

#### KV Cache effect

Dependent on the conversation context the site retains, not on a dsh-side prefix cache: a follow-up sends only the increment, which is equivalent to reusing the conversation the site already holds. Any one of these abandons the conversation and starts over, invalidating that reuse entirely — a changed dsh session id, a changed system prompt, a changed tool set, sent message ids that are no longer an exact prefix of the new history (compaction rewriting it counts), and a turn that failed after its prompt entered the conversation.

## Known Limitations and Deferred Work

- **The Windows launcher has never run on Windows.** `launchWindow.cmd` / `launch.ps1` mirror the macOS logic but have not been executed there; `launchMac.command` and `install-profile.mjs` are verified end to end.
- **Rate limiting is unmeasured.** The web product is built for a human, and there is no data on whether an agent task resending a full context over dozens of turns trips rate limiting or a captcha. This is the largest unknown in the approach.
- **One conversation, serialized, and concurrent agents degrade.** Requests queue in arrival order (`createGate`). The main conversation now binds its own tab, so auxiliary requests no longer interrupt it; but two concurrent agent sessions (concurrent subagents) still share one `conversation` field, the later one displaces the earlier, and both degrade to a fresh conversation every turn — slow, but never crossed. Real concurrency needs a tab pool; conversations are URL-addressable (`/a/chat/s/<uuid>`, and navigating back resumes the history), so the path is paved and simply not taken.
- **Attachment state depends on the notice sitting in the composer.** `snapshot()` matches failure and busy notices within `composerBox()` (the input plus six ancestors) only, because matching the whole page reads conversation content as state. If the site moves those notices out of that scope, a real failure degrades into the two-minute timeout, whose message carries `failedElsewhere` as the only clue.
- **A reworded refusal is only caught by its own wording.** `blockedHints` carries the phrases seen in production; a refusal the site words differently is not classified as `page-blocked`, so the turn fails as `TRANSPORT` instead of switching channels. The error still quotes the composer verbatim, which is what makes the missing phrase visible — and adding it to `blockedHints` is a config edit, not a code change.
- **The format protocol is advice.** The site's own system prompt outranks what the composer says, so the call syntax rests on the parser. A parse failure is logged to `ctx.logger` at `warn` (ordinary diagnostics like conversation reuse stay at `info`, which is what makes the rate filterable) — and that rate is this route's only health signal, because one failure gets the turn counted as finished.
- **The SSE shape is the site's private arrangement.** A change to a field name, to path semantics, or to `Network.streamResourceContent` (an experimental CDP command) breaks this path. Failure is explicit (an unknown path is not projected, a failed stream throws `TRANSPORT`) rather than quietly producing wrong text.
- **The token split is estimated.** The site reports one running conversation total covering prompt and completion. The total is taken as reported and the input/output split is proportional to character counts.
- **Image input is unsupported.** The attachment slot is taken by the context document, and images render as placeholders.
- **Writing still depends on page structure.** The reply no longer comes from the DOM, but the composer, the send control, and the login/busy checks still live in `page-agent.ts` — all on semantic attributes (`[role=button]`, `aria-label`) rather than obfuscated classes.
- `temperature` / `maxTokens` / `stop` cannot be controlled and are ignored; no `replayState` is provided.
