---
title: XTRM Operator Surface Design System
scope: packages
category: standard
version: 1.0.0
applies_to:
  - "packages/pi-extensions/**"
  - "Specialist event cards"
  - "Native tool (MCP) presentation"
---

# XTRM Operator Surface Design System

**Status:** standard · **Applies to:** anything the operator reads in a terminal.

This is a **convention**, not a component kit. It ships tokens and rules; you build
the surface yourself, styled from the tokens. Never hardcode a hex value that a token
below already names.

Inspired by `~/dev/design-system` (Mercury brand kit), which governs brand and web
surfaces. This one governs what a Pi extension, a Specialist card or an MCP tool *looks
and says* in the terminal. Where the two disagree about palette, **this document wins
for terminal output**.

## The styling idiom

**Raw SGR escapes behind named helpers, never inline escapes at a call site.** Pi's
footer seam hands a renderer a `width` and nothing else — no `theme` object reaches it
— and wake-card styling is embedded in literal message content that is serialised as a
string and never passes through a themed renderer. Raw SGR is the only mechanism that
survives both. The cost is that the helpers must live in one place and be imported, never
re-invented per file.

```ts
// packages/pi-extensions/extensions/substrate-suggest/catalog.ts
const GOLD_ON = "\x1b[48;2;201;162;39m\x1b[38;2;24;20;16m";
const GOLD_OFF = "\x1b[49m\x1b[39m";
```

The Specialists repo (`@jaggerxtrm/specialists`) cannot import from `packages/`, so it
carries a byte-identical copy of these constants with a comment pointing here. **If a
token changes, both copies change in the same commit.**

## Tokens

| Role | Value | Notes |
|---|---|---|
| Signal band | bg `#C9A227`, fg `#181410` | the only background on a card |
| Dot | `●` (`\x1b[1m●\x1b[22m`) | white, **never** inside the band |
| Severity glyph | `!` in `#33` | replaces the dot on `high` |
| Header text | dark bold, spanning the whole band | |
| Header separator | `·` dim (`\x1b[2m·\x1b[1m`) | never white — white fights the gold |
| Body | italic (`\x1b[3m`) on normal background | never banded |
| Facts | dim | labelled, always |
| Accent | `#9A8BFF` | footer chrome, thinking level, live spinner only |
| Section chip | bg `#D0D0D6`, fg `#16161A` | footer `SPECIALISTS` label |
| Semantic text | `#4FB88A` / `#D9A441` / `#D9534F` | success / warning / failure |

**Colour proportion.** A card is roughly 90% normal background and ink, a few percent dim
facts, and at most 5% gold — and the gold is **only** the header band. A second background
on the same card is a defect, not a style.

## Rules that make a surface read as ours

- **One band, on the header text only.** The dot keeps its own unbanded row; the band
  starts at the first character of the header and ends at its last. Nothing below the
  header carries a background.
- **Bold spans the whole header.** Every segment inside the band is bold. Subordinate
  segments are bold **and** dim; they never drop to flat dim.
- **Body is italic, unbanded, and not padded to a uniform width.** There is no box to
  justify.
- **Colour is never the only signal.** Severity is glyph *and* wording; facts carry their
  real name (`jev_confidence: 0.61`, `rev 7`), never a bare number.
- **One card per boundary.** At most one suggestion per turn. Cooldowns are per scope and
  per verb, not global.
- **A card is advisory.** It never authorizes a claim, closure, delete or any other
  lifecycle operation, and it never triggers a turn (`triggerTurn: false`). Loud is
  allowed; acting on the card's behalf is not.
- **Never mutate the operator's prompt.** Injected doctrine rides a labelled block in a
  custom message; the operator's own sentence is never rewritten, and nothing is appended
  to tool output.
- **Silence must be diagnosable.** Log the gate that closed, not only the fires. A log
  that records successes only cannot distinguish "not due" from "never ran", and the
  difference is the whole investigation.

### The SGR nesting hazard

`\x1b[22m` clears **both** bold and dim, for the rest of the line. So `BOLD(a) DIM(b)`
renders `b` unbolded even though both sit inside a band — the exact bug the first
Specialist header shipped. **Open attributes per segment and close once at the end of the
band.** Never fix this by appending another `\x1b[1m` after each segment; that fights the
clobbering and grows without bound.

```ts
// wrong: everything after the first 22m loses bold
band(`${BOLD(name)}${DIM('·')}${DIM(state)}`)
// right: dim closes with 1m (dim off, bold back on); the band closes bold once
const sub = (t) => `\x1b[2m${t}\x1b[1m`;
bandHeader(`\x1b[1m${name} ${sub('·')} ${sub(state)}\x1b[22m`);
```

Facts built by a helper (`costFacts`) bring their own escapes; strip and re-apply them
through the same helper rather than trusting them to compose.

## Voice

Terse, specific, imperative. The card is a colleague leaning in, not a notification.

- Instruction first: `Renew the claim`, `Read the history before you edit`.
- The command, verbatim and copyable: `Run: sb claim renew CORE-1234.`
- A disclaimer that earns its line: `Ignore this if it does not fit what actually happened.`
- Label what the number is: `jev_confidence`, never a bare `0.61`.
- Never: "AI-powered", "revolutionary", "smart", "seamless", emoji, exclamation marks in prose.

## Injected context contract

Anything injected into a session carries provenance, so injected doctrine and the
operator's words never blur:

```xml
<xtrm_context kind="skill-doctrine" source="engineering-quality/causal-debugging"
              about="the current request" by="jev-1.13-free" confidence="0.61">
Injected context, not the operator's words:
<pointer, not an excerpt>. Its instructions: read <path> and apply what fits.
<the reader-facing description, in italics>
</xtrm_context>
```

- `kind` — what sort of thing this is; `source` — what produced it; `about` — what it
  concerns; `by` — the deciding model; `confidence` — its own number.
- **Pointer, not an excerpt.** Inject identity, description and path; the agent reads the
  file. Long inline doctrine is a context tax for no gain.
- Renderers parse the block and draw a card. The reader-facing summary is the **italic
  description line**, never the first body line (which is written for the model).

## Native tools and MCP

- **Narrow tools, one pipeline each.** A tool runs one underlying retrieval or action; the
  client agent composes them. Never one `ask()` monolith. Names are namespaced
  (`memory_search`, `gitnexus_impact`).
- **Deterministic per call, LLM-free inside.** Ranking, filtering and paging belong in the
  tool, not in a prompt inside it.
- **Two canonical MCP sources**, because Claude and Pi differ: `.xtrm/config/claude.mcp.json`
  and `.xtrm/config/pi.mcp.json`. Both sync **additively**; user entries win on conflict.
  Secrets never enter repository config — OAuth or an env reference only.
- **Tool results are evidence.** A tool returns facts and identifiers; presentation is the
  renderer's job, never the tool's.
- **Wrap, do not reimplement, across surfaces.** The same tool exposed on two runtimes
  delegates to one implementation. Where the schema dialects differ, mirror the shape and
  pin it with a parity test rather than trusting a copy by eye.

## Native extensions

- Enrolment is `src/manifest.json`; retired entries get a tombstone in
  `src/manifest.json.disabled` so an old copy cannot silently return.
- **Fail open.** A renderer, classifier or projection that throws must never break a
  session: wrap the handler body, swallow, return `undefined`.
- Pi loads the TypeScript entrypoints directly — no build step for the payload.
- **One owner per chrome surface.** `custom-footer` is the sole statusline owner, `xtrm-ui`
  owns Pi chrome, suggesters do not restyle tools.
- **Fences must not trap the coordinator.** A workspace write fence refuses writers; it
  never refuses the control plane that manages them, and it never refuses a tool that
  cannot write. A coordinator that cannot edit its own repository is not a fence — it is a
  deadlock with a timeout.

## Where the truth lives

| Thing | Path |
|---|---|
| Card chrome, tokens, context blocks | `packages/pi-extensions/extensions/substrate-suggest/catalog.ts` |
| Specialist cards (copy of the tokens) | `@jaggerxtrm/specialists/config/pi-extensions/native-specialists/index.mjs` |
| Footer chips, accent | `packages/pi-extensions/extensions/xtrm-ui`, `custom-footer` |
| Extension enrolment | `packages/pi-extensions/src/manifest.json` |
| MCP canonical config | `.xtrm/config/{claude,pi}.mcp.json`, documented in `docs/mcp-servers.md` |

## Before you call it done

- [ ] Rendered sample checked in a real terminal, not only in a test.
- [ ] Gold appears on the header line and on **no other** line.
- [ ] Bold spans the full header; the only `\x1b[22m` inside the band is the one that
      closes it.
- [ ] Body italic, unbanded, no trailing padding.
- [ ] A test asserts gold-on-line-one and no-gold-below — a renderer that throws falls
      back to raw content, and only a test catches the regression.
- [ ] Every fact is labelled; every command is copyable.
- [ ] Nothing the operator typed has been altered.
- [ ] Silence is explainable: the failure path logs why it did not speak.