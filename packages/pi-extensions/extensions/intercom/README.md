# intercom extension

Pi-side intercom: the model-only `ListAgents` and `SendMessage` tools, the
`/intercom` roster overlay and `/rename`, the waiting-only footer chip, and
the Claude transport adapter. Sending is plain text plus optional
attachments; the card renderer is a later slice, not here.

## Mailbox (durable, bounded, in memory)

Undelivered wakes persist in the agent host registry, keyed by message id:

- A receiver restart — graceful (`session_shutdown`) or a dropped
  connection — parks queued and held wakes as `held`. They flush to the
  next session with that name or id, exactly once per restart (send count
  marks redelivery; ids deduplicate).
- A queued or held wake past its TTL reads as `expired`, and the sender
  gets one expired notice. Notices carry no sender session, so their own
  expiry stays silent. An unref'd sweep (every 30 s) fires expiry on an
  idle host, so the notice arrives within a bounded time.
- Only a host shutdown reports pending wakes as `undelivered`.
- What survives: receiver restart, yes. Host restart, no — the mailbox is
  in memory by design.

Bounds (never silent eviction):

- 5 min wake TTL (`DEFAULT_WAKE_TTL_MS`).
- 1024 retained wake records (`MAX_WAKE_RECORDS`); settled evict first.
- 64 live wakes per receiver (`MAX_LIVE_WAKES_PER_RECEIVER`); the 65th
  arrival evicts the oldest live one for that receiver and the evicted
  sender gets an undelivered notice naming the full mailbox.

## Attachments (`SendMessage attachments`)

Shapes follow pi-intercom (`---` / `Attachment:` rendering); the fence is a
backtick run one longer than any run in the content. Bounds: at most 8 per
message, 256 KiB per file (1 MiB refused outright), 32 KiB inline,
512 KiB total payload. Files resolve inside the sender's worktree in
lstat/realpath, containment, regular-file, bounded-read order; symlinks
that escape are refused. Refused unread: `.env*`, `.envrc`, `.npmrc`,
`.netrc`, `.pypirc`, `.git-credentials`, `*.pem`, `*.key`, `*.p12`,
`*.pfx`, `id_*`, `service-account*.json`, anything under `.ssh/`,
`.gnupg/` or `.secrets/`, names containing `credential`, `secret` or
`token`, and binary content (a NUL in the first 8 KiB). Oversized content
truncates with an explicit note. The rendered block rides the payload, so
Pi and Claude transports carry the same text; the receiver sees it inside
the envelope with the provenance line.

## Scoped routing (`SendMessage scope`)

`project` narrows to the sender's Substrate project (issue-ref prefix);
`programme` narrows to the sender's repository (else the checkout root).
Both derive from live registry data. Peers without matching identity never
match a scope; a sender without the key fails loudly instead of guessing.
