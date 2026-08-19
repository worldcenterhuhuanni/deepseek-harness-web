# Agent Note: The web bridge tracks the page as a channel, separately from the conversation baseline

Status: implemented

English | [中文](2026-08-19-deepseek-web-blocked-page-channel.zh.md)

## Problem

A `deepseek-web` run stopped mid-task and every later turn failed identically:

```
turn/end reason=error  无法发送消息：点击与回车都没有让输入框清空，页面可能已改版。 TRANSPORT
```

Turn 9 completed eleven steps normally (`read`, `edit`, `bash` all executed) and died on the twelfth. The live page told the real story: eight `context.md` cards, ~244KB each, piled into one composer, under the site's own notice — `请删除异常文件再发送`. One of those cards showed `服务器繁忙`: an upload that had hit the site mid-failure. From the moment it appeared, the site kept the send key disabled.

Nine send attempts are in the log (three turns × one initial plus two retries). The first failed in 324ms with `EMPTY_RESPONSE`, too fast to have mounted anything; the other eight each reached `attach()` and each left one more card behind. The count matches the page exactly.

Three defects compounded:

- **The hint table did not know the notice.** `FAIL_HINT` covered `解析失败|未能发送|发送失败`, not this refusal, so `attach()` reported the mount ready.
- **`waitSendable()`'s return value was discarded.** A permanently disabled send key was clicked anyway, all three submit methods then failed, and the error read `页面可能已改版` — a sentence containing nothing from the page.
- **`TRANSPORT` conflated a persistent failure with a transient one.** It sits in `retryableCodes`, so `dsh-llm-retry` faithfully resent the turn — onto the same dead page, mounting one more 244KB attachment each time.

## Decision

Failure bookkeeping carries two independent dimensions.

`conversation` already answered "does the content baseline still hold", tested by the `submitted` milestone. What was missing is "does the page carrying it still work". The two are genuinely independent: the site leaves a broken attachment card in the composer and disables sending while the conversation content has not changed by one character. `channelBlocked` records the second, `resumeBlocker` consumes it ahead of the content test, and the next turn therefore opens a fresh conversation with the full history — through the paths that already existed for a new conversation.

The `page-blocked` bridge kind maps to a new `PAGE_BLOCKED` code, appended to the configured `retryableCodes` by `providerRetryPolicy()` exactly as `UNPARSABLE_TOOL_CALL` already was. So the recovery runs inside the turn: refusal → retryable failure → the retry finds the channel marked unusable → new conversation → the task continues.

Both the verdict and the message now come from the page. `sendFailureFrom()` is a pure function of a `PageSnapshot`: a hit in the refusal table reports the site's wording as `page-blocked`, and no hit quotes the composer verbatim (`hint`). Waiting for the send key fails the same way instead of clicking a disabled control three times.

Every hint table and every timeout on this path is now a `Config` field with its default in one place (`DEFAULT_PAGE_HINTS`, `DEFAULT_*_TIMEOUT_MS`). One reworded notice was enough to blind a hardcoded table; a config edit now takes effect on the next read.

## Alternatives considered

**Change the loop instead.** `agent/request-error` could have grown an action meaning "reset the provider, then resend". It lost because the contract does not need it: the promise is to decide whether a failure is worth resending, the request content does not change, and which channel the provider uses to satisfy it is a provider detail. The gap was in the provider's state machine, so this would have changed the wrong layer — and the repository rule is plugins, not loop changes.

**Clear the leftover attachment cards.** Deleting the residue would have let the same page keep going. It lost on fragility: the site only reveals the delete control on hover, which is the most brittle selector available, and a new conversation makes the residue irrelevant for free. Nothing clears attachments today, and nothing needs to — a successful send has the site clear them, and only a failed one leaves residue behind.

**Keep the hint tables in the injected script and just add the missing phrase.** The one-line fix would have closed this instance. It lost because the failure mode repeats: the table is site UI wording, so the next rewording blinds it again, and only a plugin release can fix that. Config fields put the correction in the user's hands.

## Consequences

Recovery now happens inside the turn, so a refusal costs one retry instead of ending the task. The cost is that the recovered turn resends the full history as an attachment rather than an increment — unavoidable, since a new conversation has no memory of the earlier turns.

`page-blocked` is only as good as its wording. A refusal the site words differently still fails as `TRANSPORT`, but the message now quotes the composer verbatim, which is what makes the missing phrase visible; adding it is a config edit. This is recorded as a known limitation in the package README.

Unit tests pin each part: the channel dimension through the existing `continuesAfter` harness, the self-explaining failure through `sendFailureFrom`, and an empty hint table (whose `new RegExp('')` would otherwise match everything). No keyless snapshot covers any of it — the path needs a real browser and a logged-in session, which the replay harness cannot provide. For the same reason this package is exempt from the per-file 100% coverage gate: its driving layer (`cdp.ts`, `launch.ts`, `session.ts`) only executes against a real Chrome.

The injected script was verified against the real site as well, since jsdom passing does not imply a real page passes: with `PAGE_AGENT` loaded from the built `lib/`, a clean page misjudges nothing, the site's refusal inserted into the real composer is recognized, and removing it returns the verdict to empty. That run is what caught `hitLine` folding the mode-switch menu text into the message — real `innerText` carries newlines, so the matching line alone is the sentence the site wrote.
