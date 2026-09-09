# Changelog

All notable changes to Claude Code skills and configuration will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.12.0] - 2026-09-04

### Added
- Single-line render for pi footer and claude hook ([1e6c2f5](https://github.com/xtrm-dev/core/commit/1e6c2f57e690b2b87af63334906b128416d0705e))
- Native-style external tool rows + #9a8bff model accent ([1fd5889](https://github.com/xtrm-dev/core/commit/1fd58895c737147449659d41898662ac608ad70f))
- Launcher-owned --name from worktree slug + drop auto-session-name (xtrm-rhmm1) ([7f5874c](https://github.com/xtrm-dev/core/commit/7f5874c17608a5d1e61036afeac14951e3c48cac))
- Resolve bare skill names from v2 project packs + claude loadability (xtrm-lk07w.14) ([ef14bf4](https://github.com/xtrm-dev/core/commit/ef14bf44030ee6cd02d4dd21f0856f067baf54f3))
- Skillbridge — mount python-backed skills as importable kernel modules (xtrm-h7uwi.1) ([48cd3ae](https://github.com/xtrm-dev/core/commit/48cd3ae3961f9116618edbd894628736cd7ac7ae))
- Python-kernel QoL — stdlib prelude + output truncation with shape hint (xtrm-h7uwi.2) ([8aa5b17](https://github.com/xtrm-dev/core/commit/8aa5b1751e51b9881bce3716c4b2011c3b51e268))
- Python-kernel audit seam — kernel mutation events visible to host (xtrm-h7uwi.3) ([cf7da84](https://github.com/xtrm-dev/core/commit/cf7da847ca9a2b84883501d6ce89ce14e35aee78))

### Fixed
- Retry external tool frame patch on session_start ([18bc72f](https://github.com/xtrm-dev/core/commit/18bc72f6c69aff19f556f7efe8e327f7c9c45616))
- Replace prototype patches without wrapper stacking ([5312a04](https://github.com/xtrm-dev/core/commit/5312a04769b54512d6d577763cbc93596b71a88e))
- Patch active bundled pi runtime classes (#604) ([296be42](https://github.com/xtrm-dev/core/commit/296be42923d76f2eb6dced60390bb37e4b7c3874))
- Prevent destructive global cleanup ([b869756](https://github.com/xtrm-dev/core/commit/b8697569b8711a0a716605f27a1a81fa67ebabf0))

### Project maintenance
- Reconcile Core residual architecture pointers (#596) ([3b04202](https://github.com/xtrm-dev/core/commit/3b04202289627334266b9100236ae2a2a9cd45d4))
- Update parity test to single-line statusline contract ([0850349](https://github.com/xtrm-dev/core/commit/0850349c7a28b23b4cf5781a18300349b6980693))
- Remove 5 retired extensions cleanly (xtrm-lqfjq) ([aead627](https://github.com/xtrm-dev/core/commit/aead627fdf790d3a9c48e041d5b3432ac9a01c56))
- Rebuild cli/dist after registry fix (xtrm-lqfjq) ([5d7d3a4](https://github.com/xtrm-dev/core/commit/5d7d3a43ac115a2c66c3a9b6110cc94a153cb2d4))
- Seed retirement ownership proof ([28aed2d](https://github.com/xtrm-dev/core/commit/28aed2d99b693d0598c75ee9c1d937a19e87d3be))
- Refresh README to 0.11.6 user-facing surface ([12ee408](https://github.com/xtrm-dev/core/commit/12ee408ccd994835882b1f1d490be82f676ecedc))

## [0.11.6] - 2026-08-20

### Fixed
- Replace hardcoded pi path with PATH lookup ([cc98590](https://github.com/xtrm-dev/core/commit/cc98590b3c4c319a1882782fa5a310f8a063d7e9))

## [0.11.5] - 2026-08-20

Broad reliability sweep on the launch model plus a Pi extension polish pass. Structured launch outcomes are now schema-validated, refuse invalid slugs before spawning, preflight the codex/claude/pi paths, and degrade cleanly on incomplete persistence — the code path every session starts through. Pi extension gets a rendering refresh: phase-colored tool prefixes (dim command when success), preserved tree indentation on wrapped tool lines, flat rows for external tools, char counts on collapsed thinking rows, and accented bash command-names + light-magenta separators for readable multi-command lines. Also new: `xt worktree reap` for reclaiming abandoned worktrees, an experimental Codex runtime with K4 distribution parity, a dedicated `read-line-numbers` Pi extension that owns model-facing line numbering, a Python kernel + global prompt doctrine subsystem (`xtrm-3ljgz`), a `board-audit` hook feature (bd exporter + PR-checkpoint adapter), and the `sp log` monitor-recipe corrections in the `using-specialists` skill that fix silent-fail monitors on keep-alive specialists (via specialists v3.21.5 re-vendor).

### Added
- Add deterministic launch outcomes ([cfa1dce](https://github.com/xtrm-dev/core/commit/cfa1dce95f691ee11c43e8175fa92fc5d1c4f1cd))
- Add experimental codex runtime ([2b6322f](https://github.com/xtrm-dev/core/commit/2b6322fa238a55710e57d75edb3a600689ab8c32))
- Complete K4 Codex distribution parity ([2c49238](https://github.com/xtrm-dev/core/commit/2c492385952f6b4aa12af801b777de2074c853de))
- Xt worktree reap — reclaim abandoned worktrees safely (xtrm-oentn) ([4b9a85b](https://github.com/xtrm-dev/core/commit/4b9a85bf040be3c5b28e6c954b565ba7561d7042))
- Preserve tree indentation when tool lines wrap ([40d7dc9](https://github.com/xtrm-dev/core/commit/40d7dc9c26904bd3639960510a8308e0cee55edb))
- Phase-color only the tool prefix, dim command unless success ([2a8aeaf](https://github.com/xtrm-dev/core/commit/2a8aeafe87dab94fa075d7c76bc1bbf3a89a65a2))
- External tool rows in parity — kind color label, phase bg, no brackets (xtrm-lipn5) ([888f431](https://github.com/xtrm-dev/core/commit/888f43113d1d40e74de0a246ea1a05cf2171261f))
- Flat tool rows — drop tree indent from tool output, keep └ corner (xtrm-sqzv6) ([409bf45](https://github.com/xtrm-dev/core/commit/409bf45e883f533e8bc5fc4fca9effb6aa126dbb))
- Raw char count on collapsed thinking row (xtrm-ib5lm) ([c2f4fce](https://github.com/xtrm-dev/core/commit/c2f4fcea5ca23c01eca425dd27c80e16cc51ebd6))
- Paint bash command separators light magenta (xtrm-2bgmu) ([af55f8f](https://github.com/xtrm-dev/core/commit/af55f8f8a0ea07bf534967f9581c579457823678))
- Accent the command name of each bash segment (xtrm-50gq5) ([a6fd9c6](https://github.com/xtrm-dev/core/commit/a6fd9c6c1f8d1256f4c41b870f89085e68a69e4c))
- Read-line-numbers extension (owner of model-facing numbering) ([09137ea](https://github.com/xtrm-dev/core/commit/09137eae4297b8bd04736fb7861ff9bc3e657dc9))
- Manage Python kernel and global prompt doctrine (xtrm-3ljgz) ([df07bca](https://github.com/xtrm-dev/core/commit/df07bcae1304b3f9a20b47d9f0c496910a9a46b9))
- Board-audit — bd board/work-package exporter + PR-checkpoint hook adapter (xtrm-7yj7h) (#592) ([487e607](https://github.com/xtrm-dev/core/commit/487e6074e3aaacad3ca2b0250d2c6f6689f276d7))

### Fixed
- Select context-aware tmux attach action ([29994bd](https://github.com/xtrm-dev/core/commit/29994bdafb5d8193cb271d23abffec9869771d22))
- Keep launch outcomes schema-valid ([be29d8b](https://github.com/xtrm-dev/core/commit/be29d8b78305e9cbe36e4f19bea025cd87e81fc4))
- Reject invalid outcome slugs before launch ([a3e48fa](https://github.com/xtrm-dev/core/commit/a3e48fa6fbd047ac3fc58864147b57e689d2acd5))
- Preflight structured launch paths ([e63e4bb](https://github.com/xtrm-dev/core/commit/e63e4bba31822f064c2c37b59c8c24c589c34d77))
- Close remaining structured launch preflights ([8555928](https://github.com/xtrm-dev/core/commit/855592804fd384889786f4c2a6087dc31a204d6a))
- Omit unavailable resume action ([cf8aee1](https://github.com/xtrm-dev/core/commit/cf8aee14075b106231e8d699231d2b55f542347c))
- Bind structured launch to one executable ([cc5675c](https://github.com/xtrm-dev/core/commit/cc5675c3cfaa49fb6f786de4038169babf252a1d))
- Require live detached session identity ([7437fba](https://github.com/xtrm-dev/core/commit/7437fba1c7a262252337950a5e39123f8d312982))
- Prefer exact attach branch selector ([de6fd3b](https://github.com/xtrm-dev/core/commit/de6fd3b709c41054912f7a93265d4880ffb938bd))
- Canonicalize structured launch selectors ([ec0e1c2](https://github.com/xtrm-dev/core/commit/ec0e1c23dfe14f010c91d2aaee5f36837b2ef964))
- Degrade incomplete launch persistence ([7333c69](https://github.com/xtrm-dev/core/commit/7333c69341cda82f5d5328c16b30a1a502068e04))
- Probe runtime version from worktree cwd ([1ed512a](https://github.com/xtrm-dev/core/commit/1ed512a49efaf75f3e84c128f9d82958ece09d3a))
- Persist codex worktree trust profile ([9b59fa5](https://github.com/xtrm-dev/core/commit/9b59fa5a7eed86b68f18f929ea3d37b072ae0891))
- Avoid duplicate Codex default skills ([d65aac6](https://github.com/xtrm-dev/core/commit/d65aac6e757d8f0b07415a8d719610156bddb640))
- Re-check liveness at apply time, not only at plan time ([3646c10](https://github.com/xtrm-dev/core/commit/3646c1054e1a65f38d6acaeedafd909dffc2e11e))
- Eliminate O(n²) tool-row wrap path causing render lag ([d1cc26d](https://github.com/xtrm-dev/core/commit/d1cc26d900414bb1a56c2723dc5910d001ecdcdf))
- Degrade instead of destroying a live session with no thread id (#549) ([884a7ef](https://github.com/xtrm-dev/core/commit/884a7efc800fd78e60eee1073894fd71872c1bb1))
- Remove tool-row wrap feature causing render lag (xtrm-ql4xs) ([37d62ad](https://github.com/xtrm-dev/core/commit/37d62adb554a62460b6f3452ba950949eaac615d))
- Theme.bg must be called through the theme proxy (xtrm-lipn5) ([d8d86c1](https://github.com/xtrm-dev/core/commit/d8d86c18c3e39796b2499ae3b7f5d116ec9a0393))
- Thinking chrome — bold via raw SGR, recap + one-line fit (other agent's work, moved off shared branch) ([390e31c](https://github.com/xtrm-dev/core/commit/390e31c4feb37b214c6b8b5d62be537a7f6853f9))
- Pad external tool rows to full width before phase bg (xtrm-6rnpj) ([e609bc4](https://github.com/xtrm-dev/core/commit/e609bc4e8b72547539b7c073458dbe0ba35e99ad))
- Restore exact pre-change badge chip on external tool names (xtrm-ma1je) ([8a9b29d](https://github.com/xtrm-dev/core/commit/8a9b29d92fc8b08183d8df397db72288023d86ca))
- Pad external tool chip with colored space on each side (xtrm-ma1je) ([1478ab0](https://github.com/xtrm-dev/core/commit/1478ab0d153d57e3a6946bfe70b834dcda054360))
- Restore blank line after thinking row before agent response (xtrm-2z1t0) ([b1cb161](https://github.com/xtrm-dev/core/commit/b1cb161990cb6c02556205a2231517a94ca89e15))
- Restore thinking-row visibility; blank line via invisible spacer block (xtrm-2z1t0) ([01a0f8d](https://github.com/xtrm-dev/core/commit/01a0f8de03a1b32292cde853a0d3747aed74eb82))
- Match desired flat row shape — └ on first output line, bold command, flush meta (xtrm-sqzv6) ([b5812da](https://github.com/xtrm-dev/core/commit/b5812da5b0271ebf0e34a0acab7865d3b7375b33))
- Separator coloring — exclude bare & (xtrm-3s2bd) ([24b1dc9](https://github.com/xtrm-dev/core/commit/24b1dc9d27cb11c69c7af8362c6ba51a6e74aa9c))
- Color separators only when whitespace-adjacent (xtrm-s8d5d) ([ed639fc](https://github.com/xtrm-dev/core/commit/ed639fc76856a5ec0ee6866de86bbb2d4dc209a2))
- Thinking row never rendered — remove dead hiddenThinkingLabel gate (xtrm-d4wfh) ([e36abcd](https://github.com/xtrm-dev/core/commit/e36abcda974b93774d092d6f8a87e57e1b021573))
- Honor Pi package dry-run semantics (xtrm-zruao) ([32ee794](https://github.com/xtrm-dev/core/commit/32ee794acf41331e1f310191f7cfec7bbb4db394))
- Safely adopt legacy runtime skill roots (xtrm-2d6fw) ([7b79f92](https://github.com/xtrm-dev/core/commit/7b79f922c5b7383ed835dd18edb6260d77190074))
- Validate restore archives before extraction (xtrm-zc1rs) ([fc92ffa](https://github.com/xtrm-dev/core/commit/fc92ffa5ac27595501fc2031f3c51ecfa83ef4de))
- Number REAL blank source lines (xtrm-oi5sg) (#576) ([a1ccb6f](https://github.com/xtrm-dev/core/commit/a1ccb6f36060192ab8c1fcf7c75a6a99badb4d4b))
- Close 4 OSV advisories via override bumps (fast-uri, nanoid, postcss) (#577) ([96d5f37](https://github.com/xtrm-dev/core/commit/96d5f3711ac01c022e812677b2addd31709e20dc))
- Correct read-line-numbers to Pi split('\n') EOF model + image text-note passthrough (xtrm-4enz5) (#579) ([837baca](https://github.com/xtrm-dev/core/commit/837baca87b2c6e63757c9ae42d1ad177cfec392e))
- Reset thinking follow-toggle latch per session (xtrm-6ggil) ([eefbdd0](https://github.com/xtrm-dev/core/commit/eefbdd0f72510d49948419931c53844d7ab03b7a))
- Re-render existing thinking rows on Ctrl+T toggle (xtrm-5vi8u) (#581) ([8a47ddd](https://github.com/xtrm-dev/core/commit/8a47ddd3395f4d5039237655f3a910c36568a647))
- Pre-push chain must exit 0 on success [exit-status-bug] ([d6ca062](https://github.com/xtrm-dev/core/commit/d6ca06275fdca88f6dfe89b00656097851e325be))
- Resolve xtrm-ui hidden-thinking empty-row on session start (xtrm-3tus9) (#583) ([c4a168c](https://github.com/xtrm-dev/core/commit/c4a168c61a0b99195dc4255676d1d0af706975a9))

### Other changes
- Add capacity-reclaim, third devops-sre materialization (xtrm-gvek4) ([a36e9d9](https://github.com/xtrm-dev/core/commit/a36e9d94b92ba73e856a725fa830defa5d8fd433))
- Drop divisor + command-name coloring — plain command (xtrm-oj0ll) ([e21e717](https://github.com/xtrm-dev/core/commit/e21e717bfcb719f3b7a18e8c57d94b6ea0aca622))
- Sync Beads/Dolt via GitHub origin on push/merge (refs/dolt/data) (#569) ([7a41bb1](https://github.com/xtrm-dev/core/commit/7a41bb114eac0844dc29e98cd46a1e65760278e7))

### Project maintenance
- Characterize runtime boundary (xtrm-ozknq.5) ([70afff9](https://github.com/xtrm-dev/core/commit/70afff9b26184ed73ddfb2147d362a7c249f5f9d))
- Redact fixture provenance (xtrm-ozknq.5) ([f14e14e](https://github.com/xtrm-dev/core/commit/f14e14e697b9f446e660101af68e790a4ceac5ae))
- Harden fixture path hygiene (xtrm-ozknq.5) ([29f7354](https://github.com/xtrm-dev/core/commit/29f735419c9090141ed782787da61042a783661f))
- K1 characterization + version-pinned Codex 0.146.0 fixtures (xtrm-ozknq.5) ([d53edc5](https://github.com/xtrm-dev/core/commit/d53edc502ef5641d37d39db7c13acc91a74e00e2))
- Reconcile K1 lifecycle fixtures ([a992532](https://github.com/xtrm-dev/core/commit/a992532cbc20e90240810d94b29653d2c47cf084))
- Sync attach selector bundle ([ed792fd](https://github.com/xtrm-dev/core/commit/ed792fd0bccd2638c163fb72fdbdfe9451032683))
- Refresh Specialists-owned assets to K4 master (xtrm-ozknq.15) (#542) ([dd93751](https://github.com/xtrm-dev/core/commit/dd937514c4b34adc8bba59d4ed6b324c62e05716))
- Add committed-artifact case to the deploy-gap guard (xtrm-7tjik) ([d812d6a](https://github.com/xtrm-dev/core/commit/d812d6a5b5bb6c5d4608e7eae7bb4db1be9ba991))
- Hide niche skills from model invocation, restore starting-and-resuming-work ([f9ffed2](https://github.com/xtrm-dev/core/commit/f9ffed22cf59715f5eec0a10ecfb6b0086fb647b))
- Refresh GitNexus injected block in AGENTS.md and CLAUDE.md ([2ddbd9d](https://github.com/xtrm-dev/core/commit/2ddbd9d2286dc5ebba7fadaaea3afd570178b7ca))
- Archive completed pi-extensions-migration plan ([f8b4e8b](https://github.com/xtrm-dev/core/commit/f8b4e8b56cedfabece7abc8a7ad21876f8fff0d9))
- Reconcile skills registry and specialists manifest ([812dde9](https://github.com/xtrm-dev/core/commit/812dde9aeee4dc0f9b64bdfa744dce46faae5ce5))
- Re-pin specialists to upstream disable-model-invocation patch ([f056567](https://github.com/xtrm-dev/core/commit/f05656753cee4eb78f6d8505282bc8f2de5d7b02))
- --notes REPLACES notes, document --append-notes (#551) ([a1287e9](https://github.com/xtrm-dev/core/commit/a1287e9d546001fae0a1350d63b31a1652c63a09))
- Re-pin K1 fixtures at 0.147.0 and prove the contract held (#554) ([b8a4818](https://github.com/xtrm-dev/core/commit/b8a481819204964cca785a5e5384fdf568f39745))
- Make prompt sync checks environment-independent (xtrm-3ljgz) ([852882f](https://github.com/xtrm-dev/core/commit/852882fcd3bba322c7dc3a53712794a576af9014))
- Create the whole board in one bash invocation (#584) ([861d1ba](https://github.com/xtrm-dev/core/commit/861d1ba136bebef5633bb813bdbc3c37a252f339))
- Re-vendor specialists skills at master bcdbd30c (xtrm-hpz9p) (#586) ([c9a0299](https://github.com/xtrm-dev/core/commit/c9a0299c2896e50719e40e7d9a9955cebeea2e34))
- Sync managed hooks to bd v1.2.1 (xtrm-6xbb5) (#587) ([e8af1a7](https://github.com/xtrm-dev/core/commit/e8af1a71adc6fcd74fda1f78761d6979dcefe429))
- Sync sre-triage core mirror to v1.6 SSOT (xtrm-234l4) (#588) ([46944d8](https://github.com/xtrm-dev/core/commit/46944d853daae086fa29d45a876335ca23982943))
- Cross-ref keep-alive monitor recipe (xtrm-lf4ri) (#589) ([925fc48](https://github.com/xtrm-dev/core/commit/925fc48396d0c736ca0fae644796d07ea1b038ca))
- Propose dev/main promoted-only branch model on every bootstrap (xtrm-ofsea) (#591) ([6b2a2c3](https://github.com/xtrm-dev/core/commit/6b2a2c314038471915943264d92c7357c6338563))
- Pin specialists@v3.21.5 (0253e3e4) (#593) ([5efe874](https://github.com/xtrm-dev/core/commit/5efe874529ffb95dbd9299cc912a8175d01589f5))

## [0.11.4] - 2026-07-30

### Added
- Unify native tool rendering (xtrm-cgxqy) (#534) ([5a897c8](https://github.com/xtrm-dev/core/commit/5a897c89e991a4741850abbc3d31d32d496f2104))

## [0.11.3] - 2026-07-28

### Added
- /prd-to-plan skill for spec → runnable bd board ([7e8c105](https://github.com/xtrm-dev/core/commit/7e8c10589b6d93bc32f29c9ce2c2da119cf891a9))
- --no-pr flag + fix stale prs.tsv prompt refs (#496) ([0b5ec71](https://github.com/xtrm-dev/core/commit/0b5ec71d8533a3b74853b95942760813e66baae3))
- --epic <id> scoped export with notes (xtrm-ipf4n) (#498) ([a20d52e](https://github.com/xtrm-dev/core/commit/a20d52e5052b089d1c344330cc1a09e91cc80e7d))
- Assign beaded sessions from runtime origin (#508) ([2fdcef8](https://github.com/xtrm-dev/core/commit/2fdcef84933664a908d06e301b164625afe93fe4))
- Drift-lint gates for forbidden phrases and vendored specialists parity (xtrm-wiy5n.4.3) (#514) ([a89f55d](https://github.com/xtrm-dev/core/commit/a89f55db0b7da94bebd3fa3c10ae78f987157863))
- Alpine smoke-test container for the xtrm trio (xtrm-wiy5n.4.1) (#513) ([335c6e7](https://github.com/xtrm-dev/core/commit/335c6e7bc7f8a0d83d46da5f041f0396ef2b397d))
- Fail build on payload/wiring mismatch (xtrm-wiy5n.4.38) (#523) ([b602bac](https://github.com/xtrm-dev/core/commit/b602bacb7e5320790fc4f4aa07fd0cfa56cf2775))
- Xt version --check-updates + xt doctor updates row (xtrm-wiy5n.4.7) (#524) ([94d03ea](https://github.com/xtrm-dev/core/commit/94d03ea93d09fa9a8f19280a7acf53a60fe2fe44))
- Close the Claude/Pi inbox asymmetry with a Stop reminder hook (#525) ([617a74f](https://github.com/xtrm-dev/core/commit/617a74fe0130811a6da15329907edae8233f2dbb))

### Fixed
- Summary lines double-print epic id (xtrm-5swny) (#499) ([87fc6b8](https://github.com/xtrm-dev/core/commit/87fc6b80b1acae51d431507104e6566071b94e32))
- Remove stale service-skills wiring (#500) ([efa5f11](https://github.com/xtrm-dev/core/commit/efa5f11ab80df85296e3dc86bebcbcbe91db8584))
- Close topology and reuse P1 gaps (#506) ([bee5f42](https://github.com/xtrm-dev/core/commit/bee5f42b53943cd5e36476988e4ccb29a3ae54a9))
- Retire dead Specialists hook payloads (#509) ([75ee080](https://github.com/xtrm-dev/core/commit/75ee080ebedfacc86a55dd6d3af0f75cca9fd05b))
- Assign beads from the runtime readiness handshake (xtrm-wiy5n.4.18) (#510) ([359af43](https://github.com/xtrm-dev/core/commit/359af431f8c90d33044002525039cb39579dc388))
- Stop xt claude --role forwarding non-Claude models (xtrm-wiy5n.4.19) (#511) ([50b1987](https://github.com/xtrm-dev/core/commit/50b19878aad623b4ff9c4dcd81fb3dc21cae30e7))
- Unbreak main — PR-scope the CHANGELOG gate, raise the fast-uri floor (xtrm-wiy5n.4.29) (#516) ([772aed0](https://github.com/xtrm-dev/core/commit/772aed0531c28caed8c1a7b437415b08742377f8))
- Stop committing the generated [Unreleased] block (xtrm-wiy5n.4.28) (#517) ([dd24f66](https://github.com/xtrm-dev/core/commit/dd24f66b441ceec3303dd1a67a24ce40e49b2ade))
- Never delete a file the installer cannot prove it wrote (xtrm-wiy5n.4.37) (#520) ([c915502](https://github.com/xtrm-dev/core/commit/c9155026df405d1996a5765aa10b696f2af9585c))
- Smoke container verifies the global install surface (xtrm-wiy5n.4.32) (#522) ([a85321d](https://github.com/xtrm-dev/core/commit/a85321d7fed515537fc8f6ad0d567e297cbc21a7))
- Scope Policy parity step to a scratch PI_AGENT_DIR (xtrm-spcuo) (#526) ([3ca992c](https://github.com/xtrm-dev/core/commit/3ca992c5fa3f6fc1a4f87ae98309a08d6e8781b9))
- Npm:@jaggerxtrm/pi-extensions is global-only (xtrm-xnymw) (#527) ([1aa3930](https://github.com/xtrm-dev/core/commit/1aa393099732aaf500add2df6a60dca67ecdc0bb))
- Invoke xtmux installer bare, not --from-npm (xtrm-9hq6w) (#529) ([3b9d6e6](https://github.com/xtrm-dev/core/commit/3b9d6e6dc92b13a9978de2d5b92d3b5c217ff7cd))
- Force branch checkout past the generated registry (xtrm-kqf0y) (#530) ([b6b8d94](https://github.com/xtrm-dev/core/commit/b6b8d945d97fdfa4bf977b3def530f90d092d90f))

### Other changes
- Dump CI changelog:check diagnostics (#489) ([428a27b](https://github.com/xtrm-dev/core/commit/428a27bfa1dcf3ae6d2e819db92533823ca0aa58))
- Canonicalize pr-review-gate template + refresh review-skill docs (xtrm-54zwl.2 + .4) ([ccf3a1a](https://github.com/xtrm-dev/core/commit/ccf3a1a9a1d49de400a5a3a0c86d7edf271b6ae6))
- Nudge to use service-knowledge on ambiguous incidents (#503) ([6c0d1fa](https://github.com/xtrm-dev/core/commit/6c0d1fa7907b4a9aeec0a72ad6951ec1ac1fe46f))

### Project maintenance
- Auto-refresh CHANGELOG.md — pre-push hook + PR CI check (xtrm-reyem.12) (#488) ([6e7040d](https://github.com/xtrm-dev/core/commit/6e7040df7ecb9dafd0fc6a732f98e4a9897b3be1))
- Audit-reconcile v0724 program plan + consolidated determinism report ([48f6e7c](https://github.com/xtrm-dev/core/commit/48f6e7c8443eb8b2654ecd9415ce60d5ee6647fc))
- Add pr-review-gate required-status-check workflow (xtrm-54zwl.1) ([6a6c19e](https://github.com/xtrm-dev/core/commit/6a6c19ec230c48590bfa289bff6ba57711c7d510))
- Set explicit job name for readable required-check context ([b12cdd0](https://github.com/xtrm-dev/core/commit/b12cdd0dcf50d8e2ce9d461c365e76bf3af86b36))
- Set explicit job name + drop unsupported pull_request_review_thread trigger ([217048b](https://github.com/xtrm-dev/core/commit/217048b00497a37d4e07aa327ea52d780ffbcb8d))
- Use JS-native regex flag ('i') instead of Perl-style (?i) ([9c0c73d](https://github.com/xtrm-dev/core/commit/9c0c73d75910b2cadf24eaef1ad85a538841ca52))
- Add workflow_dispatch for post-resolve manual refresh ([dc7021f](https://github.com/xtrm-dev/core/commit/dc7021fda3b08e0238e6c08d8717abff2220f994))
- Retire vendored service-skills from core [xtrm-56flm.6] (#493) ([c2c7edc](https://github.com/xtrm-dev/core/commit/c2c7edca6034c98599b06419b0bcc269c4d8f9a3))
- Rename /prd-to-plan → /spec-dispatch (#494) ([fa6e2be](https://github.com/xtrm-dev/core/commit/fa6e2be25fa6fa8e7f76bbe9016fd3fc1c0ce7f3))
- Tighten to Bot __typename + paginate threads/reviews (per Codex P2s on #495) ([9ee9682](https://github.com/xtrm-dev/core/commit/9ee968208de5fbfe75d0a0f310b5804a74b0b7f8))
- Recommend symlink install over cp (xtrm-81c64) (#497) ([e642412](https://github.com/xtrm-dev/core/commit/e64241266a01e0d19e2a363f30a8c597135fa5ac))
- Wave-2 — pull_request_review_comment trigger + preserve CR verdicts (xtrm-54zwl.7) ([6651be3](https://github.com/xtrm-dev/core/commit/6651be380872f333a4c388e097cf1c9436d874ed))
- Reconcile SKILL.md + CLAUDE.md with pr-review-gate wave-2 reality (xtrm-54zwl.8) ([2ff4e42](https://github.com/xtrm-dev/core/commit/2ff4e42aa49001fe7a40918d09636e594c79ca78))
- Slim 4 orchestration roots + retire MSG-06 rows + budget check (xtrm-wiy5n.1.1) (#504) ([4ca674e](https://github.com/xtrm-dev/core/commit/4ca674ef066b724b2640cb028123d6bdfc575eb1))
- Align xtmux communication contracts (#507) ([362db69](https://github.com/xtrm-dev/core/commit/362db69aa09936f4498927bbc6685bc0fd1fd27a))
- Claude-column contract matrix for the cross-runtime gate (#512) ([c48b46b](https://github.com/xtrm-dev/core/commit/c48b46b1c66734c66f154451f85f3bb31f21745c))
- Re-vendor specialists skills at master ba8526cd (#515) ([53e4afe](https://github.com/xtrm-dev/core/commit/53e4afe451d73e7655cfc664297694fb45e7905b))
- Commit the injected communication-style + task-tracking block (xtrm-wiy5n.4.36) (#518) ([2a659f0](https://github.com/xtrm-dev/core/commit/2a659f0c1c859473245806eedb0d9f185ff78a31))
- Remove the ambiguous tool prohibition and the contradicting bd line (xtrm-wiy5n.4.36) (#519) ([060958d](https://github.com/xtrm-dev/core/commit/060958d94d39fa6a369091f4121828c030111c4a))
- Admin-merge bypass matrix + rebase-push discipline (xtrm-wiy5n.4.8 + .4.12) (#521) ([ded850a](https://github.com/xtrm-dev/core/commit/ded850a343d877f6262451fe3140fa171c47f777))
- Name the global-surface smoke container in the release path (xtrm-x9wz8) (#528) ([653dae6](https://github.com/xtrm-dev/core/commit/653dae6ded6327bda0d68060fa4243a6cac5242b))
- Compact entries — no bold, no blank line between bullets (#531) ([8ef20ce](https://github.com/xtrm-dev/core/commit/8ef20ced683803f065f885833099ab04845a897f))

## [v0.11.2] — 2026-07-22

### Changed

- **Slim Pi custom-footer and beads hot paths (xtrm-64pl0)** — `custom-footer` is now a pure cache
  reader: it renders path/branch, context/model, and one compact beads line from
  `.xtrm/cache/beads-status.json` only. Footer render and normal startup spawn no `bd`, and a
  `bd` mutation `tool_result` re-reads the cache file instead of spawning a refresh subprocess.
  The `beads` edit gate no longer falls back to `bd list` (`hasTrackableWork` removed); the claim
  lookup is run-scoped (cached for the run, invalidated on observed claim/close/KV mutations)
  instead of a 3s TTL; and the memory-gate lifecycle check runs once at `session_shutdown` instead
  of both `agent_end` and `session_shutdown`.

### Removed

- Pi `custom-footer` expandable beads tree UI — the `/beads` command, the `Alt+G` toggle, and the
  descendant/parent `bd query/show/children` + cache-refresh subprocess path (xtrm-64pl0).

### Behavior change (xtrm-64pl0)

- Within a beads project, an edit with no active claim is now blocked directly without a `bd list`
  board scan, so empty-board edits in a beads project require a claim too. Claim and commit safety
  are otherwise unchanged.

## [0.11.1] - 2026-07-20

### Added

- **Allow launch overrides without roles (#433)** ([981d0b6](https://github.com/xtrm-dev/core/commit/981d0b6ea3c23adb72e8d6d495c7ee5ca52eb7c4)) — 2026-07-17 00:39

- **Consolidate setup/update/repair/doctor command UX (xtrm-f42ns.8) (#446)** ([f9496e1](https://github.com/xtrm-dev/core/commit/f9496e140ec83522c745a8d447750cec507d34b2)) — 2026-07-20 11:20

### Deprecated

PR #446 introduced the canonical operator surface (`xt init`, `xt update [--apply]`, `xt doctor`, `xt migrate`, `xt pi setup`). The commands below remain as compatibility shims with replacement guidance and are scheduled for removal in `v0.13.0`. Do not re-run `npm run changelog:update -- --tag v0.11.1` against a released commit — it regenerates this subsection from `git log` and would drop this table.

| Deprecated command    | Since  | Removed in | Replacement                                    |
| --------------------- | ------ | ---------- | ---------------------------------------------- |
| `xt bootstrap`        | 0.11.1 | 0.13.0     | `xt init` (first-time) / `xt update --apply`   |
| `xt clean`            | 0.11.1 | 0.13.0     | `xt update [--apply] --repo <path>`            |
| `xt pi install`       | 0.11.1 | 0.13.0     | `xt update --apply --repo <path>`              |
| `xt pi reload`        | 0.11.1 | 0.13.0     | `xt update --apply --repo <path>`              |
| `xt pi doctor`        | 0.11.1 | 0.13.0     | `xt doctor --repo <path>`                      |
| `xt claude reload`    | 0.11.1 | 0.13.0     | `xt update --apply --repo <path>`              |
| `xt claude reinstall` | 0.11.1 | 0.13.0     | `xt update --apply --repo <path>`              |
| `xt claude doctor`    | 0.11.1 | 0.13.0     | `xt doctor --repo <path>`                      |

### Fixed

- **Seed Claude permission defaults (#434)** ([d1bfcda](https://github.com/xtrm-dev/core/commit/d1bfcda242822c78018fd23956c5118f28d141c4)) — 2026-07-17 22:21

- **Allow leading slash in bare-mode --prompt (checkPositionZeroSlash) (#439)** ([180aea7](https://github.com/xtrm-dev/core/commit/180aea7111b00df24ec63ca310561c8dbbed8bb1)) — 2026-07-18 10:31

- **Resolve packaged Pi config from .xtrm/config/pi (xtrm-f42ns.3) (#440)** ([bf1799e](https://github.com/xtrm-dev/core/commit/bf1799ed4cabebd10464eed68f60a1b168129a9e)) — 2026-07-19 13:22

- **Unify Pi extension ownership across setup and package modes (xtrm-f42ns.4) (#441)** ([9137e69](https://github.com/xtrm-dev/core/commit/9137e6975a4af4ff53484af7c239c350ad66b184)) — 2026-07-19 14:46

- **Make xt clean ownership-safe on current layouts (xtrm-f42ns.7) (#442)** ([ba07a00](https://github.com/xtrm-dev/core/commit/ba07a00064b6ce0372781a46e183c272fdc924aa)) — 2026-07-19 14:59

- **Make xt update reconcile Pi state when registry is current (xtrm-f42ns.5) (#443)** ([cfac358](https://github.com/xtrm-dev/core/commit/cfac35846c501ec65b2f220924a5130314021b34)) — 2026-07-19 22:28

- **Xt claude subcommands resolve target project via resolveMainProjectRoot (xtrm-9635h) (#450)** ([0384241](https://github.com/xtrm-dev/core/commit/03842417ba3232ee6888197d2fe1e704dc15197f)) — 2026-07-20 14:53

- **Guard installFromRegistry snapshot when packageRoot === installRepoRoot (xtrm-5ts3l) (#452)** ([cf43952](https://github.com/xtrm-dev/core/commit/cf43952ad7dfad818b3901b4dcddfb09703a6fa0)) — 2026-07-20 15:50

### Other changes

- **Drop permissionsDefaults seed (PR #434) — mechanism was unneeded (#438)** ([e96d499](https://github.com/xtrm-dev/core/commit/e96d49956c311c40124dd8dc7d8c62b2b4d44d0c)) — 2026-07-18 09:18

### Project maintenance

- **Memory system evolution (r6g research) (#435)** ([17e3f87](https://github.com/xtrm-dev/core/commit/17e3f872912ec21aef5d30dc2cada39bae3723ab)) — 2026-07-18 00:09

- **Document bare xt claude/pi --prompt launch mode (post PR #433) (#437)** ([807d9bc](https://github.com/xtrm-dev/core/commit/807d9bc183c50b39b37ec9dff0946f4c4ab6aceb)) — 2026-07-18 10:43

- **Remove dead install guidance and guard retired pi install (xtrm-f42ns.6) (#444)** ([6b2f14e](https://github.com/xtrm-dev/core/commit/6b2f14e950f68e714682f8641350151795779cff)) — 2026-07-19 22:53

- **Add install update UX pack smoke (#445)** ([76d37bc](https://github.com/xtrm-dev/core/commit/76d37bcb6e9a5286dc69758463949081aec89f3e)) — 2026-07-20 10:49

- **Fix update.test.ts stale mock + help expectations post-f42ns.8 (xtrm-f42ns.10) (#447)** ([ac7ec7f](https://github.com/xtrm-dev/core/commit/ac7ec7f6194ccdef44e1f953da6f2a7a73e37fa6)) — 2026-07-20 11:33

- **Align repo to Node 24 LTS (xtrm-y21vz) (#448)** ([bda3571](https://github.com/xtrm-dev/core/commit/bda3571cec6385e087428aca0069e69cf3c622e1)) — 2026-07-20 12:27

- **Fix update.test.ts remaining regressions post-f42ns.8 (#449)** ([72bbfb4](https://github.com/xtrm-dev/core/commit/72bbfb43582ba01712e7809e875de38f6eaf4ea2)) — 2026-07-20 12:48

- **Harden HOME leak guard + strip env leaks + exclude worktrees from root vitest (xtrm-on2mk) (#451)** ([e8cd33b](https://github.com/xtrm-dev/core/commit/e8cd33be5ae7c40a7e9c57a837ad546ff39d4348)) — 2026-07-20 14:53

## [0.11.0] - 2026-07-16

### Added

- **Inject rendered bead task and explicit skills (xtrm-k2ufi)** ([f1f2e71](https://github.com/xtrm-dev/core/commit/f1f2e7155e76eb176a1fe5c1f7d9ebabbb604e3c)) — 2026-07-14 11:20

- **Add verified-audit for over-engineering + efficiency audits** ([dcbe88e](https://github.com/xtrm-dev/core/commit/dcbe88e6c54daf418a0f877c005d2429c764a179)) — 2026-07-15 09:38

- **Sp-owned turn-1 composition + HOME leak guard (xtrm-8zsi1)** ([152afa0](https://github.com/xtrm-dev/core/commit/152afa0ded06ee80429724994def7b3886d23995)) — 2026-07-15 07:00

- **Strip xtrm-loader eager Project Intelligence Context (xtrm-x12p3)** ([fc8ceae](https://github.com/xtrm-dev/core/commit/fc8ceae0b7cb44c526ae7feaa6507b978c5e4a4b)) — 2026-07-15 07:48

### Fixed

- **Omit unsupported prompt delimiter for Pi (xtrm-josmq)** ([ff5c642](https://github.com/xtrm-dev/core/commit/ff5c6426e76697bee9e4ed2e7582fc6b607b3e15)) — 2026-07-14 11:58

- **Force skill bodies into startup context (xtrm-14w28)** ([6722fb2](https://github.com/xtrm-dev/core/commit/6722fb29cc3546ecd9facbd9be287589c6077e24)) — 2026-07-14 12:21

- **Role prompt-file launch fix, git-cliff config, and changelog date-time (#420)** ([3e8b284](https://github.com/xtrm-dev/core/commit/3e8b284555deb03c7037bde68a89ce99493f0604)) — 2026-07-15 00:50

- **Use --append-system-prompt-file for claude (xtrm-osipt)** ([dc3443b](https://github.com/xtrm-dev/core/commit/dc3443b3980f4344c0a08305e441a3d18e79bee7)) — 2026-07-14 19:30

- **Deliver explicit --skill via /skill-<name> at turn-1 (xtrm-8zsi1 follow-up)** ([cc918bd](https://github.com/xtrm-dev/core/commit/cc918bdd6dbb8339ec773dc532c52fc340e7ae0e)) — 2026-07-15 10:02

- **Reconcile PR 422 launcher redesign** ([2a17992](https://github.com/xtrm-dev/core/commit/2a17992f243208179f64cdc7e0fb0445347356a5)) — 2026-07-15 10:59

- **Harden trusted tmux role transport** ([1dd6b4e](https://github.com/xtrm-dev/core/commit/1dd6b4e23922e89d32e75a7aba90dcadb8fbff68)) — 2026-07-15 12:04

- **Support declared skill prefix fallback** ([20a92bc](https://github.com/xtrm-dev/core/commit/20a92bc110ad684fbae672823f2d4a5b73f990ff)) — 2026-07-15 12:13

- **Preserve literal prompt prefixing** ([2ef13da](https://github.com/xtrm-dev/core/commit/2ef13daeb51d49cb79ee95342feac66d39288b32)) — 2026-07-15 12:16

- **Bound tmux consumer readiness** ([952c595](https://github.com/xtrm-dev/core/commit/952c595337a61a71d2ef0f7b53521468651c4377)) — 2026-07-15 12:56

- **Bound tmux wrapper payload wait** ([d34fcaf](https://github.com/xtrm-dev/core/commit/d34fcaf8b59a5e0b062a0f425e4e6793f9865693)) — 2026-07-15 13:14

- **Repair external Pi tool patches (xtrm-5c1nc) (#415)** ([cf1cd98](https://github.com/xtrm-dev/core/commit/cf1cd98844f1566c7985f37ac746c8210a56dbf0)) — 2026-07-15 14:25

- **Keep Serena on semantic navigation only (#410)** ([a4cd2fb](https://github.com/xtrm-dev/core/commit/a4cd2fbac5a1f67e061097fdf935c454edb9d608)) — 2026-07-15 14:48

- **Use native Claude skill command prefixes** ([5f88832](https://github.com/xtrm-dev/core/commit/5f88832e5457996c82e411b6a557e6aa7000bb5b)) — 2026-07-16 11:26

- **Allow skill-prefixed Claude names** ([6911363](https://github.com/xtrm-dev/core/commit/6911363cd6d91747cd70cf5451c0fe422587a7c2)) — 2026-07-16 11:35

- **Isolate role models by runtime surface (#427)** ([49ea539](https://github.com/xtrm-dev/core/commit/49ea539b8fbf374312b7758084bf9e3606127cf5)) — 2026-07-16 22:02

- **Patch Vite and esbuild toolchain (#428)** ([a84134c](https://github.com/xtrm-dev/core/commit/a84134cb4def57cdea5db3cc0dfebfcd4fc83fe4)) — 2026-07-16 22:17

### Other changes

- **Merge pull request #423 from xtrm-dev/feature/verified-audit-skill** ([2088dab](https://github.com/xtrm-dev/core/commit/2088dabb287efd78d2ad36898f93bffa84de2e35)) — 2026-07-15 09:43

- **Merge pull request #422 from xtrm-dev/xt/luho** ([8753886](https://github.com/xtrm-dev/core/commit/875388693c6b0975770c2f4c9bc88a2bc6952b29)) — 2026-07-15 14:06

- **Merge branch 'main' into chore/xtrm-f1mg8-changelog-updater** ([bd97a09](https://github.com/xtrm-dev/core/commit/bd97a097e75cc3fb719b15e762c6e1b24ef91028)) — 2026-07-15 14:17

- **Merge remote-tracking branch 'origin/main' into chore/xtrm-f1mg8-changelog-updater** ([d57b0ff](https://github.com/xtrm-dev/core/commit/d57b0ff86478567b267e5ab4e056fc236ff91925)) — 2026-07-15 22:39

- **Merge pull request #424 from xtrm-dev/chore/xtrm-f1mg8-changelog-updater** ([d91849d](https://github.com/xtrm-dev/core/commit/d91849df350c085255de9eb659e2acd838809ae5)) — 2026-07-15 22:42

- **Merge pull request #425 from xtrm-dev/xt/claude-prefix-core** ([5a8326d](https://github.com/xtrm-dev/core/commit/5a8326d16625f291ee778175c8b2db39271bf20a)) — 2026-07-16 14:24

### Project maintenance

- **Rebuild dist after source changes** ([e838d90](https://github.com/xtrm-dev/core/commit/e838d902b58dbc05eb5cb79092c5bab559d37001)) — 2026-07-14 11:21

- **Rebuild dist reproducibly** ([a4244cc](https://github.com/xtrm-dev/core/commit/a4244cc989ca2067238231f37f95e453f283dc27)) — 2026-07-14 11:25

- **Teach correlated xtmux coordination (#421)** ([612556c](https://github.com/xtrm-dev/core/commit/612556caef0a424ef6422e2ba2b9729131d5fd41)) — 2026-07-15 07:27

- **Port idempotent updater from specialists + refresh** ([5f8f96d](https://github.com/xtrm-dev/core/commit/5f8f96dad693aad6a07407b49d8c46bd76c6c5ff)) — 2026-07-15 14:10

- **Add git-cliff config and changelog** ([6465cf5](https://github.com/xtrm-dev/core/commit/6465cf58631a6bb1c68ddc81fc25ab9ba94a67c1)) — 2026-07-14 00:55

- **Teach xtmux --help first for CLI questions** ([122ea57](https://github.com/xtrm-dev/core/commit/122ea571b131229187b8626e00241c2f72ee7615)) — 2026-07-15 07:28

- **Drop using-xtrm eager inject, absorb essentials into -top** ([8da3319](https://github.com/xtrm-dev/core/commit/8da331926b0e099866d880af4426de21513d795f)) — 2026-07-15 08:01

- **Add bd forget / bd kv triggers + TaskCreate rule override** ([9002168](https://github.com/xtrm-dev/core/commit/900216833a740388f17de11bb3edd3ddaee9f925)) — 2026-07-15 08:24

- **Remove retired auto-update extension (xtrm-2kv7i) (#414)** ([e2782e3](https://github.com/xtrm-dev/core/commit/e2782e30fef91351995c97cf686693559b10eecb)) — 2026-07-15 14:36

- **Refresh dist for Claude skill prefixes** ([61a1d01](https://github.com/xtrm-dev/core/commit/61a1d0132e6eb93a282d2bf1c7fd5f255a05e35f)) — 2026-07-16 11:32

- **Rebuild dist with local cli dependencies** ([ca56970](https://github.com/xtrm-dev/core/commit/ca56970a4b2cc1cb67d400c0cc0a494f02df79a8)) — 2026-07-16 13:07

- **Reconcile specialists asset contract (#426)** ([3d93afc](https://github.com/xtrm-dev/core/commit/3d93afc5cb1668f9eb5a27dc66effcd5c4a1abf1)) — 2026-07-16 17:16

- **Baseline historical Qwen OAuth commit + ignore accounts/ (#431)** ([a7a3caa](https://github.com/xtrm-dev/core/commit/a7a3caa346282804bccc74ef6b8fab28a177551b)) — 2026-07-16 22:36

## [v0.10.6] — 2026-07-14

Merge-not-rewrite on project settings.json hooks — the wholesale-replace was eating third-party integrations.

### `xtrm-tools`

#### Fixed

- **`xt update --apply` and `xt init` wholesale-replaced project `.claude/settings.json` hooks, silently dropping every entry not in the canonical xtrm source (xtrm-61cdl, reported as xtmux-qa0, P1).** `reconcileProjectClaudeHooks` + `runClaudeRuntimeSyncPhase` did an event-scoped wholesale replace of the hooks map with the canonical set from `packageRoot/.xtrm/config/hooks.json`. Third-party integrations paid the price — xtmux's auto-monitor was killed three times in one week; last murder at commit `26fe3c7`. Same bug class as `xtrm-0p7bp` (v0.10.4) which fixed additive-only merge (nothing new landed) by going wholesale-replace (everything not-ours dropped). Both directions overshoot. Fix: new `mergeProjectOwnedHooks(existingHooks, generatedHooks, projectHooksDir)` — wrappers are dropped IFF owned (hash matches a canonical wrapper, `_source === XTRM_GLOBAL_SOURCE`, or any command references a known xtrm-managed path via substring markers `/.xtrm/hooks/`, `/.xtrm/skills/default/service-skills/scripts/`, `CLAUDE_PLUGIN_ROOT`). The command-path check catches STALE xtrm hooks that no longer match the canonical hash — they get replaced by the canonical version rather than preserved as "third-party". Everything else — user hooks, third-party integrations, per-repo scanners, project-local lint hooks — is preserved verbatim. Wired into both call sites (init + update-apply), replacing the previous `shouldUseGlobalHooks()` branching; the `filterGlobalOwnedProjectHooks` helper was subsumed. Tests: 9 new cases in `claude-runtime-sync-reconcile.test.ts` (2 integration + 7 direct helper unit tests covering third-party preservation, canonical dedupe, stale `.xtrm/hooks/` drop, stale service-skills path drop, event with only third-party hooks, malformed hooks tolerated). Full CLI suite 816 passed / 98 skipped / 0 failed.

## [v0.10.5] — 2026-07-13

Fail-open guard on service-skills hooks + durable content-fingerprint bootstrap detection + fleet-dirty-state prevention. Ships the class-level fix for the outage that bricked every basic tool in every session three times on 2026-07-13.

### `xtrm-tools`

#### Added

- **`xt migrate` / `xt update --apply` now auto-stage their data-plane changes so consumer repos don't accumulate hundreds of unstaged files after fleet events (xtrm-utdq1 + xtrm-irzid, P1/P2).** v0.10.3 fleet migration + v0.10.4 hook path fix left every consumer repo with ~300 unstaged files (D lines for retired `.xtrm/skills/default/**`, M lines for the `$CLAUDE_PROJECT_DIR → $HOME` hook path rewrite, plus tracked runtime state that was accidentally tracked in v1 templates). New helper `cli/src/utils/git-staging.ts` runs `git add -u` **restricted to xtrm-managed pathspecs** (`.xtrm/`, `.claude/`, `.pi/`, `.githooks/` — user's unrelated in-flight tracked mods are NEVER swept in, xtrm-irzid), `git rm --cached` for known runtime paths (`.xtrm/skills/state.json`, `.xtrm/worktrees/`, `.pi/skills/`, `.xtrm/cache/`, `.xtrm/statusline-claim`), and seeds a canonical `.gitignore` block on first run. Order matters and is deliberate: stage first, then untrack — the reverse leaves a pathspec with no tracked files and `git add -u` errors out. Per-pathspec invocation tolerates empty specs. Wired into `migrateSkills`, `migrateHooks`, and the per-repo `xt update --apply` refresh path — never commits, never pushes, just leaves the tree in a state where `git commit` is a one-shot. `xt init` seeds the runtime-state `.gitignore` block on fresh repos so per-machine runtime never gets tracked in the first place. Idempotent: all helpers no-op on non-git dirs, dry-runs, clean trees, and already-present markers. Tests: 12 cases in `git-staging.test.ts` including regression guard that a modified user file outside pathspecs stays unstaged.

#### Fixed

- **Service-skills hooks now fail open on missing/broken machinery (xtrm-d3qud, P0).** `policies/service-skills-claude.json` wired three raw `python3 "$HOME/.xtrm/skills/default/service-skills/scripts/<script>.py"` commands. The PreToolUse `skill_activator` hook's matcher covered `Read|Write|Edit|Glob|Grep|Bash|mcp__serena__*` — so any failure of the underlying script (missing file, syntax error, wrong interpreter, half-written during install) exited the shell non-zero, Claude Code treated it as a blocking hook error, and **every basic tool in every session was bricked in every repo**. Concrete recurrences 2026-07-13 11:59 / 14:25 / 14:39 in xtmux, hand-patched with `sed` three times because `xt claude` / `xt update --apply` regenerated the same stale command. v0.10.4's path repoint (xtrm-zayg6) fixed the *specific* instance but left the class open — the hooks are *discovery helpers*, not safety gates, so any future breakage would re-brick sessions. Fix: each hook command is now an inline `sh -c 'p="…foo.py"; [ -f "$p" ] && python3 "$p" [args]; exit 0'` wrapper. Missing file → `[ -f ]` false → short-circuits → `exit 0`. Python raises → wrapper still hits `exit 0`. Happy path → `python3` runs with stdin passthrough and its stdout (`additionalContext` JSON) still reaches Claude. Wrapper is inline in the policy — a separate wrapper file under `.xtrm/hooks/` would have the same bootstrap-race availability problem it's meant to solve (that tree is wiped+rebuilt during install alongside `.xtrm/skills/`). Also retires the secondary blast-radius scenario: during an `xt claude` install, `~/.xtrm/skills/default/` briefly drops from ~40 skills to 1 while the payload rebuilds — every concurrent session in other repos previously blocked on that window, now no-ops harmlessly. Tests: 3 new assertions in `policy-parity.test.ts` (every service-skills hook command must start `sh -c '`, set `p="…"`, gate on `[ -f "$p" ]`, end `; exit 0'`, and never reference legacy `$CLAUDE_PROJECT_DIR`); existing `resolveCommand` path-existence test extended to unwrap the guard so the script-path check still runs.
- **`ensureGlobalHooksBootstrapped` used version-string equality for staleness detection — silently downgraded `~/.xtrm/config/hooks.json` from a stale worktree source (xtrm-bbxzu, P1).** When bootstrap re-ran from any `pkgRoot` at the same version stamp as the last install, the guard noop'd. But two pkgRoots at the same version (npm-installed vs. dev worktree) can carry different content — worktree checked out before a hotfix would still stamp `installedVersion=X.Y.Z` while shipping stale hook payloads. Concrete incident 2026-07-13 11:59: a background sync (`installedFrom=/home/dawid/dev/core/.xtrm/worktrees/core-xt-pi-i80h`) copied pre-v0.10.4 `$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-skills/...` hook commands into `~/.xtrm/config/hooks.json`, which then propagated into `~/.claude/settings.json` — Bash/Read/Write/Edit blocked in xtmux until manually patched. Fix: `computeSourceFingerprint(sourceHooksRoot, sourceHooksConfigPath)` hashes the canonical `hooks.json` plus every hook file under `.xtrm/hooks/` (sorted, `__pycache__`-excluded). `state.json` now records `sourceFingerprint`; refresh triggers on fingerprint mismatch, not version equality. Same version + different content → refresh. Same content + different version → refresh. Same content + same version → noop. Force flag still bypasses. Return type gains `sourceFingerprint: string`. Existing state.json entries without `sourceFingerprint` are treated as stale on first upgrade (self-heals on next `xt install`/`xt update`/`xt init`/`xt bootstrap`). Tests: 7 cases in `global-hooks-bootstrap.test.ts` (existing idempotence updated + drift-at-same-version + hook-file drift + force + recovery-from-wiped-target + fingerprint determinism + fingerprint-changes-on-content-change).

## [v0.10.4] — 2026-07-13

Emergency patch bundle after v0.10.3's fleet migration exposed three post-migration bugs (P0 dead hook path + P1 durability regression + P1 divergence-noise bloat). All three found + fixed on the same day the fleet migrated.

### `xtrm-tools` v0.10.4 — 2026-07-13

#### Fixed

- **Service-skills hooks used `$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-skills/` — path dead after `xt migrate skills` (xtrm-zayg6, P0).** `policies/service-skills-claude.json` (SessionStart cataloger, PreToolUse skill_activator, PostToolUse drift_detector) resolved via the per-repo `.xtrm/skills/default/service-skills/` payload. When v0.10.3 fleet migration removed `.xtrm/skills/default/` in every consumer repo, all three hooks fired `python3: can't open file` on next tool call — Bash tool BLOCKED in migrated repos. Fix: rewrite the paths to `$HOME/.xtrm/skills/default/service-skills/`, the global source populated by `ensureGlobalHooksBootstrapped` on any machine with xtrm-tools installed. The machinery scripts (`cataloger.py`, `skill_activator.py`, `drift_detector.py`) are stateless w.r.t. the repo — they resolve the target repo via `get_project_root()` (`$CLAUDE_PROJECT_DIR` or `git rev-parse`), then read `<repo>/.xtrm/skills/<pack>/service-skills/service-registry.json` for per-repo data. Global machinery + per-repo data is the correct pattern (analogous to `/usr/bin/python3` reading local `data.json`). Global path is present regardless of per-repo v1/v2 layout state. Consumers pick up the fix automatically via `xt update --apply` (hook reconcile runs unconditionally per xtrm-0p7bp). Reproduced + hotfixed manually across 18 fleet repos on 2026-07-13 before this release cut.
- **`xt update` / `xt skills enable` repopulated `.xtrm/skills/default` post-migration (xtrm-77t9q.5, P1).** After `xt migrate skills --apply` removed the per-repo default/optional dirs and recorded the migration in `~/.xtrm/known-repos.json`, subsequent `xt update --apply` or `xt skills enable ... --local` calls without `XTRM_GLOBAL_SKILLS=1` env would re-install the per-repo default/ (undoing the migration). Reproduced on darth-feedor + treasury-cb (migrated 2026-07-10, restored between then and 2026-07-13 via routine fleet update). Fix: `shouldUseGlobalSkills(repoRoot?)` now checks `known-repos.json.skillsMigrated=true` in addition to the env flag. All install/update/scaffold callers (`installFromRegistry`, `scaffoldSkillsDefaultFromPackage`, `createProjectRegistrySnapshot`, worktree provisioner) now pass repoRoot. Env flag remains valid for pre-migration opt-in / CI. `known-repos.ts` gained `isRepoMigratedSync` for the hot install path. Verified: post-fix, `xt update --apply --repo <migrated-repo>` and `xt skills enable ... --local` leave `.xtrm/skills/default/` file-count at 0 (empty dir may still be created cosmetically by defensive `ensureDir`, but no content restoration).
- **`walkDir` in migrator hashed `__pycache__/*.pyc` + eval workspaces as divergent — bloated `local-legacy` with runtime noise (xtrm-y0tdg.4, P1).** `verifySkillsIdentity` walked `.xtrm/skills/{default,optional}` recursively without excluding runtime artifacts, so every `__pycache__/*.pyc` file (absent from the global source by design) appeared as diverged and got copied to `local-legacy/`. Concrete impact from 2026-07-13 fleet migrate: console `local-legacy` = 242 files, infra = 154 files, both mostly `.pyc` noise instead of genuine user overrides. Fix: `walkDir` now excludes `__pycache__`, `.pytest_cache`, `.serena`, `.mypy_cache`, `.ruff_cache`, `node_modules`, `.venv`, `workspace/` directories, and `.pyc`/`.pyo` files. Smoke: seeded fixture with matching `bootstrap.py` (identical to global) + `bootstrap.cpython-313.pyc` (only local) → migrator reports `1 diverged` (only real diff), pre-fix would have reported `2`. Existing `local-legacy` bloat remains on migrated repos as historical data; re-running migrate cleanly requires clearing `known-repos.json` first.

## [v0.10.3] — 2026-07-13

Two multiplexing-runtime and coordination-UX landings that had been queued in `[Unreleased]` since v0.10.2, plus the bd v1.1.0 instruction refresh that shipped alongside them.

### `xtrm-tools` v0.10.3 — 2026-07-13

#### Added

- **`multiplexing` / `multiplexing-team` — V2 SQLite runtime default-on (xtmux-3xs).** Picker delegates message/monitor/audit primitives to a SQLite-backed runtime by default; CLI surface unchanged (`message-send`/`message-list`/`unread-count`/`monitor-list`/`log-emit`); storage moved from JSONL to `${XDG_STATE_HOME}/xtmux/observability.db`. New behaviors: `message-send --bead <id>` implicitly sets `--expects-reply=true`; pane-scoped inbox via `unread-count --for <sid> --pane %N`; auto-monitor coordination hooks in `.claude/settings.json` (PostToolUse + Stop enforce Monitor wake on peer transition); auto-wake on pi side via `pi-inbox-reply` + `pi-auto-monitor` extensions. Env override: `XTMUX_OBS_V2=on|shadow|off`. Companion cross-refs added to `code-review`, `deploy-monitor`, `pr-reviewer` skill guides.
- **Shared repo-scoped beads-status cache (xtrm-77t9q).** New `.xtrm/hooks/beads-status-cache.mjs` module coalesces N agents in the same repo (Claude statusline + Pi custom-footer, main + linked worktrees) to one `bd` refresh per TTL. Schema v1 cache at `<mainRoot>/.xtrm/cache/beads-status.json` (atomic rename, 0o600, single-flight lease at `.lock`, 5s TTL compact / 30s TTL descendants). `resolveMainRoot` is pure-fs (reads `.git/worktrees/<n>/gitdir` directly, no subprocess). `fetchCompact` walks nested parents up to 8 levels to find the owning epic. `formatCompact` renders the shared one-line spec (`12 open · 2 in progress · epic k2ufi (1/3 done)`) — Pi and Claude statusline get parity by construction. Fail-soft `stale: true` marker + `stale Xm` age tag past 10×TTL. `.xtrm/hooks/statusline.mjs` refactored to consume the module; `runFast(250ms)` for git / `runBd(2000ms)` for bd fixes the pre-existing 250ms-timeout bug that made statusline fall back to `no open issues`. `packages/pi-extensions/extensions/custom-footer/index.ts` consumes the same cache for compact rendering plus an on-demand Ctrl+O expanded epic tree (indent-2 per level, N=50 cap, `+M more` overflow) with skeleton-then-repaint refresh.

#### Changed

- **Instruction routing files caught up to bd v1.1.0 (xtrm-3kccz).** Verified the installed `bd` binary against v1.1.0's documented CLI surface (`bd --help`, `bd ready --help`, `bd create --help`) and added the two genuinely new, stable commands that `bd prime` itself doesn't teach: `bd ready --claim`/`--explain` and `bd create --graph`/`--waits-for`/`--spec-id`/`--skills`, to the `Essential command surface` section of both `.xtrm/config/instructions/agents-top.md` and `claude-top.md`. Deliberately excluded `bd ready --mol`/`--gated` (no formulas/molecules currently in use in this repo) and all `main`-only/unreleased bd features (claim TTL/heartbeat/reclaim, `bd formula schema`, `bd history --events`). Also evaluated and reverted a `bd setup claude`-injected block in `CLAUDE.md` (xtrm-h4cwy): its content duplicated `bd prime`'s live output and contradicted this repo's requirement to use Claude-local task planning (TaskCreate/TodoWrite-style) alongside beads.

## [v0.10.2] — 2026-07-13

Fleet audit after v0.10.1 exposed two mopping-up gaps that survived every `xt update --apply` on consumer repos.

### `xtrm-tools` v0.10.2 — 2026-07-13

#### Fixed

- **Service-skills hook commands referenced a symlink-dependent path (xtrm-ec9um).** `policies/service-skills-claude.json` (compiled to `.xtrm/config/hooks.json`) wired the SessionStart cataloger, PreToolUse `skill_activator`, and PostToolUse `drift_detector` at `$CLAUDE_PROJECT_DIR/.claude/skills/service-skills/scripts/`. That path only resolves when the `service-skills` skill is enabled and its direct-runtime-links symlink exists at `.claude/skills/service-skills`. In 17/19 fleet consumers the skill is NOT enabled, so every hook fired `python3: can't open file` and either blocked or emitted noise. The scripts themselves are registry-gated (no-op if no `service-registry.json`), but Python can't gate what it can't load. Hooks now reference the canonical `$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-skills/scripts/` path, which is present in every consumer via `installFromRegistry` regardless of skill enablement. `sre-agent` originally flagged this on `mercury-infra`; the fleet-wide sweep confirmed identical drift on 16 more repos.
- **`normalizePiSkillsEntries` missed per-runtime suffix variants of the retired `active/` path (xtrm-ec9um).** `LEGACY_XTRM_SKILLS_ENTRIES` in `cli/src/core/pi-runtime.ts` covered `../.xtrm/skills/active`, `~/.xtrm/skills/active`, and `~/.xtrm/skills/default` — but not `../.xtrm/skills/active/pi`, `../.xtrm/skills/active/claude`, or their `~` counterparts. `.pi/settings.json` entries with the per-runtime suffix survived every `xt update --apply`. Fleet audit found 6 repos still carrying `../.xtrm/skills/active/pi` after v0.10.1. Set extended to cover all 8 variants. Regression coverage added in `cli/src/tests/pi-runtime-safeguards.test.ts`.

## [v0.10.0] — 2026-07-12

Root `xtrm-tools` release rolling up the Global Skills Migration epic (both global SSOT + repo-side v2 flat layout with `xt migrate` tooling), the `xt pi --role` / `xt claude --role` role-launcher family (xtmux-1lb.*), pi runtime hardening (per-call latency, footer scheduling, theme preflight), and the `multiplexing` deploy-gap chain. Publish root `xtrm-tools` from this release commit/tag. `@jaggerxtrm/pi-extensions` v0.9.4 and v0.9.5 were published independently to npm earlier in the cycle (2026-07-08 / 2026-07-11) and are captured in their own blocks below.

### `xtrm-tools` v0.10.0 — 2026-07-12

#### Added

- **Global Skills Migration — global SSOT + repo v2 flat layout (Epic xtrm-bq7yd, PRs #372, #390, #392, #393, #394).** Skills migrated from per-repo materialization to a global source of truth at `~/.xtrm/skills/{default,optional,user}/`; project residual keeps only user packs and composed state. Repo-side pack layout flattens to `<repo>/.xtrm/skills/<pack>/` — no `PACK.json`, no `user/packs/` nesting, no `active/` view. Direct-symlink runtime model populates real dirs at `<repo>/.claude/skills/` and `<repo>/.pi/skills/`; `state.json` gains a `managedLinks` manifest tracking xt-owned links so reap-time cleanup only touches tracked entries. `xt migrate skills-layout --dry-run/--apply/--restore` performs SHA-256 verification, tarball backup, idempotent cleanup, dangling runtime-symlink pruning (retired `active/` targets), and audit logging to `~/.xtrm/logs/skills-migration.jsonl`. `xt skills list/enable/disable` default to `--global`; `xt skills create-pack` defaults to `--local`. Docs: `docs/plans/global-skills-migration.md`, `docs/skills.md`, `docs/skills-tier-architecture.md`, `docs/project-skills.md`, `docs/xtrm-directory.md`. Followups: PR #393 stops scaffolding empty `.xtrm/skills/user/packs/` on init; PR #394 syncs shipped `service-skills` mirror with v2-aware source (unblocks mercury service-skills discovery); PR #390 reconciles direct runtime links after batch migration; PR #373 makes the `local-legacy` pack preserve nested tree with correct `PACK.json` `name`.
- **`xt pi --role` launcher (PR #362, xtmux-1lb).** Launch pi as a specialist role in a tmux session with `--role <name>`, `--bead <id>`, `--no-attach`. Role resolves via `sp view`; worktree provisioned; `@agent_*` metadata set on the target pane; `agent.role.launched` event emitted via `tmux-session-picker log emit`. Extended in-flight:
  - PR #364 (xtmux-e1o): scaffold `.xtrm/skills` + `.specialists` in the worktree so pi resolves skills.
  - PR #365 (xtmux-2dy): `--model` / `--thinking` flags, `--` passthrough forwarded verbatim, curated extension policy.
  - PR #382 (xtmux-1lb.5.1): current-pane default inside `$TMUX`; new `--new-session/--ns`, `--parent <target>`, `--child` flags. Behavior matrix in `xt pi --help`.
  - PR #386 (xtmux-1lb.6): `--reuse` attaches an existing session (no `agent.role.launched` emitted since metadata isn't guaranteed current); default auto-suffixes `-<hex>` on collision using the same 4-char random slug as the worktree layer, retries up to 10 times.
- **`xt claude --role` — full parity with `xt pi --role` (PR #383, xtmux-1lb.1).** Same launcher surface (`--role`, `--bead`, `--no-attach`, `--model`, `--thinking` warn-and-drop, `--new-session/--ns`, `--parent`, `--child`, `--` passthrough). Shared plumbing (`buildRoleTmuxPlan`, `launchRoleTmuxSession`) is runtime-aware: pi gets `--append-system-prompt <file>` + `--skill <path>` per role skill; claude gets `--append-system-prompt <prompt>` + `--dangerously-skip-permissions` (skills resolve from cwd's `.claude/skills/`).
- **`xt --role` — runtime encoded in session name (PR #388, xtmux-3h8).** Session names now include the runtime so `xt pi --role X` and `xt claude --role X` produce distinguishable sessions: `role-pi-<slug>[-<bead>]` vs `role-claude-<slug>[-<bead>]`. Both coexist in `tmux ls` without `--reuse` or auto-suffix. Backwards-incompatible for anyone relying on the pre-flip `role-<slug>[-<bead>]` shape; nobody parses this format programmatically, so no migration needed beyond re-launching.
- **`xt migrate` — local-legacy repair recipe (PRs #373, #374).** Migrator preserves the nested legacy tree on the `local-legacy` pack and sets the correct `PACK.json` `name`; `update-xt` skill documents the repair recipe and the `xt migrate --restore` flow.
- **`multiplexing` — deploy-gap chain + `verify-deploy-applied.sh` (PR #369, nsur).** Codifies the deploy-gap chain (build → deploy → verify) and ships `scripts/verify-deploy-applied.sh` for post-deploy verification.
- **`multiplexing` / user docs — `xt pi/claude --role` launcher flag surface (PRs #385, #391, xtmux-1lb.3, xtmux-08f).** User-facing docs page + README link; multiplexing skill documents launcher flag surface with parity coverage.
- **`xt pi --help` documents `--` passthrough (PR #381, xtmux-1lb.2).** `xt pi --help` now surfaces the `--` passthrough contract with two concrete examples. Same treatment lands on `xt claude` via the shared parity work.

#### Changed

- **Code restraint section in top-level agent injections (PR #359, docs commit b491d5bd).** Companion to specialists PR #173 (unitAI-pzmwf) which introduced a unified code-restraint discipline at the mandatory-rule level and in the orchestrator skill; this layer is for when the agent implements directly without delegating to a specialist. `.xtrm/config/instructions/{claude,agents}-top.md` gain a 3-bullet `## Code restraint (when implementing directly)` section: the ladder in one line (YAGNI → reuse → stdlib → native → one line → minimum), the never-simplify-away boundary (input validation at trust boundaries, error handling that prevents data loss, security, accessibility, explicitly requested behavior, understanding the problem), and the deliberate-shortcut marker `// SIMPLIFIED: <ceiling>. upgrade when <trigger>.`. Full ladder + rules + tag vocabulary specifics live in the specialists mandatory rule and are not repeated here (reuse over rewrite — the same discipline being taught). Identical text in both files so all downstream propagation (~30 consumer repos via existing `xt update` flow) picks up the same rule regardless of runtime. Zero external plugin brand references in shipped text.
- **Pi runtime hardening (PR #363).** `quality-gates` extension disabled by default (inert-by-bug — hardcoded pre-plugin-era paths, never fired). `pi-gitnexus` `autoAugment` seeded off in `~/.pi/pi-gitnexus.json` (was ON by default and was the dominant per-call latency source, running up to 3 `gitnexus augment` subprocesses after every grep/read/bash `tool_result`). Serena `blockedTools` migrated so legacy blocklists no longer force agents onto Serena tools when built-in file ops would work; existing custom blocklists preserved. `xt updatePiSettings` now seeds `serena.blockedTools=[]` and migrates built-in-only legacy blocklists.
- **Bounded statusline refresh work (PR #376).** Statusline no longer stampedes on cache miss; the five-Git-plus-Beads `execSync` path now uses atomic stale cache + one per-user refresh lease + detached best-effort refresh. Node startup still sets a ~100ms wall-time floor.
- **Registry regenerated to include multiplexing/deploy-gap script (PR #371).** `scripts/verify-deploy-applied.sh` was missing from `.xtrm/registry.json` after PR #369; regen picks it up so consumers get it on `xt update --apply`.
- **Vendored specialists-owned skills refreshed to `@jaggerxtrm/specialists` v3.18.2 (xtrm-1o63w, PR #397).** `.xtrm/specialists-source.json` `source.ref` now pins the immutable `v3.18.2` tag (`resolved_sha` `fb5ba95c`) instead of the mutable `master` head. The retired `using-specialists-v2/` and `using-specialists-v3/` skill assets are removed from `.xtrm/skills/default/`; canonical `using-specialists` + `using-specialists-auto` remain and are regenerated in `.xtrm/registry.json` + `docs/skills-ownership.json`. Companion to the runtime prune wiring in PR #395 (xtrm-1o63w.1) — retired managed skills are removed from consumer trees on the next `xt update --apply`. Follow-up hygiene tracked at xtrm-1o63w.2 (gitignore + pre-commit interaction with vendored eval fixtures).

#### Fixed

- **`xt pi --role` — drop broken `-e` extension allow-list; `$HOME` fallback for skill resolution (PR #377, xtmux-3rs, xtmux-1rn).** Curated `-e` allow-list from PR #365 broke real launches when a role's skills lived under `$HOME/.pi/agent/skills/` or `~/.agents/skills/` (Pi's global skill paths). `$HOME` fallback added so skill resolution walks the same paths Pi natively discovers.
- **`xt pi --role` switch-client attach inside `$TMUX` (PR #380, xtmux-1lb.5).** `launchRoleTmuxSession` uses `tmux switch-client` when the caller is inside an existing tmux client (was `tmux attach-session`, which refused with "sessions should be nested with care, unset TMUX to force"). Outside tmux, `attach-session` is retained. Extracted as a pure `chooseAttachCommand(sessionName, insideTmux)` helper. `--no-attach` path unchanged. Superseded by PR #382's current-pane default for the common case; retained for `--new-session` flows.
- **`xt claude --role` — leftover pi-only runtime guard removed (PR #387, xtmux-1lb.1 followup).** PR #383 shipped the CLI surface but missed removing an up-front guard that hard-refused `runtime !== 'pi'`. `xt claude --role X` now actually launches instead of erroring with `"--role is currently only supported for pi"`.

## [pi-extensions v0.9.5] — 2026-07-11

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.9.1 line until v0.10.0 above.

### `@jaggerxtrm/pi-extensions` v0.9.5 — 2026-07-11

#### Added

- **`xtprompt` generalized (PR #375).** Removes Mercury-specific branding/domain rules from what is now shipped as generic package surface; canonical rewrite behavior aligns planning + prompt-improving intents, and asks one clarification for vague prompts before inventing detail. Context summaries pass through the same `MAX_CONTEXT_CHARS` bounding path as recent entries. `ctx.ui.input()` only used in TUI mode for isolated clarification; registry smoke imports `src/registry.ts` directly.
- **`xtrm-ui` richer compact rendering (PR #370).** Plain-pi-like details on external tool rows with color-coded state; native/external tool row parity improved for compact mode.

#### Fixed

- **XTRM theme availability before Pi startup (PR #378).** Pi resolves `settings.theme` before package extension `resources_discover`, so any XTRM theme persisted in settings must be materialized under `~/.pi/agent/themes` during launch preflight. Preflight now owns the four `xtrm-*.json` filenames and materializes them before Pi resolves the theme, preventing startup fallback to built-in dark.
- **Custom footer refresh scheduling (PR #379).** Custom-footer was starting subprocess refreshes from render every 5s (stampeded on cache miss and blocked repaint). Refresh state now cached; fixed-command Git/Beads refreshes are scheduled from lifecycle/tool/branch events. Dispose only clears listeners and requestRender callbacks it owns to prevent reapply from detaching the new footer.

## [pi-extensions v0.9.4] — 2026-07-08

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.9.1 line.

### `@jaggerxtrm/pi-extensions` v0.9.4 — 2026-07-08

#### Changed

- **`xtrm-ui` cleanup: theme duplication, flattools detection, and xtprompt wiring (PR #366).** Consolidated all contradictions from earlier iterations: keep canonical `themes/xtrm-ui/` (drop duplicate themes dir), `isXtrmTheme` recognizes `flattools`, `xtprompt` registered in managed bundle (was orphaned shim), `pi-serena-compact` removed from registry (`tool_result` no-op — only `xtrm-ui` compacts), `shortenHome` made internal (dead export, used internally by `shortenPath`).

#### Fixed

- **`xtprompt` import path corrected + enrollment shim restored (PR #367).** v0.9.3 rewrite of `@mariozechner/*` → `@earendil-works/*` (PR #358) missed the `xtprompt` extension's fallback filesystem path and enrollment shim; corrected so `xtprompt` loads cleanly under `pi 0.80.3+` and enrollment surfaces in the picker again.

## [pi-extensions v0.9.3] — 2026-07-05

### `@jaggerxtrm/pi-extensions` v0.9.3 — 2026-07-05

#### Changed

- **Migrate all `@mariozechner/*` imports to `@earendil-works/*` across the bundle.** Upstream Pi renamed the npm scope (Mario Zechner → Earendil Works); the currently installed `pi` binary is `@earendil-works/pi-coding-agent@0.80.3`. Legacy `@mariozechner/*` continued to work at runtime only via a temporary compat alias in Pi's extension loader — its own CHANGELOG notes that "the compat entrypoint and the loader alias will be removed in a future release." This release rewrites every specifier (both value and type imports, plus per-extension `peerDependencies` in `serena-pool` and `pi-serena-compact`, and the fallback filesystem path in `xtrm-ui`) to `@earendil-works/pi-{coding-agent,tui,ai}`. Surfaced by Codex review on PR #357 while landing v0.9.2. Verified by swapping the migrated bundle into the live pi runtime and running `pi --version` — no `Cannot find module` errors, no warnings.

## [pi-extensions v0.9.2] — 2026-07-05

### `@jaggerxtrm/pi-extensions` v0.9.2 — 2026-07-05

#### Fixed

- **`pi` failed to start after installing `@jaggerxtrm/pi-extensions@0.9.1`.** The v0.9.1 release added `xtprompt` to `src/registry.ts` (`import xtprompt from "./extensions/xtprompt.ts"`) but shipped no `src/extensions/xtprompt.ts` — every other bundled extension has a one-line shim there re-exporting from `../../extensions/<name>/index.ts`, and the new one was missed. Every `pi` startup crashed with `Cannot find module './extensions/xtprompt.ts'` from `pi-extensions/src/registry.ts:17`, forcing users onto `pi -ne` to load the agent at all. This release adds the missing shim; the `xtprompt` package source at `packages/pi-extensions/extensions/xtprompt/{index.ts,package.json}` was already correct and shipped in v0.9.1.

## [v0.9.1] — 2026-07-04

### `xtrm-tools` v0.9.1 — 2026-07-04

#### Added

- **`/using-xtrm` documents the `xt worktree` drift audit primitives (xtrm-brqvq).** New "PR / branch / restart audit primitives" subsection in `skills/using-xtrm/SKILL.md` covers `xt worktree audit-prs`, `branch-gc`, and `restart-audit` with a composition table mapping each to its specialists-side pairing (`doctor --pr-drift`, post-merge chain-cleanup, `doctor --reap-dead-jobs`), safety notes (read-only by default, `--apply --yes` required for `branch-gc`, no auto-rebase / no force-push), and the structured `--json` field set. Compact templates `.xtrm/config/instructions/{claude,agents}-top.md` add a one-line `xt worktree --help` pointer to the essential-commands list (no flag tables — discovery only). Reverse cross-link landed in `xtrm-dev/specialists` `/using-specialists-v3` via `specialists-agt`.
- **`xt worktree` durable PR/worktree drift primitives (xtrm-lk4on).** Added structured PR merge-state classification (`clean`, `needs-rebase`, `conflicted`, `blocked`, `closed`, `unknown`), `xt worktree audit-prs [--json]` for operator/bot PR attention reports, `xt worktree branch-gc [--prefix xt/] [--apply --yes] [--json]` with dry-run-by-default local branch cleanup for closed/merged PR branches, and `xt worktree restart-audit [--prefix xt/] [--json]` for startup/cron-safe reconciliation of orphaned managed dirs, branch/worktree drift, PR attention, and cleanup suggestions. All new surfaces emit structured JSON with `component`, `repo`, branch/PR fields, classification/action/outcome, `checked_at_ms`, and redacted error details; destructive branch deletion requires explicit apply/confirmation and skips open/unknown/no-PR/checked-out branches. Covered by mocked `gh` tests plus temp-repo fake-gh smoke validation.
- **`multiplexing` default skill (PR #318).** Adds a tool-agnostic tmux-session orchestration skill for operators coordinating multiple concurrent agent/shell/vim sessions. It codifies safe handoff primitives (beads first, `/tmp` prompt files second, single-line `tmux send-keys` pointers last), pre-flight checks, cleanup/recovery patterns, and worktree-isolation guidance so delegated panes do not race on shared checkouts.
- **`multiplexing-team` default skill.** Companion to `/multiplexing` for delegated agents running in a tmux pane under an orchestrator/judge. Teaches subordinate agents how to identify their contract (bead + optional `/tmp` prompt file), report back through beads and xtmux messages, inspect siblings safely, use xtmux primitives, and spawn their own specialists only when necessary. Split from the top-level operator skill so team-member panes have a focused reference without the orchestration surface.
- **Service-skills Phase C auto-reconcile via service-skills-sync specialist (epic xtrm-d8r36, PR #313).** Reusable workflow `service-skills-drift-sweep.yml` auto-reconcile job rewritten to invoke the same `service-skills-sync` specialist that runs locally under `/updating-service-skills`, eliminating the Phase B two-codepath split. New caller inputs: `specialists-version` (default `'3.17.0'`, exact npm pin per xtrm-d8r36.2), `specialists-git-ref` (optional `github:xtrm-dev/specialists#<sha>` override for using HEAD before a release publishes), `specialists-pack` (default `'default'`), `specialists-model` (default `'nano-gpt/moonshotai/kimi-k2.6:thinking'`, seeded into `~/.config/specialists/user.json` via `sp init --global` + `sp edit --global` because v1.6.0 ships `execution.model: null`), `bun-version` (default `'1.3.12'`, required because `sp` ships as a `#!/usr/bin/env bun` bundle), `beads-version` (default `'1.0.5'`, satisfies `service-skills-sync.capabilities.external_commands`), `pi-version` (default `'0.79.10'`, provides the `pi` binary that `sp script` spawns), `runs-on-reconcile` (JSON, default `'"ubuntu-latest"'`; self-hosted callers pass `'["self-hosted","infra"]'`). Auto-reconcile job now installs specialists + bd + pi into `$RUNNER_TEMP/sp-install-<run-id>-<attempt>/` (per-job tmpdir, immune to persistent-runner state leaks), seeds `$HOME/.pi/agent/{models.json,auth.json}` from the `nano-gpt-api-key` secret with a populated `models[]` entry, then invokes `sp script service-skills-sync --template-field script_template --vars repo/pack/cwd --model <pinned> --json --allow-write-capable --allow-skills --allow-local-scripts`. Phase B `reconcile.py` stays in-tree as a fallback path when any of those steps fail (graceful degradation). Verified end-to-end on `mercuryintelligence/infra` action 28038439215: `sp success:true`, structured JSON returned, run log shows `::notice::reconcile path used: specialist`. Runner-env tooling gaps tracked separately (xtrm-d8r36.8 scope.py/service-registry.json + xtrm-d8r36.9 gitnexus glibc) — those gate actual reconciliation outcome, not the specialist code path. (xtrm-d8r36.1–xtrm-d8r36.6 / PR #313)
- **`updating-dependencies` capability v0.** Adds the default skill package (`.xtrm/skills/default/updating-dependencies/`) with upgrade-dossier, PR-comment, research-matrix, post-deploy-watch templates and JSON schemas; ships a deterministic `scripts/dep-inspect.mjs` inspector with node:test coverage; adds the `dep-review` composite GitHub Action for PR comment/label verdicts, and switches core OSV pull-request scans to advisory while preserving push/schedule hard gates. Verified with OSV/npm live smokes and scratch issue `xtrm-dev/core#314` (`xtrm-r1ed7.1`, `.2`, `.3` / PR #315).
- **`sre-triage` default skill (devops-sre primitive, PR #291).** Adds a cross-stack health-verification skill that queries live Prometheus/Grafana through `mcpq`, triages firing alerts, down containers, stale freshness feeds, and routes findings to service skills. Ships companion helpers (`scripts/alert_history.py`, `scripts/alert_investigator.py`) and content tests so projects can perform repeatable SRE triage without hardcoding one service stack.
- **Service-skills Phase A post-merge drift detection (xtrm-g7j08 / xtrm-tg33i, PRs #295, #296).** Adds the reusable GitHub Action and opt-in post-merge hook path that detect service-skill drift after repository changes, report findings back to the workflow/PR surface, and lay the detect+comment foundation that Phase B later extends with LLM auto-reconcile.
- **Service-skills Phase B auto-reconcile pipeline (xtrm-pm5d8 / epic xtrm-lwpcn).** Reusable workflow `xtrm-dev/core/.github/workflows/service-skills-drift-sweep.yml@main` now ships a second job, `auto-reconcile`, that calls an LLM to rewrite drifted `SKILL.md` files and opens an auto-PR. Opt in per-repo with new caller input `reconcile-enabled: true` + secret `nano-gpt-api-key`; default behavior unchanged (Phase A detect+comment only). New inputs `nano-gpt-model` (default `moonshotai/kimi-k2.6:thinking`, subscription-covered) and `nano-gpt-api-url` (default `https://nano-gpt.com/api/v1/chat/completions`, hostname locked to `nano-gpt.com`). Workflow concurrency group `service-skills-drift-${{ github.ref }}` with `cancel-in-progress: false` queues successive merges. Anti-loop guard skips runs from `xtrm-auto-reconcile/*` branches or `github-actions[bot]` actor. (xtrm-pm5d8 / PRs #300, #301, #305, #307, #308, #309, #310, #311)
- **`.xtrm/skills/default/service-skills/scripts/reconcile.py`** — new zero-install Python reconciler that ships in the service-skills skill pack. Reads `NANO_GPT_API_KEY` (required), `NANO_GPT_MODEL`, `NANO_GPT_API_URL`, `NANO_GPT_TIMEOUT_SECONDS` (default 300), `XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS`. CLI flags `--json`, `--dry-run`, `--max-files N`. Exit codes: 0 success / partial-with-reconciled, 1 failed / partial-with-zero, 2 missing API key. 13 unit tests. (xtrm-pm5d8.1)
- **`docs/service-skills-auto-reconcile.md`** — per-repo enablement guide with Step 0 (`xt update --apply`), secret setup, caller workflow template, failure-mode + troubleshooting matrices. (xtrm-pm5d8.7 / PRs #303, #304)

#### Changed

- **Canonical AGENTS template now prefers context-mode for large outputs (xtrm-0i3kz, PR #346).** `.xtrm/config/instructions/agents-top.md` adds a compact "Context and output management" section telling Pi agents to use `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, and `ctx_search` for logs, tests, large command output, structured data, and indexed context; exact read/edit tools stay reserved for precise patches, and long-running servers/watchers/tails route through process tooling instead of shell backgrounding.
- **Pre-container cleanup: `service-skills-drift-sweep.yml` deprecated for Mercury, `setup-service-skills-sync` skill removed (xtrm-n0nmv).** The containerized `mercury-devops-collaborator` design (`xtrm-dev/xtrm:docs/devops/mercury-devops-collaborator.md`) supersedes the CI-driven service-skills-sync flow for Mercury repos. The reusable workflow now carries a deprecation preamble at the top: kept for non-Mercury ecosystem consumers, no active maintenance for Mercury. The default-skill `setup-service-skills-sync` (which taught operators how to wire the CI caller) is removed entirely; it was untracked source material on the local clone, never shipped via npm. Supersession notes added to closed beads `xtrm-oafcs` (Node 24 bumps for the runner that's no longer used) and `xtrm-92wx3` (reconcile.py vendoring to Mercury siblings — Phase B fallback path retired). (xtrm-n0nmv)
- **Service-skills reusable workflow actions bumped to Node 24 LTS metadata (xtrm-oafcs).** `.github/workflows/service-skills-drift-sweep.yml` updated to `actions/checkout@v5`, `actions/setup-python@v6`, `actions/setup-node@v5`, `actions/upload-artifact@v5`, `actions/download-artifact@v5`, `peter-evans/find-comment@v4`, `peter-evans/create-or-update-comment@v5`, and `peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1` (v8.1.1, SHA-pinned). Clears the Node-20-deprecation warnings GitHub emits on ubuntu-24.04 runners (surfaced from market-data fan-out smoke run 28108345620). (xtrm-oafcs)
- **Service-skills reusable workflow is now provider-agnostic (xtrm-g5hk2).** `service-skills-drift-sweep.yml` accepts new generic inputs `provider-name` (default `nano-gpt`), `provider-api` (default `openai-completions`), `provider-base-url` (default `https://nano-gpt.com/api/v1`), `provider-model` (default `moonshotai/kimi-k2.6`), and a new generic secret `provider-api-key`. The pi provider config step now writes `providers[<provider-name>] = {baseUrl, apiKey, api, authHeader, models:[…]}` dynamically; the `sp script --model` arg is constructed as `<provider-name>/<provider-model>`. External callers can target any openai-compatible provider (openrouter, vllm, etc) via `provider-*`. The legacy inputs (`nano-gpt-model`, `nano-gpt-api-url`, `specialists-model`) and legacy secret (`nano-gpt-api-key`) are retained as deprecated aliases that emit `::warning::` lines when used — the `provider-*` form wins when both are set. The Phase B fallback (`reconcile.py`) remains nano-gpt-only and is skipped with a clear notice when `provider-name` is anything else; the specialist path is the only supported route for non-nano-gpt providers. Discovered while authoring the `setup-service-skills-sync` skill (xtrm-d8r36 follow-up). (xtrm-g5hk2)
- **`agent-docs-maintainer` skill** now treats repo identity as a first-class audit requirement: docs that lead with managed xtrm/GitNexus/beads boilerplate are flagged, routing/managed line budgets are scored separately from substantive Stack Overview prose, concise operational-entry command lists are no longer treated as CLI manual bloat, and stale-term checks can be extended per repo with `.xtrm/agent-docs.toml`. (xtrm-jdn8e / PR #292)

#### Fixed

- **`sre-triage`: default skill now ships from `.xtrm/skills/default` (PR #336).** Moves the generic/canonical `sre-triage` skill out of the legacy top-level `skills/` tree into `.xtrm/skills/default/sre-triage/` and registers it in `.xtrm/registry.json`, so it is included in the managed default skill payload instead of existing only as a source-tree copy.
- **`xt install --global` no longer clobbers global hooks (xtrm-il7ov, P0).** `runClaudeRuntimeSyncPhase` now early-returns when invoked with `isGlobal: true`: the `~/.claude/settings.json` `hooks` section is left intact and only `ensureGlobalStatusLine()` runs. Every xtrm-managed hook command references `<projectRoot>/.xtrm/hooks/` and is project-scoped by definition; replacing the global `hooks` section with project-hardcoded paths previously wiped hand-configured user hooks (PreCompact `bd prime`, SessionStart `context-mode-cache-heal.mjs`) and caused project hooks to fire twice. Source fix applied in `cli/src/core/claude-runtime-sync.ts` and `cli/dist/index.cjs` rebuilt so the behavior is actually active in the CLI bundle. Two regression tests added in `cli/src/tests/claude-runtime-sync-global-guard.test.ts`. (xtrm-il7ov)
- **`xt update --apply` / `xt install` no longer bake worktree paths into hook commands (xtrm-6ofgm, P0).** New helper `resolveMainProjectRoot(cwd)` in `cli/src/utils/repo-root.ts` uses `git rev-parse --git-common-dir` to resolve the MAIN checkout even when invoked from `.xtrm/worktrees/<name>/`; `xt update` (`resolveTargetRepos` default) and `xt install` (`getProjectRoot`) both use it. Previously, running these from a worktree wrote `node "<worktree>/.xtrm/hooks/<name>.mjs"` paths into `.claude/settings.json`, then every Stop / PreToolUse / PostToolUse hook crashed with `MODULE_NOT_FOUND` once the worktree was removed (`xtrm-worktree-settings-path-drift`). Falls back to `git rev-parse --show-toplevel` and finally to `cwd` outside git repos. Four regression tests added in `cli/src/tests/resolve-main-project-root.test.ts` (main checkout / linked worktree / nested worktree subdir / non-git fallback). 278/278 cli tests green. (xtrm-6ofgm)
- **`sre-triage`: project-bound prefix/routing examples no longer look portable (PR #317).** The canonical skill now separates project-bound bindings from universal methodology, promotes `mcpq prometheus list-tools` and `infra/scripts/service-map.json` discovery to first-class steps, and warns that prefixes like `svc-*`, `feed-*`, or `infra-*` are project topology rather than standards. This prevents downstream project specializations from copying internal service/feed names into the reusable skill while keeping the PromQL probes and status taxonomy concrete.
- **`serena-pool`: cwd-race in `registerSerenaPool` (KAN-110, PR #306).** `registerSerenaPool` resolved the repo root via `ctx?.cwd ?? process.cwd()`, where `??` short-circuits on any truthy value — including a stale `ctx.cwd` pointing to the parent repo when `session_start` fires before pi's cwd settles into the linked worktree. Wrong cwd → wrong `hashToPort` → daemon bound to the parent `--project` → the next session with the correct cwd spawns a second daemon and orphans the first. Fixed by `resolveSessionCwd`, which reconciles `ctx.cwd` with the live `process.cwd()`: on disagreement it trusts `process.cwd()` only when that path is itself inside a git work-tree (`isInsideGitRepo` probe), so an unrelated cwd (e.g. a test runner in `/tmp`) never wins. The cli worktree-session launcher guarantees `process.cwd() === worktreePath` at `session_start`, making this the authoritative source. New `test6_cwdRace` uses a real `git worktree add` to assert daemon `--project` === worktree root and no orphan state on the parent port; all 6 e2e tests green (27/27 assertions). (KAN-110, authored by Rico1109)
- **`.gitignore` sweep for session/runtime dot dirs (PR #352).** Applies the specialists-style pattern: catch-all ignore for `.beads/`, `.claude/`, `.pi/`, `.codex`, and a `.xtrm/*` whitelist re-including canonical shipped assets (`config/`, `hooks/`, `registry.json`, `skills/{INVARIANTS.md, state.json, default/, optional/, user/, deferred/}`, `ext-src/`, `packages/`, `cache/`, `memory.md`, `specialists-source.json`) plus deep re-exclusions mirroring `package.json` `files` excludes (`__pycache__/`, `*.pyc`, `.serena/`, `.pi/`, `evals/`, `workspace/iteration-*/`, `*-workspace/`). Untracks 34 accumulated `.xtrm/reports/*.md` plus `context.md` and `cli/.gemini/settings.json`. Existing tracked content under swept dot dirs stays tracked; only new files are ignored by default. `git add -f` for intentional new files.
- **Specialists vendor manifest drift for `using-specialists-v3/SKILL.md` (xtrm-rcsmu, PR #353).** `check:specialists-vendor` was red on main after PR #351 edited the vendored SKILL.md in-tree (v3.6 → v3.7 with the `contract:draft/ready` bead-promotion gate and rule #15) without first porting to `~/dev/specialists` master and re-vendoring. Manifest hash patched to match the current vendored content as a stopgap; proper upstream port tracked as `xtrm-rcsmu`. Do not run `npm run vendor-specialists-skills` until that bead closes — the specialists source is still at v3.5 and a re-vendor would silently revert PR #351.

### `@jaggerxtrm/pi-extensions` v0.9.1 — 2026-07-04

#### Added

- **`xtprompt` extension folded into the `pi-extensions` bundle.** Context-aware prompt improver bound to `alt+m` (avoids collision with `pi-promptsmith`'s `alt+p`), invokable via `/xtprompt`. Rewrites current editor draft via standalone model call (using active model) with canonical `planning` / `analysis` / `development` / `refactor` / `generic` intents, bounded session context, and hard style rules, then writes improved prompt back to editor without triggering main agent turn. Previously lived as user-scoped extension at `~/.pi/agent/extensions/xtprompt.ts`; now shipped in `packages/pi-extensions/extensions/xtprompt/` and registered in `src/registry.ts` so every consumer picks it up automatically.

#### Fixed

- **`xtrm-ui` no longer compacts read/inspect tool results into the model's context.** In `pi`, the value a `tool_result` hook returns *replaces* the model-facing content — it is not a display-only transform. For Serena/GitNexus read tools (`read_file`, `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `search_for_pattern`, `find_file`, `list_dir`, `read_memory`, the JetBrains equivalents, and `gitnexus_query`/`context`/`impact`/`detect_changes`) the compactor replaced the payload with a one-line `· N lines` / `· N results` summary; the full text survived only in `details.xtrmOriginalText` for the interactive TUI expand view, so every pi surface that loads xtrm-ui (interactive sessions and any headless pi run that does not pass `--no-extensions`) received a degraded view of read output — the human could expand the row, but the model itself only saw the summary. Specialists were unaffected: they run with `--no-extensions` and never load xtrm-ui (selectively re-attach only `quality-gates`, `service-skills`, `pi-gitnexus`, `pi-serena-tools`). A new `PAYLOAD_TOOLS` allow-list short-circuits the `tool_result` handler (`return undefined`) so these pass through verbatim regardless of the `compactExternalToolResults` pref; mutation/no-payload tools keep their compact one-line summaries. `pi-serena-compact` is deliberately a `tool_result` no-op ("xtrm-ui owns external tool compaction globally") and is intentionally untouched. (xtrm-ikg38)

## [v0.9.0] — 2026-06-07

### Added

- **`agent-docs-maintainer` skill** — compact `CLAUDE.md`/`AGENTS.md` audit and template guidance for keeping agent docs as routing docs, preserving beads, specialists, GitNexus, task planning, and canonical service-skills requirements without embedding full CLI manuals. (xtrm-ot9cy, xtrm-v8oa1)

- **`xt spec` command family** — PRD-level intake CLI that compiles `spec.yaml` artifacts into planner-bead input for the specialists pipeline. Six subcommands: `xt spec draft <desc>` (templated yaml scaffold), `xt spec validate <path>` (8-gate validator with `--json`), `xt spec doctor` (runtime readiness probe against deployed planning + test-planning skills), `xt spec apply <path>` (emit planner bead with `<change-contract>` XML + dispatch planner; `--check-only`, `--dry-run`, `--reconcile`), `xt spec status <path>` (drift detection vs bd state), `xt spec archive <path>` (7-gate refusal + immutable snapshot). Apply is runtime-gated on the readiness probe — refuses with exit 65 until deployed skills carry the bd-native primitives owned by `~/dev/specialists`. Composition gate (`sp chain review/approve`) stays the operator's call; a guard test fails the suite if `sp chain approve` or `bd update --claim` ever leaks into the spec code paths. (xtrm-ai9xl)
- **`docs/specs/` reference set** — `SCHEMA.md`, `EXAMPLE.yaml`, `VALIDATE-JSON.md`, `CHANGE-CONTRACT-SHAPE.md`, `ARCHIVE-GATE.md`, `UPSTREAM-DEPENDENCIES.md`. (xtrm-ai9xl)
- **`docs/migration/create-spec-deprecation.md`** — preemptive contract for any future `/create-spec` slash command: yaml-only output, no bd writes, 2-release grace. (xtrm-ai9xl.6)

### Changed

- **Managed xtrm agent instruction templates** now use compact session-start guidance, explicitly call out Claude TaskCreate/TodoWrite-style planning where applicable, and add catch-up hygiene for handoff beads, recent reports/PRs, issue triage, and service-skills freshness. (xtrm-ycpjr, xtrm-gk0oi, xtrm-h5i5v)

- **`XTRM-GUIDE.md` CLI table** now lists every `xt spec` subcommand plus the composition-gate non-feature note and the `/create-spec` deprecation pointer. (xtrm-ai9xl)

## [v0.8.5] — 2026-06-03

Service-skills migration now *sticks* in a consumer. Repos migrated to the v2 umbrella layout on 0.8.2–0.8.4 could end up without the `service-skills` skill in their active view; this release heals them on the next `xt update --apply`. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.5 — 2026-06-03

#### Fixed

- **`layout_migrator` syncs `PACK.json` after migration.** Moving per-service dirs into `service-skills/services/` and generating the `<repo>-services` umbrella left `PACK.json` listing the now-nested services and omitting the umbrella → `PACK_METADATA_MISMATCH`, which blocked the active-view rebuild invariant. `PACK.json` `skills[]` is now recomputed from the filesystem (direct-child dirs containing `SKILL.md`) — umbrella in, ghost services out, regular skills kept; idempotent. (xtrm-x8b5g, #284)
- **Active view is rebuilt after a migration.** `xt update` only rebuilt the runtime active view when registry files drifted, and `xt init` rebuilds *before* the migration step — so a migration-only pass (2nd apply, or a package-current repo on the old layout) migrated the data but left `.xtrm/skills/active` frozen, and the consumer never saw the new `service-skills` machinery + `<repo>-services` umbrella. `ensureServiceSkills` now forces `rebuildAllRuntimeActiveViews` after a migration (best-effort, idempotent) so both `init` and `update` reflect the new layout. (xtrm-x8b5g, #284)

## [v0.8.4] — 2026-06-03

Service-skills field-hardening: the v2 drift/sync machinery met real consumer repos (mercury-market-data) and this release fixes the adaptation gaps that surfaced — an unbounded gitnexus fan-out that could OOM the host, a worktree-blind gitnexus label that silenced the librarian's semantic tiering, a registration path that faked `last_sync` and masked drift, a layout migration that left dead `.claude/skills` refs, and territory globs that quietly swept gitignored build trees. Reference docs are also reconciled to the consolidated v2 skill. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.4 — 2026-06-03

#### Fixed

- **`drift_detector` enrichment is bounded and the gitnexus subprocess tree is reaped.** `scan_drift` fanned out one `npx gitnexus` subprocess per drifted file with no cap, and a plain kill left the `node` grandchild resident — an unfiltered/broad territory (real incident: 4991 candidates) could OOM the host. Candidates are now filtered to git-tracked files first, capped at `DRIFT_MAX_ENRICH` (default 200) with an mtime fallback beyond it, and gitnexus runs in its own process group so a timeout/failure kills the whole tree. The post-merge sweep forces the cheap mtime path. (xtrm-08i0b, #280)
- **gitnexus `--repo` resolves to the main-worktree label, not the worktree dir.** In an sp-auto-provisioned linked worktree, `_gitnexus_repo_name()` returned the worktree basename (which gitnexus never indexed) → `--repo` injection failed → drift silently degraded to mtime-only. Since the `service-skills-sync` librarian *always* runs in a worktree, it never got semantic enrichment. Now resolved via `git rev-parse --git-common-dir`; a second hardcoded site in `scan_drift` is fixed too. (xtrm-vvhfs, #281)
- **Registration no longer fakes a sync; never-synced services surface as drift.** `register_service` stamped `last_sync=now` with no `last_sync_ref`; done in bulk this set every service's `last_sync` to now so the mtime pre-filter returned 0 candidates and masked real drift. Registration is now catalogue-only — only a verified audit (`update_sync_time`) stamps `last_sync` + `last_sync_ref` atomically — and `scan_drift` surfaces a catalogued-but-never-synced service's whole territory as drift (needs initial sync) instead of skipping it. (xtrm-008tr, #281)
- **`layout_migrator` rewrites legacy in-body `.claude/skills/<alias>` references.** The migrator moves each `SKILL.md` verbatim, so self/cross refs kept pointing at the dead flat path. They are now rewritten to the new `.xtrm/.../service-skills/services/<service-id>` dir (alias = service-id or registry `container`); unmapped segments are left intact and reported. (xtrm-8ike5, #281)

#### Added

- **`drift_detector.py validate-territories`** — a read-only lint that reports territory globs sweeping in gitignored build/vendor/cache files (`git ls-files` delta per pattern), with a narrow-the-glob tip. `scan_drift` also emits a one-line advisory when it drops gitignored candidates. The danger was already removed by the #280 git-tracked filter; this surfaces the sloppy patterns so they get tightened. (xtrm-br179, #282)

#### Changed

- **Reference docs reconciled to the consolidated v2 `service-skills` skill** (`docs/skills.md`, `docs/project-skills.md`, `docs/testing.md`) — the old five-skill trinity framing is replaced with the single umbrella skill + a forward pointer to the devops system. (xtrm-060ov, #278)

## [v0.8.3] — 2026-06-01

Service-skills reliability hardening: makes the v2 drift/sync machinery actually fire in consumers and tier drift **semantically** instead of silently degrading to mtime. The critical fix (lg9km) repairs `drift_detector sync` so it stamps `last_sync_ref` — without it semantic tiering was dead in every consumer. Plus the dormant-hooks reconcile on `xt update`, post-merge drift automation, and gitnexus-mandatory librarian verdicts. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.3 — 2026-06-01

#### Fixed

- **`drift_detector.py sync` now stamps `last_sync_ref` to HEAD.** The CLI path (`drift_detector.py sync <id>`) passed `project_root=None` straight to `_git_head` → `git -C None …` raised → `last_sync_ref` was always `""`, forcing `gitnexus_status=no_ref` → mtime fallback for *every* service permanently. Semantic drift tiering over the committed range `last_sync_ref..HEAD` now works for all service repos — the mechanical root of the long-standing mtime-fallback behavior. (xtrm-lg9km, #277)
- **`xt update --apply` now wires xtrm-managed hooks into the consumer's existing `.claude/settings.json`** via a focused, idempotent `reconcileProjectClaudeHooks`. Previously the settings-hooks reconcile was skipped on update (only reached when `registryChanges>0`), so the 0.8.2 service-skills hooks (SessionStart cataloger · PreToolUse activator · PostToolUse drift) stayed **dormant** in existing consumers. A hook-only change now flips already-current → refreshed; non-hook keys (model/permissions) are preserved. (xtrm-0p7bp, #274)

#### Added

- **Post-merge drift automation.** A managed `post-merge` git hook (`post_merge_drift_sweep.py`) is wired on the foolproof path (`xt update --apply` / `xt init`, via the installer's `--hooks-only` mode). On a default-branch merge it runs a cost-bounded `scan_drift` since each service's `last_sync_ref`, surfaces drift, and drops a pending marker at `.xtrm/.service-skills-drift-pending`. It never auto-runs a model-backed specialist — reconcile stays agent-driven via `/updating-service-skills`. (xtrm-jcmub, #275)

#### Changed

- **Service-skills librarian: gitnexus-mandatory triage + verdict taxonomy.** String-only "unchanged" verdicts are forbidden: `audited-and-unchanged` now requires a cited gitnexus signal; a `drift_detector` tooling failure means *repair gitnexus then re-triage* (never grep-only); a genuine gitnexus outage downgrades to the weaker `synced (string-level only)` verdict. Updated `references/updating.md` (Step-1 fallback + new Verdict Taxonomy section + mandatory Verdict/Triage output lines) and the cross-repo `service-skills-sync` specialist contract. (xtrm-q7436, #276)

## [v0.8.2] — 2026-05-31

Service Skills v2: the five separate service-skills (`creating-`, `scoping-`, `updating-`, `using-service-skills` + the `service-skills-set` bundle) are consolidated into **one umbrella `service-skills` skill**, with a per-repo generated `<repo>-services` umbrella and a hard-cut layout migrator. Upgrading is foolproof — a normal `xt update --apply` (or `xt init`) auto-migrates any old-layout pack and self-wires the Claude hooks; repos without a service-registry are unaffected. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.2 — 2026-05-31

#### Added

- **Foolproof service-skills migration**: `xt update --apply` and `xt init` now run `ensureServiceSkills` — registry-gated and idempotent, it delivers the consolidated `service-skills` machinery, auto-migrates old-layout packs to the v2 umbrella (`…/service-skills/services/<svc>/`), relocates + rewrites the registry under `.xtrm`, generates the per-repo `<repo>-services` umbrella, and demotes stale shadow registries. No manual scripts, nothing to guess. (xtrm-u54wt.4)
- Service-skills Claude hooks (SessionStart cataloger · PreToolUse activator · PostToolUse drift) now ship via a global `service-skills` policy, registry-gated so they no-op in repos with no service-registry. (xtrm-u54wt.3)

#### Changed

- **Service Skills consolidated to one umbrella skill**: `service-skills` (router `SKILL.md` + `references/` + `scripts/` + `install/` + `tests/`) replaces the four trinity skills and the `service-skills-set` bundle. Per-service skills live at `packs/<pack>/service-skills/services/<svc>/`; all paths resolve via `bootstrap.py` helpers; `.claude/skills` is a Claude view only. (epic xtrm-b86y5)
- Runtime skills materializer now keys the runtime skill name on the SKILL.md frontmatter `name`, not the directory name — fixing a hard duplicate-name collision between the per-repo umbrella dir and the `service-skills` machinery skill that previously threw during `xt update`. (xtrm-u54wt.1)
- Umbrella service-registry now wins resolution precedence over stale root/legacy `.claude` registries, and the layout migrator demotes shadowing registries so a migrated repo can't be re-shadowed. (xtrm-u54wt.2)
- Pi `service-skills` extension retargeted to the v2 umbrella paths + registry. (xtrm-u54wt.5)
- `install-service-skills.py` is now a thin, runtime-agnostic manual fallback (layout migration + git-hook install) rather than a broken Trinity copy; the README centers installation on `xt update --apply`. (xtrm-u54wt.6, .7)
- Skills: `planning` and `test-planning` now require explicit logging/telemetry contracts plus smoke/E2E validation for agent, workflow, devops, hook, MCP, deploy, shell, and boundary changes. `test-planning` also documents specialist-chain test-authoring mode and concrete `test-runner` command contracts for autonomous QA loops. (xtrm-tkqjn.11, PR #270)
- Specialists authoring docs: `specialists-creator` now documents `output_file` and `notes_mode` behavior for handoff files, including `final-only` pipeline output mode. (unitAI-f58ma)
- Vendored specialists-owned skills refreshed to the `@jaggerxtrm/specialists` **v3.17.0** release (`resolved_sha` 4de671aa); asset-contract verified against the released contract. (xtrm-xli5l)

#### Removed

- Dead trinity installer module (`cli/src/commands/install-service-skills.ts`) and its stale migration tests, which expected the pre-v2 split layout. (xtrm-u54wt.8)

## [v0.8.1] — 2026-05-27

Patch release for the post-v0.8.0 CLI maintenance surface and Pi compact UI polish. The root `xtrm-tools`, `xtrm-cli`, and `@jaggerxtrm/pi-extensions` workspaces share version 0.8.1; publish root `xtrm-tools` and the Pi extensions package from the same release commit/tag.

### `xtrm-tools` v0.8.1 — 2026-05-27

#### Added

- `xt update --all-repos` sweeps `~/dev` and `~/projects` for xtrm-managed repos; dry-run inventories by default, while `--apply` patches changed repos and commits each one with `chore: apply bd auto-stage patch (xtrm-tools auto-applied)`. (xtrm-h9hqg)

#### Changed

- `xt init` and `xt update` now apply/report the bd auto-stage patch: set `export.git-add: false` to stop mid-work `.beads/issues.jsonl` staging, then append an idempotent pre-commit shim that stages the freshly exported JSONL snapshot at commit time. Hook resolution honors `core.hooksPath`, including bd v1.0.3's valid `.beads/hooks/pre-commit` target. (xtrm-h9hqg)
- `xt init` and `xt update` now include bd/GitNexus dependency maintenance summaries: installed-vs-latest detection, non-major auto-upgrade attempts on apply, `bd doctor --fix --yes`, and GitNexus reindex when status is stale/missing/schema-drifted. (xtrm-h9hqg)
- `update-xt` skill now documents bd auto-stage patch checks, `xt update --all-repos`, dependency maintenance summaries, and the valid bd v1.0.3 `.beads/hooks/pre-commit` hook target. (xtrm-h9hqg)
- `using-specialists-v3` was refreshed with Iron-style review hardening: SCRUTINY taxonomy, mandatory code-sanity/obligations gates for production diffs, Git State Precondition, and the manual Cherry-Pick Playbook while prohibiting `sp merge` / `sp epic merge`. (unitAI-qr8mg)

### `@jaggerxtrm/pi-extensions` v0.8.1 — 2026-05-27

#### Changed

- `xtrm-ui` compact shell rows now render native bash tool activity as `bash:<command>` instead of `Ran <command>`, with no space after the colon for grep/shell-heavy workflows. (xtrm-pkaxm)
- `xtrm-ui` compact summaries now allow longer one-line subjects and metadata before truncation, so legitimate short shell commands remain fully visible in compact mode. (xtrm-pkaxm)
- `xtrm-ui` compact result metadata now includes payload size in a colon-delimited `duration:payload:count` form (for example `19ms:1.2KB:3 lines`) across native bash and external tool compaction paths where text payloads are available. (xtrm-pkaxm)


## [v0.8.0] — 2026-05-23

Cumulative roll-up of two weeks of cross-package infrastructure work. Minor bump justified by the combined surface: this is the first xtrm-tools release that **simultaneously** consolidates the dolt shared-server pattern (already in 0.7.21 — restated here so the bundle reads cleanly), the `@jaggerxtrm/pi-extensions` serena-pool integration (sub-package versions 0.7.22 → 0.7.25, all published independently to npm and now mirrored in tree), and the `@jaggerxtrm/specialists` v3.16.0 skill-mirror refresh that introduces bare-mode authoring on the consumer side. None of the changes individually warranted breaking the 0.7.21-line pattern; together they justify a minor bump because **fresh `npm install -g xtrm-tools` consumers now receive a materially different runtime surface** vs. the 0.7.21 tarball.

### Context (the prior work this bundles)

- **Dolt shared-server pattern (carried from v0.7.21).** `.beads/config.yaml` ships `dolt.shared-server: true` so consumer repos route bd writes to a single per-machine `~/.beads/shared-server/` dolt server instead of spawning per-project dolt instances. This is the foundation that makes parallel specialist workflows possible without exhausting CPU/RAM. Already in 0.7.21; included in this rollup so the cumulative narrative is explicit. See v0.7.21 entry for full context. (xtrm-f3s2)
- **Serena pool sub-package (`@jaggerxtrm/pi-extensions` 0.7.22 → 0.7.25, all published to npm).** Shared Serena MCP daemon per repo root via deterministic port hashing; pi-serena-tools picks up `SERENA_MCP_PORT` and reuses the daemon instead of spawning its own. Ownership-based orphan cleanup (process-group lifecycle, never path matching). E2E driver under `DEBUG=serena-pool`. v0.7.25 supersedes a transient v0.7.24 npm-only publish. Sub-package was already released on npm; **this xtrm-tools release brings the source code into origin/main**, closing the divergence where origin/main had `packages/pi-extensions @ 0.7.21` while npm had 0.7.25. (xtrm-sqo33, xtrm-0vda4)

### Added

- `packages/pi-extensions/extensions/serena-pool/` (index.ts + package.json + e2e tests) lands in origin/main matching the npm-published `@jaggerxtrm/pi-extensions@0.7.25`. Consumers cloning xtrm-tools from GitHub and using the local checkout now see the same source code that's in the npm package — closes the runtime gap where `@jaggerxtrm/specialists` v3.15.4+ requires serena-pool but a GitHub clone of xtrm-tools didn't have it. (PR #266)
- `docs/pi-extensions.md` documents the serena-pool releases and ownership-cleanup model. (48fea105)
- `packages/pi-extensions/extensions/README.md`: per-extension authoring guide.

### Changed

- `.xtrm/skills/default/specialists-creator/SKILL.md` vendored from `@jaggerxtrm/specialists@v3.16.0` (canonical sha `275336d0`). New sections: **System Prompt Mode** (`prompt.system_prompt_mode: append|replace` with per-runner default table and 4-combination truth table), **`specialist.mandatory_rules`** (template_sets, `disable_default_globals` quirk, inline_rules, full canonical-set listing), **Script-Class vs Package-Class Runtime** (which runner injects which prompt blocks, which fields silently no-op on script-class), and **Bare specialists** subsection (when to use `execution.bare: true`, the cp-from-npm-package recipe, orthogonality with `system_prompt_mode`, mandatory_rules bypass warning). Run `xt update --apply` in any consumer repo to propagate. (PR #265)
- `.xtrm/skills/default/using-specialists-v3/SKILL.md` re-vendored from the same canonical commit; minor delta vs v0.7.21. (PR #265)
- `.xtrm/registry.json` + `.xtrm/specialists-source.json`: new sha256 hashes and `resolved_sha: 275336d0`. Generated by `scripts/gen-registry.mjs` after `scripts/vendor-specialists-skills.mjs`. (PR #265)
- `packages/pi-extensions/extensions/xtrm-ui/`: compact tool-result rows use `›` marker instead of `•`; `TOOL_ROW_MARKER` centralized; external badge parsing accepts both old and new markers for compatibility. (xtrm-0vda4)
- Security: align runner fallback labels for xtrm-tools across the security-pipeline skill. (2a3c4057, d6e6e689, 7acccd51)
- `.xtrm/skills/default/planning/SKILL.md`: align relationship-vocabulary examples with the dependency-types refactor that landed in specialists v3.15.3. (dc2920d6, 32124f20)
- README documents the `xt update` workflow more explicitly. (871a97e3)
- `.xtrm/skills/default/issue-triage/`: scope the specialist duplicate workflow more tightly. (2ee83e1c)

### Fixed

- Origin/main divergence with npm registry resolved (PR #266 rebase-merge): origin/main now matches the published `@jaggerxtrm/pi-extensions@0.7.25` source. Anyone cloning xtrm-tools fresh and using the local checkout no longer hits the silent `[serena-pool] pre-spawn ensure failed:` warning that came from missing source files.

### Notes for consumers

- Update path: `npm i -g xtrm-tools@0.8.0` then `xt update --apply` in each managed repo. The vendored `.xtrm/skills/default/` surface in the new tarball carries the bare-mode authoring documentation forward.
- This release also re-unifies workspace versions via the project's `sync:cli-version` prebuild hook: `xtrm-cli` and `@jaggerxtrm/pi-extensions` are also bumped to `0.8.0`. The 0.7.22 → 0.7.25 pi-extensions tarballs remain as historical patch releases for that sub-package; consumers depending on `@jaggerxtrm/pi-extensions@^0.7.21` automatically pick up 0.8.0.
- Existing v0.7.22 — v0.7.25 git tags remain pi-extensions sub-package release markers from the period when its version drifted from the root. Going forward, all three packages share the same version (root xtrm-tools / xtrm-cli / @jaggerxtrm/pi-extensions).

## [v0.7.25] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.25 — 2026-05-21

#### Fixed
- `serena-pool`: debug logging now passes the message as a separate console argument instead of interpolating it into the format string, satisfying the semgrep pre-push security gate. Supersedes the already-published npm-only v0.7.24 package for GitHub release purposes. (xtrm-sqo33)

## [v0.7.24] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.24 — 2026-05-21

#### Changed
- `xtrm-ui`: compact tool-result rows now use the lighter `›` marker instead of `•` for xtrm-ui-owned native and external compact summaries. The marker is centralized as `TOOL_ROW_MARKER`; external badge parsing accepts both old and new markers for compatibility, and prompt/input prefix behavior remains unchanged. (xtrm-0vda4)

## [v0.7.23] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.23 — 2026-05-21

#### Changed
- `serena-pool`: added ownership-based orphan cleanup for the shared Serena daemon. The extension records pid/pgid/start time under `/tmp/serena-pool`, reaps only process groups it owns after the recorded daemon is verifiably dead, and leaves unrelated editor/test/hook LSP processes untouched. (xtrm-zfw28)
- `serena-pool`: added `DEBUG=serena-pool` tracing and an e2e driver under `extensions/serena-pool/test/e2e.ts` to exercise shared-daemon startup and cleanup behavior. (xtrm-zfw28)

## [v0.7.22] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.22 — 2026-05-21

#### Added
- New `serena-pool` managed Pi extension. On `session_start`, it resolves the git repo root, maps that root to a deterministic local port, starts one shared Serena MCP daemon when needed, sets `SERENA_MCP_PORT` for `pi-serena-tools`, and keeps the daemon alive across Pi sessions so repeated tool calls do not spawn duplicate Serena servers. (xtrm-0nu9p)

## [v0.7.21]

This section bundles two independently-published releases under the same root version number; each subheading corresponds to a distinct npm package and publish date.

### `xtrm-tools` v0.7.21 — 2026-05-19

#### Added
- New `issue-triage` skill at `.xtrm/skills/default/issue-triage/`: bead board grooming pass using the full `bd dep --type` vocabulary (blocks, tracks, relates-to, parent-child, discovered-from, until, caused-by, validates, supersedes). Workflow phases: Snapshot → Cluster Discovery (mechanical + AI duplicate detection + explorer specialist for code-overlap + overthinker for synthesis) → Rewire (per-cluster confirm) → Verify (cycles/lint) → Handoff (triage report + optional P0 next-session pickup). Generates an executable `apply.sh` artifact alongside the triage bead so operators can review every mutation as a reviewable diff. Includes GitNexus inline reinforcement path (with explicit fallback flag when no index is available), a relationship-vocabulary cheat-sheet, pitfalls section, and an output checklist. Validated via two A/B eval iterations (10/10 vs no-skill baseline 9/10; 14/14 vs prior iteration 11/14). (xtrm-125p, xtrm-iank)

#### Changed
- `sp-terminal-overlay`: `/sp-ps` and `/xtrm-ps` now render a one-shot `sp ps` snapshot instead of defaulting to `sp ps --follow`; `--follow`/`-f` args are stripped so repainting dashboards do not loop indefinitely in the overlay. `/sp-feed` remains the streaming command. (xtrm-x76a)
- Vendored `using-specialists-v3` skill bumped to upstream `specialists` master (resolved_sha `68d81ec`). The "Dependency Linking" section is rewritten as "Dependency Linking And Relationship Vocabulary" with full `--type` semantics: orchestrators no longer overload `blocks` for follow-ups (`discovered-from`), root-cause links (`caused-by`), verification pairs (`validates`), duplicates (`supersedes`), or restitch replacements. Aligns with the new `issue-triage` skill's vocabulary table. (0ded9e6)
- `package.json` `files` whitelist now excludes `.xtrm/skills/default/*-workspace/**` so per-skill eval workspaces (created during A/B benchmarking under the skill-creator loop) are not pulled into `npm pack`. (xtrm-ph91)

#### Fixed
- `xtrm-ui` (carried from pi-extensions v0.7.21): native/standard Pi tools clear their pending call row as soon as the final tool result is received, avoiding the transient two-row flicker before compact rendering collapses to one row. See xtrm-a404.
- `xtrm-ui` (carried from pi-extensions v0.7.21): external tool background chrome aligns with native tool rows and colors only the displayed tool-name token with a non-bold dark-on-cold badge. See xtrm-bm43, xtrm-do9o.

### `@jaggerxtrm/pi-extensions` v0.7.21 — 2026-05-16

#### Fixed
- `xtrm-ui`: native/standard Pi tools (`bash`, `read`, `edit`, `write`, `find`, `grep`, `ls`) now clear their pending call row as soon as the final tool result is received, avoiding the transient two-row flicker before compact rendering collapses to one row. (xtrm-a404)
- `xtrm-ui`: external tool background chrome now aligns with native tool rows and colors only the actual displayed tool-name token with a non-bold dark-on-cold badge, leaving the bullet and result text unfilled. Bumped the internal external tool frame patch version so `/reload` replaces older prototype wrappers. (xtrm-bm43, xtrm-do9o)

## [v0.7.20] - 2026-05-15

### Added
- `@jaggerxtrm/pi-extensions`: new `sp-terminal-overlay` managed Pi extension with `/sp-feed`, `/sp-ps` (`/xtrm-ps` alias), and `/xtrm-terminal <command>` overlay commands for streaming specialist feed/dashboard output inside Pi. The overlay is centered, fixed-height, scrollable, throttles live redraws, and preserves safe SGR colors for append-style `sp feed` output. (xtrm-3e4n)

### Changed
- `xtrm-ui`: non-native/external tool output can now use selectable chrome via `/xtrm-ui chrome background|box` or `/xtrm-ui-external-chrome background|box`; background mode uses native-density rows with a cold badge on only the displayed tool-name token, while box mode keeps the tight framed style. `structured_return` and `process` now share the compact summary treatment used for Serena/GitNexus tools and retain expanded-output behavior. (xtrm-3e4n)
- Decision for GitHub #257: xtrm will not provision or track per-worktree dependency artifacts. `xt claude` / `xt pi` launch output and xtrm/specialist guidance now explain that clean git worktrees omit ignored directories such as `node_modules/` and `.venv/`, and instruct users to run the repo's normal bootstrap inside the worktree (`make bootstrap`, `just setup`, `npm ci`, `uv sync`, etc.) when lint/tests need those dependencies. (xtrm-tbih / #257)

## [0.7.19] - 2026-05-14

### Fixed
- `xt init`'s Project Bootstrap phase no longer leaves Skills Runtime in an `incomplete: active` state on a fresh repo. Bare `gitnexus analyze` (invoked by xt init) unconditionally writes 6 skills to `<project>/.claude/skills/gitnexus/<name>/SKILL.md`, and because xtrm makes `.claude/skills` a symlink to `.xtrm/skills/active/`, those writes landed as a non-symlink directory at `.xtrm/skills/active/gitnexus/` — breaking the flat-active-view invariant and tripping `hasOnlyValidSymlinkEntries` → `activeReady=false`. After `gitnexus analyze` returns, `runGitNexusInitForProject` now removes that polluting subdir (idempotent, try/catch wrapped). No functionality loss — the same gitnexus skills are already vendored as flat `gitnexus-cli`, `gitnexus-debugging`, etc. under `.xtrm/skills/default/` and symlinked into `active/`. Fresh-repo smoke now reports `✓ All phases verified successfully.` (5/5 green). (xtrm-wbfd / PR #252)

## [0.7.18] - 2026-05-14

### Added
- Security baseline pipeline: new GitHub Actions workflows for `gitleaks`, `semgrep`, and `osv-scanner` triggered on push and PR; project-level `.githooks/pre-commit` + `.githooks/pre-push` security mirrors with `.local` extension hooks; `.pre-commit-config.yaml` framework integration; `.gitleaks.toml`, `.semgrepignore`, and `.github/dependabot.yml`. New helper scripts `scripts/osv-diff.sh`, `scripts/semgrep-diff.sh`, `scripts/security-scan.sh`. (xtrm-6m4y / PR #206)
- Vendor freshness manifest committed at `.xtrm/specialists-source.json` so CI's `Verify specialists vendor freshness` step has a reference snapshot (was previously generated only at `prepublishOnly` time, leaving main CI red on every push). (PR #206)
- `xt doctor`: report global xt-managed Pi package health in text and JSON via `piPackages`, including missing, outdated, and version-unknown states with remediation; doctor remains report-only and never installs packages. (xtrm-modr)
- `xt update`: check global xt-managed Pi package freshness during dry-run and JSON output, and refresh only missing/outdated managed packages when `--apply` is used. (xtrm-5nwu)
- `xt update --root <dir>`: surface partial-install repos in the output. Directories under `<root>` that contain a `.xtrm/` folder but no `.xtrm/registry.json` are now reported with status `incomplete` and a remediation hint (run `xt init` or `xt install`). Previously these were silently skipped. New `scanXtrmRepos` helper exposes the split (`managed`, `incomplete`) for programmatic callers; `findManagedRepos` kept as a backward-compatible thin wrapper. (xtrm-asqq)
- `policies/beads.json`: wire `beads-compact-save.mjs` to `PreCompact` and `beads-compact-restore.mjs` to `SessionStart` so beads state survives Claude Code compaction; generated `.xtrm/config/hooks.json` carries a narrow wrapper-level `script` field for these entries only. (xtrm-4amc.5)
- `xtrm update --help` advertises the `init` alias so operators discover the unified entry point from either command. (xtrm-4amc.7)
- `xt status`: `--check` flag for non-interactive summary that never prompts. The inline sync prompt is also auto-skipped when stdin is not a TTY, so agents and CI can use `xt status` for a quick "is everything fine?" check without engaging the interactive multiselect. JSON output unchanged; interactive TTY behavior preserved. (xtrm-d3wx / PR #225)
- `prepublishOnly`: new `check:payload-hygiene` step runs `npm pack --dry-run` and fails the publish gate on (a) forbidden packed paths matching a denylist (`.xtrm/worktrees/`, `.pi/`, `.serena/`, `__pycache__/`, `*.log`, `*.db`, `*.sqlite*`, `workspace/`, `evals/`, `.specialists/jobs/`, `.specialists/db/`, `.beads/dolt/`, `.beads/backup/`, `.beads/issues.jsonl`) and (b) absolute-path leaks (`/home/*`, `/Users/*`, `file:///home/`, `file:///Users/`) in packed text content. Both checks always run and report independently. (xtrm-7xxz / PR #228, xtrm-zb9q / PR #230)
- **Release contract: cross-repo handshake with specialists.** New end-to-end gate chain that fails the npm publish if the vendored specialists payload drifts from upstream. (xtrm-9xg2 / PR #238, finalised in PR #239)
  - `.github/workflows/specialists-validation.yml`: triggered by `repository_dispatch` (type=`specialists-asset-validation`) from specialists' release-gate workflow, or manually via `workflow_dispatch`. Checks out specialists at the dispatched SHA and runs `scripts/verify-asset-contract.mjs` against `.xtrm/skills/default/`. Hard-fails if `using-specialists-v3` or `update-specialists` (must-have specialists-owned skills) are missing from the mirror or their sha256 drifts. (xtrm-cvjg)
  - `scripts/verify-asset-contract.mjs`: reads specialists' `dist/asset-contract.json` (sha256 manifest per shipped skill), filters by `docs/skills-ownership.json` owner=specialists, hashes each vendored file under `.xtrm/skills/default/<skill>/<basename>`, exits 1 on any drift. Skill name derived from `path.basename(path.dirname(entry.path))` — no `entry.skill` field exists.
  - `.github/workflows/install-order-matrix.yml`: 4-leg matrix (`xt-only`, `sp-only`, `xt-then-sp`, `sp-then-xt`) over `mktemp -d` repos validates the canonical install order. Each leg asserts the documented prerequisite error wording when sp init runs before xt init, and that no symlinks ever appear under `.xtrm/`. Helper at `scripts/__tests__/install-order-asserts.sh`. Operator-triggered only (third-party install behaviour outside release-contract scope; see docs/release.md). (xtrm-nogp / PR #238, xtrm-g20x for scope)
  - `.github/workflows/fresh-machine-smoke.yml`: end-to-end smoke that packs xtrm-tools + specialists via `npm pack`, installs both tarballs globally on a fresh ubuntu-latest runner, runs `xt init -y` + `xt doctor` + `xt update --apply` + `sp init/doctor/list` in a `mktemp -d` git repo. Reusable via `workflow_call` (used by `publish.yml`) and `workflow_dispatch` (operator). Assertions narrowed to release-contract invariants only: 3 must-have specialists skills land in the mirror, no symlink leaks, no `Source and destination must not be the same` regression. (xtrm-sn9t / PR #238, refined by xtrm-3qts / PR #243)
  - `.github/workflows/pre-publish-readiness.yml`: operator dry-run of the entire publish chain (resolve_ref → fresh_machine_smoke → publish_dry_run) minus the actual `npm publish`. All 6 publish gates run including `verify-asset-contract.mjs` and `npm pack --dry-run`. Green = safe to tag. (xtrm-a8x4 / PR #239)
  - `docs/release.md`: operator + agent release playbook. Architecture diagram, per-gate enforcement table, operator procedure, gate-specific recovery, 12 hard rules for agents touching release plumbing, runtime prerequisites (`sp` requires Bun), install-order-matrix scope clarification. (xtrm-a8x4 / PR #239)
- `.pi/settings.json` `.skills` array: installer now seeds **two** entries in resolution order — `../.xtrm/skills/active` (project-local, wins) and `~/.xtrm/skills/default` (user-level fallback). Without the fallback, specialist configs that reference skills not vendored into a project failed to resolve in pi (`validateBeforeRun` warnings). User-added entries between the two managed ones are preserved on `xt update`; idempotent. (xtrm-4h6u / PR #247)
- `installFromRegistry` now snapshots `packageRoot/.xtrm/registry.json` → `userXtrmDir/registry.json` after the file-by-file copy loop. Freshly init'd repos show as managed in `xt update --root` immediately — no manual `cp` from xtrm-tools. Skipped in dry-run. (xtrm-ya2i / PR #246, supersedes xtrm-tools-adh)
- `using-specialists-auto` vendored as a new specialists-owned skill in `.xtrm/skills/default/`; added to both `docs/skills-ownership.json` and `docs/skills-ownership.release.json`. (xtrm-lhqy / PR #239)

### Changed
- Pi runtime package assurance now uses the canonical xt-managed package inventory, including `npm:@jaggerxtrm/pi-extensions`, instead of a two-package allowlist. (xtrm-ppwi)
- Pi package freshness classification is centralized behind provider-injected helpers so commands can share deterministic missing/outdated/version-unknown behavior. (xtrm-basg)
- `scripts/gen-registry.mjs` no longer emits a `pi_extensions` asset for project scaffold; `packages/pi-extensions` is global-only install and is not copied into target projects' `.xtrm/`. Re-lands the fix from commit `452d961` lost during the 2026-05-09 integration restitch. (xtrm-xvjg)
- `session-close-report`: add paranoid cleanup, due-diligence, and CHANGELOG synchronization requirements so session handoffs include process cleanup, content audits, and consumer-facing changelog checks.
- `releasing`: update the release skill to drive releases end-to-end without relying on the deprecated `xt release` flow.
- `using-specialists-v3`: strengthen specialist orchestration guidance around runtime listing, file-layer discipline, security/code-sanity chains, monitoring, and worktree cleanup.
- `planning` skill: align Phase 4 with the `using-specialists-v3` 7-section bead contract (PROBLEM/SUCCESS/SCOPE/NON_GOALS/CONSTRAINTS/VALIDATION/OUTPUT). Affects every bead created by a planner specialist run going forward. (xtrm-bkgf)
- `transcriber` specialist migrated from `dashscope/qwen3.5-plus` to `nano-gpt/qwen/qwen3.5-397b-a17b-thinking` after dashscope provider was retired. Companion to specialists `unitAI-ght3j`.
- `prepublishOnly`'s `--specialists-ref` updated from the deleted `integration/2026-05-09-orchestrator` branch to `master` so the vendor step uses a live ref (vendor script's sibling-path fallback was masking the misconfiguration). (xtrm-m6yd)
- `package.json` `files`: add 3 negation entries (`!.xtrm/skills/default/**/evals/**`, `!.xtrm/skills/default/**/workspace/iteration-*/**`, `!packages/*/.serena/**`) so eval/workspace/.serena artifacts no longer ship in `npm pack`. `.npmignore` had identical patterns added first but turned out to be largely ignored when `files` is set; the negation form in `files` is the supported pattern in this repo. (xtrm-87b2 / PR #234, xtrm-0svb / PR #231)
- `scripts/gen-registry.mjs`: now reads `package.json` `files` negation entries and skips matching paths during registry generation, so `.xtrm/registry.json` stays in sync with the published pack contents. Closes the parity gap that surfaced when pack exclusions stopped matching the registry. (xtrm-y6sn / PR #234)
- `.github/workflows/publish.yml`: restructured into a 3-job DAG. `resolve_ref` reads `.source.resolved_sha` (preferred) or `.source.ref` from `.xtrm/specialists-source.json` via jq; `fresh_machine_smoke` is invoked via `workflow_call` with that pinned ref; `publish` job depends on both via `needs:` and runs the 6 gates (`check:skills-ownership`, `check:specialists-vendor` with explicit step-level `SPECIALISTS_REPO_PATH` env, `check:layout-guards`, `check:payload-hygiene`, `check:registry-pack-parity`, `verify-asset-contract.mjs`) before `npm publish --provenance`. Drift between vendored mirror and shipped specialists tarball is now impossible to ship by construction. (xtrm-2yn4 / PR #238, xtrm-nmiv, xtrm-8uox / PR #242)
- `scripts/vendor-specialists-skills.mjs`: now captures the supplied `--specialists-ref <value>` and writes both `source.ref` and `source.resolved_sha` (git HEAD of the specialists checkout at vendor time) into `.xtrm/specialists-source.json`. `publish.yml` reads `.source.resolved_sha` via jq, so the live specialists tarball used by `fresh_machine_smoke` matches the vendored mirror by construction — no more "is master still at the SHA I vendored against?" race. (xtrm-lhqy / PR #239)
- `cli/src/core/machine-bootstrap.ts`: `checkDep` now extends `process.env.PATH` with `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin` once on module load, so `spawnSync` finds binaries that were just installed in the same process. Fixes `xt init -y` bailing before the Project Bootstrap phase on fresh ubuntu-latest runners with a cached PATH that didn't include the install destinations. (xtrm-5k0o / PR #239)
- `cli/src/core/pi-runtime.ts`: `updatePiSettings` exported for direct testability; emits both `../.xtrm/skills/active` and `~/.xtrm/skills/default` in `.skills`; preserves user-added entries between the two managed paths; idempotent across repeated `xt update` runs. (xtrm-4h6u / PR #247)
- `scripts/check-payload-hygiene.mjs`: new `ABSOLUTE_PATH_LEAK_ALLOWLIST` (`CHANGELOG.md` + the hygiene script itself) suppresses self-trips when those files legitimately document absolute-path patterns. Forbidden-path scanning still applies to those files. (xtrm-h67r / PR #244)
- Workflow `run:` scripts no longer interpolate `${{ ... }}` github-context expressions inline. All instances rewritten to step-level `env:` blocks consuming `"$VARNAME"` (double-quoted), unblocking semgrep `yaml.github-actions.security.run-shell-injection`. Applies to `specialists-validation.yml`, `publish.yml`, `pre-publish-readiness.yml`, `fresh-machine-smoke.yml`. (xtrm-6cl8 / PR #238)
- `docs/cat-b-distribution.md` + `docs/skills-ownership.md`: refreshed specialist-owned skill lists (added `using-specialists-v3` + `using-specialists-auto`), mention the new asset-contract verification gate, document the vendor-script auto-write of `source.ref` + `source.resolved_sha`. (xtrm-so64 / PR #245)
- `.xtrm/skills/default/update-xt/SKILL.md`: refreshed for this session's installer changes — two-path pi skills expectation (xtrm-4h6u), `xt init` auto-seeding `registry.json` (xtrm-ya2i), worktree-build caveat (`npm run build` blocked inside `.xtrm/worktrees/`), `pnpm-workspace.yaml` row in the worktree artifact inventory (xtrm-ombq), and a new section **"Migrating a dev-linked project to a real consumer install"** with the full recipe for projects that have manually symlinked `.xtrm/skills/default` to npm-linked xtrm-tools. (xtrm-bmiq / PR #248)

### Fixed
- `xtrm-cli` workspace tarball startup no longer resolves package assets at import time, so temp-installed `xt` / `xtrm` `--version` and help commands work without a root `.xtrm/registry.json`; the workspace package is marked private while root `xtrm-tools` remains the canonical distributable. (xtrm-cplc)
- Pi runtime sync (`xtrm-n83y`) now installs `npm:pi-mcp-adapter` as a required managed Pi package, preventing Pi MCP startup blocks after `xt init` / `xt update` while still removing stale `~/.pi/agent/extensions/pi-mcp-adapter` extension overrides.
- `.beads/` is no longer committed as a self-referential symlink (introduced accidentally in PR #196); restored as a tracked directory with sensitive runtime files (`.beads-credential-key`, `interactions.jsonl`) properly gitignored, and `dolt.shared-server: true` added to `.beads/config.yaml` for parity with sibling projects. Fresh clones no longer fail with "too many levels of symbolic links". (xtrm-f3s2)
- `xtrm docs` (`list`, `verify`, `show`, `cross-check`): use `findProjectRoot()` instead of `findRepoRoot()` so the scanner respects the current project / fixture cwd rather than always traversing the xtrm-tools package source's `docs/`. (xtrm-4amc.1)
- `runProjectInit` throws an actionable `Compilation failed: ...` error when the source repo root cannot be resolved, instead of resolving to undefined and silently no-op'ing. (xtrm-4amc.7)
- `cli/src/utils/worktree-session.ts`: new `suppressBeadsWorktreeNoise` helper runs after the existing `.beads`-dir-to-symlink swap during worktree provisioning. Appends `.beads` to the per-worktree `<gitdir>/info/exclude` and runs `git update-index --skip-worktree` on tracked `.beads/*` files. Future `xt claude` / `xt pi` worktree checkpoint commits no longer carry 1.7k lines of phantom `.beads/` deletions, eliminating the manual commit-rewrite workaround for edit-capable specialists. (xtrm-nsca)
- `xt end`: new pre-push guard parses `git diff <upstream>..HEAD --raw -- .beads/` and aborts the push with an actionable error if any path under `.beads/` has destination mode `120000` (symlink). Defense-in-depth catches the case where prevention is bypassed (executors using `git add -A`, manual operator pushes, external scripts) so a `.beads` self-symlink can never be merged to a shipping branch. (xtrm-w1ip)
- `scripts/check-layout-guards.mjs` no longer flags itself as an offender. The script contains the staleActiveTiers strings by necessity to detect them in other files; added a self-reference to the `transientAllowlist`. Unblocks `npm run check:layout-guards` as a usable release gate. (xtrm-4kt0)
- Stale GitNexus "(N symbols, M relationships, K execution flows)" counter scrubbed from tracked `AGENTS.md` + `CLAUDE.md`; new `check:gitnexus-no-counter` build gate prevents the counter from being reintroduced by ad-hoc `gitnexus analyze` runs that bypass `--skip-agents-md --no-stats` (specialists supervisor already passes both since fd60db04). Wired into `prepublishOnly`. (xtrm-c6sf)
- `cli/src/utils/worktree-session.ts`: drop the `.beads` dir→symlink swap entirely. `launchWorktreeSession` now `rm -rf <worktree>/.beads` and marks the tracked `.beads/*` paths as `skip-worktree`. Modern bd 1.0.3 stores `core.hooksPath` as an absolute parent path at `bd init`, so the worktree inherits parent hooks via shared git config — no on-disk `.beads/` is needed, and bd resolves the DB via git common-dir. Removes a serious merge hazard: any branch carrying the worktree-local `.beads` symlink (mode 120000) wipes the parent's `.beads/` on squash-merge into main (real incident: projects/infra PR #39, 2026-05-12). Supersedes `xtrm-as7d` / `xtrm-nsca`. The `xt end` pre-push guard (xtrm-w1ip) stays in place as defense-in-depth for older clones and non-CLI push paths. (xtrm-cbjo)
- OSV dependency advisories cleared: removed unused `@artale/pi-procs`, removed bundled `tdd-guard` + `tdd-guard-vitest` dev deps (the Vitest TDD reporter is now opt-in via `tdd-guard-vitest` resolved-at-runtime), pinned Vite via the `cli/pnpm-lock.yaml` `overrides` block, declared `yaml` as a direct `cli/package.json` dependency (was previously hoisted from `tdd-guard`'s transitive tree — broke when tdd-guard was removed), refreshed lockfiles. OSV/audit/typecheck/tests all green post-changes. (xtrm-krk0 / PR #206)
- `scripts/scaffolder.py`: `ensure_legacy_symlink` no longer rejects every real caller. The previous confinement check required the legacy symlink's own location to live inside `pack_root`, but `scaffold_service_skill` deliberately places it at `<project>/.claude/skills/<service-id>` (sibling tree); every call raised `ValueError` after files + registry state were already written, leaving partial state. Dropped the misguided legacy-path check; the target-confinement check that prevents symlink escape via `..` or absolute paths is preserved. (xtrm-g41r / PR #220)
- `cli/src/utils/worktree-session.ts`: generalize `markBeadsSkipWorktree` → `markPathSkipWorktree(worktreePath, pathspec)` and invoke from `ensureWorktreeSpecialists` for `.specialists/default` + `.specialists/user`. Closes the parity gap with `xtrm-cbjo` — `.specialists/user/*` had the same dir→symlink merge-hazard shape (a chain branch capturing the swap would wipe parent specialist overrides on squash-merge). (xtrm-6jd2 / PR #221)
- `cli/src/commands/end.ts`: `findBeadsSymlinkIntroductions` pre-push guard now also flags mode-120000 introductions under `.specialists/*`, not just `.beads/*`. Error message and recovery hint generalized to cover both prefixes. (xtrm-6jd2 / PR #221)
- `cli/test/extensions/beads.test.ts` + `cli/test/extensions/custom-footer-parity.test.ts`: added `vi.mock` for `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` above the extension import so vitest doesn't fail the entire test file at module-load time. Those packages are Pi-provided runtime peers not in cli's `package.json`; CI's `npm install` never pulled them in. (xtrm-qdsx / PR #220)
- `cli/test/init-cli.test.ts`: bump per-test timeout to 60s for `xt init --yes bypasses confirmation and completes quickly`. The assertion is "no interactive prompt", not "fast"; wall-clock reaches ~28s on slow CI runners because `spawnSync` waits for the child after its internal 15s SIGTERM. (xtrm-qdsx / PR #220)
- `xt doctor`: resolve the project root via `findProjectRoot()` when `--cwd` is omitted, instead of using `process.cwd()` literally. Previously, running `xt doctor` from anywhere except the project root crashed with `ENOENT: no such file or directory, open '/.xtrm/registry.json'`. Explicit `--cwd <path>` still overrides; running outside any xtrm project now throws a clear `Not inside an xtrm project: …` error. (xtrm-sxug / PR #224)
- Pi runtime detection: `xt update` and `xt doctor` no longer report globally-installed xt-managed Pi packages as `state: missing, installedVersion: null`. The freshness path now falls back to the global npm root (resolved via `npm root -g`) when the agent-local `$PI_AGENT_DIR/npm/node_modules/<pkg>` path is absent, then chooses the agent-local path when both exist. Regression tests assert agent-local-wins and globally-installed scoped packages never report missing. (xtrm-ntf8 / PR #226)
- `cli/src/core/pi-runtime.ts`: 4 inline `// nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal` annotations for `path.join(agentDir, ..., npmPackageName, ...)` call sites. `npmPackageName` is sourced from the xt-managed allowlist constants (`XT_MANAGED_PI_PACKAGES`), not user input, so the semgrep finding is a false positive. Unblocks pre-push push of `xtrm-ntf8`. (xtrm-1hwe / PR #226)
- `cli/src/core/claude-runtime-sync.ts`: harden `resolveHooksForProjectRuntime` against single-object wrapper shape. The function previously assumed `wrappers` is always an array and called `wrappers.map(...)` directly; some upstream test was leaving `hooks.json` in `{event: { hooks: [...] }}` shape instead of `{event: [{ hooks: [...] }]}`, causing `install-integration.test.ts` to flake in full-suite runs. Now normalises with `Array.isArray(wrappers) ? wrappers : [wrappers as HookWrapper]`. Behavior on canonical array shape unchanged. (xtrm-0kgm / PR #227)
- `.gitignore` / `.pi/npm`: the host-specific `.pi/npm` self-referential symlink no longer gets re-committed by every executor that touches `.pi/`. Root cause: `.gitignore` had `.pi/npm/` (trailing slash matches **directory only**), but `.pi/npm` was a symlink — git treats symlinks as regular files, so the pattern silently never matched. Now lists both `.pi/npm` (symlink/file form) and `.pi/npm/` (directory form). `git rm --cached .pi/npm` removes the existing tracked entry. (xtrm-5kn1 / PR #235)
- Pi runtime: `resolveGlobalNpmRootDir()` is no longer shelled out per-package inside the freshness loop. `assureXtManagedPiPackages` and `getXtManagedPiPackageDoctorReport` now hoist the call to once-per-invocation, dropping the per-command `npm root -g` subprocess count from 8 to 1 (visible on machines where npm startup is slow). (xtrm-w6ey / PR #236)
- Multiple skill / runtime files cleaned of absolute-path leaks surfaced by the new `check:payload-hygiene` gate: `CHANGELOG.md` (`/home/<user>/.claude/hooks/...` → `~/.claude/hooks/...`), `hook-development/references/patterns.md` + `update-xt/SKILL.md` + `vaultctl/SKILL.md` (`/home/<user>/` → portable tokens), and `last30days/scripts/test-v1-vs-v2.sh` (`/Users/<user>/last30days-skill` → `$HOME/last30days-skill`, `/Users/<user>/.local/bin/claude` → `${CLAUDE_BIN:-$(command -v claude)}`; the latter is a net portability improvement since the original hardcoded paths only worked on the upstream author's machine). (xtrm-ykv4 / PR #233)
- `cli/src/commands/init.ts upsertManagedBlock`: regex switched from lazy `*?` to greedy `*` so duplicate-content + trailing-orphan-end-marker tails left behind by older versions get swept into the replacement. Previously only the first `start..end` pair was replaced, leaving a duplicate `# XTRM Agent Workflow` block + free-floating end marker in tracked AGENTS.md files. Visible in this repo until this PR — `AGENTS.md` cleaned in the same change (378 → 273 lines, single managed block). 6 regression tests in `cli/src/tests/upsert-managed-block.test.ts`. (xtrm-ya67 / PR #249)
- `skills/updating-service-skills/scripts/drift_detector.py`: pyright now reports 0 errors / 0 warnings via `typing.cast(str, project_root)` after the resolution dance plus `type:ignore[import-not-found]` on the dynamic `from bootstrap import ...` line. Unblocks pre-commit hooks in downstream projects where the script is vendored. (xtrm-2oho / PR #246)
- `.gitignore`: add `pnpm-workspace.yaml` (root + `cli/`). Specialist tooling occasionally shells out to pnpm in this npm-workspaces repo, generating a stray workspace file that executor checkpoint commits would silently stage into chain branches. (xtrm-ombq / PR #246)
- Workflow scripts now use `xt init -y` (the canonical non-interactive bootstrap) instead of the non-existent `xt install` subcommand. Earlier smoke runs failed with `error: too many arguments. Expected 0 arguments but got 1.` (xtrm-eb6y / PR #238)
- `install-order-matrix.yml` leg step: capture per-command exit codes and `trap dump_logs ERR` to print every `/tmp/{xt,sp}-*.{stdout,stderr,log}` on failure. Without this, the leg failed silently with no diagnostic when xt init bailed. Added `git init` + an empty bootstrap commit before `xt init -y` so the Project Bootstrap phase can run. (xtrm-dr1k / PR #238)
- `fresh-machine-smoke.yml`: scope narrowed to release-contract invariants only. `xt init`/`sp init` exit codes are captured and reported as `::warning::` (upstream package quirks like `@beads/bd` postinstall binary download or `oh-pi` exposing `oh-pi` instead of `pi` are outside the release contract). Validate step asserts: 3 must-have specialists skills in `.xtrm/skills/default/`, no symlinks under `.xtrm/`, no "Source and destination must not be the same" regression. (xtrm-3qts / PR #243, xtrm-gqiw / PR #240)
- `fresh-machine-smoke.yml` + `install-order-matrix.yml` now install Bun via `oven-sh/setup-bun@v2`. Specialists' `sp` binary uses `#!/usr/bin/env bun` (engines.bun ≥ 1.0.0). Without Bun on the runner, every `sp init/doctor/list` failed with `/usr/bin/env: 'bun': No such file or directory`. (xtrm-ss0j / PR #241)
- CHANGELOG.md: literal `/home/dawid/` + `/Users/mvanhorn/` placeholders inside an entry describing past leak fixes replaced with `/home/<user>/` / `/Users/<user>/` so the payload-hygiene gate doesn't trip on its own meta-documentation. (xtrm-h67r / PR #244)

## [0.7.17] - 2026-05-05

### Added
- Vendored `using-specialists-v3` skill from the specialists repo into `.xtrm/skills/default/`. The skill now ships in the npm tarball and is installed by `xt install` / `xt update` without requiring a specialists checkout.

### Changed
- `scripts/vendor-specialists-skills.mjs` includes `using-specialists-v3` in the canonical vendor list.
- Refreshed `using-specialists-v2/SKILL.md` from the specialists source.

## [0.7.16] - 2026-05-05

### Fixed
- `xt update` and `xt install` now repair a broken `.xtrm/skills/default` symlink before running the registry install. Previously only `xt init` repaired stale dev-mode symlinks, so updates failed on machines where the legacy symlink target no longer existed. The npm package root is always the source.

## [0.7.15] - 2026-05-05

### Changed
- Updated `using-xtrm` and `docs/XTRM-GUIDE.md` to document `xt update`, `xt release prepare/publish`, and same-day SSOT session report behavior.

## [0.7.14] - 2026-05-05

### Added
- `xt update` command with dry-run/apply modes, `--repo`, `--root`, JSON/human output, and multi-repo xtrm-managed asset refresh.
- `xt release prepare` and `xt release publish` command surface, with canonical xt report bundling in `cli/src/core/xt-reports.ts`.
- Versioned session reports under `.xtrm/reports/`, including the completed 2026-05-04 Cat B handoff report.

### Changed
- Cat B distribution now uses xtrm-tools as the npm distributor for filesystem-bound skills/hooks, while seven specialists-owned skills are vendored from the specialists repo at publish time.
- Skills runtime layout is flat: `.xtrm/skills/active/` is the single active view; stale per-runtime `active/claude` and `active/pi` assumptions were removed.
- `xt doctor` now reports Cat B skill/hook drift, runtime view readiness, duplicate canonical names, JSON output, and `--check-drift` CI behavior.
- `session-close-report` now updates the latest same-day SSOT report instead of creating duplicate reports for parallel orchestrators.
- Cat B migration docs now protect existing `.claude/skills` content and document the Windows stance.

### Fixed
- Annotated tag report date resolution now uses `git log -1 --format=%cs`, preventing empty xt report bundles for annotated tags.

## [0.7.1] - 2026-04-02

### Added

## [0.7.3] - 2026-04-04

### Changed
- **Pi extensions architecture**: Refactored from project-level copies to global symlink model. Extensions now live in `packages/pi-extensions/extensions/` (source of truth) and are symlinked to `~/.pi/agent/extensions/`. This eliminates project-level conflicts and worktrees no longer need extension bootstrap.
- **Directory rename**: `.xtrm/extensions/` renamed to `packages/pi-extensions/extensions/` to prevent Pi auto-discovery of project-level extensions (which would duplicate global symlinks).
- **Legacy path removal**: `.pi/node_modules/@xtrm/pi-core` deprecated; `@xtrm/pi-core` now lives in `packages/pi-extensions/src/core/`.
- **`docs/pi-extensions.md`**: Comprehensive rewrite documenting global symlink model, sync behavior, worktree compatibility, and active extensions (v2.0.0).
- **`docs/xtrm-directory.md`**: Updated directory layout to reflect `ext-src/` and global symlink architecture (v1.1.0).
- **`docs/xtrm-ui.md`**: Updated source paths from `packages/pi-extensions/extensions/` to `packages/pi-extensions/extensions/` (v1.2.0).

### Fixed
- **Worktree extension sync**: Extensions are now global symlinks — worktrees automatically share extensions with main repo without bootstrap or drift issues.
- **Pi runtime self-heal**: Launch-time repair now handles stale symlinks and orphaned extensions correctly.

- **`docs/skills-tier-architecture.md`**: New reference document covering three-tier skills model (default/optional/user), state.json schema, PACK.json schema, runtime active views, and xt skills CLI commands.
- **`docs/xtrm-directory.md`**: New reference document for centralized `.xtrm/` directory layout — skills, hooks, extensions, worktrees, reports, registry.json.
- **`docs/bash-tools.md`**: New reference for specialist bash CLIs (`ghgrep`, `ctx7`, `deepwiki`) including install source, usage examples, and CLI-vs-MCP guidance; README now links and surfaces `ghgrep` under capabilities.

### Changed
- **Optional packs install behavior docs**: Updated README + skills docs to reflect that `xt install` now pre-populates `.xtrm/skills/optional/`; packs are activated with `xt skills enable <pack>`.
- **Pi core resolution path docs**: Updated Pi architecture docs to reflect the new symlink location at `.xtrm/extensions/node_modules/@xtrm/pi-core` (replacing legacy `.pi/node_modules/@xtrm/pi-core`).
- **Default skills catalog docs**: Added `deepwiki`, `specialists-creator`, and `using-specialists` to default-skill listings in README and skills documentation.
- **`docs/skills.md`**: Rewritten to cover tier architecture, xt skills CLI, and updated skill catalog (v2.0.0).
- **`docs/cli-architecture.md`**: Updated skills.ts section — enable/disable/create-pack now fully implemented, added runtime flags documentation (v1.5.0).
- **`docs/skills-registry-exploration.md`**: Updated implementation status — Phase v0.9 pack lifecycle delivered, enable/disable/create-pack implemented (v1.2.0).
- **`docs/XTRM-GUIDE.md`**: Added xt skills section, fixed stale .agents/skills references.
- **`XTRM-GUIDE.md` (root)**: Fixed stale .agents/skills references in architecture diagram.

### Deprecated
- **`.agents/skills/`**: Documentation updated to reflect migration to `.xtrm/skills/` (see xtrm-directory.md).


## [0.7.0] - 2026-03-31

### Added
- **`xt report`**: Session close report CLI — `generate` collects git/bd/specialist data into a skeleton at `.xtrm/reports/`, `show`/`list`/`diff` for consumption. Agent fills `<!-- FILL -->` sections with session insights via the `session-close-report` skill.
- **`session-close-report` skill**: Structured handoff report workflow — agent generates skeleton, fills narrative sections from session context, produces a reference-quality technical handoff for the next agent.

---

## [0.5.45] - 2026-03-25

### Changed
- **`xt memory update`**: Replaced raw specialist stream with ora spinner + final summary output. Shows animated spinner while specialist runs; on finish prints `✓ .xtrm/memory.md written.` (or `✗`) followed by the last 10 meaningful lines dimmed.

---

## [0.5.44] - 2026-03-25

### Added
- **`xt help`**: `xtrm memory update` entry added to PRIMARY COMMANDS section.

---

## [0.5.43] - 2026-03-25

### Fixed
- Restore specialists project hooks in `.claude/settings.json` — incorrectly removed in 0.5.42

---

## [0.5.42] - 2026-03-25

### Fixed
- Remove accidentally committed specialists hooks from `.claude/settings.json` (reverted in 0.5.43 — see note)

---

## [0.5.41] - 2026-03-25

### Added
- **`xt memory update`**: New CLI command that shells out to the `memory-processor` specialist to synthesize bd memories + project state into `.xtrm/memory.md`. Supports `--dry-run` (report only) and `--no-beads` flags.
- **`memory-processor` specialist** (`specialists/memory-processor.specialist.yaml`): Autonomous specialist that cross-references bd memories against current source code, writes a condensed `.xtrm/memory.md` (100–200 lines, 3 sections: Architecture & Decisions, Non-obvious Gotchas, Process & Workflow Rules), and prunes stale/redundant/contradicted memories from bd.
- **`.xtrm/memory.md` injection at SessionStart**: `using-xtrm-reminder.mjs` now appends `.xtrm/memory.md` to the system prompt when present — synthesized project context is available from turn 1.
- **Pi parity — memory.md injection**: `xtrm-loader` Pi extension now injects `.xtrm/memory.md` in `before_agent_start` (same semantics as Claude Code SessionStart injection).
- **Pi parity — memory gate prompt**: `beads` Pi extension memory gate now uses the same 4-criteria checklist and articulated ack format as the Claude hook.

### Changed
- **`beads-memory-gate.mjs`**: Switched from blocking (exit 2 + stderr) to non-blocking (`additionalContext` + exit 0) — memory gate is advisory, not a hard stop.
- **`beads-stop-gate.mjs`**: Switched from blocking to non-blocking (`additionalContext` + exit 0) — eliminates spurious stop-gate noise between conversational turns.
- **Memory gate prompt** (`beads-gate-messages.mjs`): Now uses 4-criteria quality filter (hard to rediscover, non-obvious from source, will affect future decisions, still relevant in ~14 days) with mandatory articulated ack (not just `1`).

---

## [Legacy Unreleased]

### Added
- **Optional skill packs installed (commit `0e711e76`)**: added domain bundles under `.xtrm/skills/optional/` — `research-methods` (`brainstorming`, `academic-researcher`, `deep-research`, `fact-checker`), `code-quality` (`systematic-debugging`, `verification-before-completion`, `code-review-excellence`, `multi-reviewer-patterns`), `security-ops` (`security-auditor`), `data-engineering` (`data-analyst`), `architecture-design` (`architecture-patterns`, `subagent-driven-development`, `prompt-engineering-patterns`).
- gitnexus hook now fires on Grep/Read/Glob tools (parity with Pi); quality-check covers .cjs/.mjs files; quality gate env pre-check at SessionStart; policies.md rewritten from scaffold; using-xtrm SKILL.md rewritten; worktree-session migrated to bd worktree; branch state + xt end reminders in gate messages
- `xtrm docs cross-check` command suite documentation across README, guides, CLI help, and detailed docs reference
- docs: sync skills CLI docs — add xt skills to cli-architecture.md, update hooks.md dual-path resolution, mark Phase v0.8 DELIVERED in skills-registry-exploration.md (xtrm-ghgi)

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- v0.5.26 docs sync and Pi parity updates: quality gates, beads/session-flow lifecycle, using-xtrm loader parity, and policy-path normalization
- Pi installer parity: `xt pi setup` now matches `xt pi install/reload` for extension deployment; managed extensions use sync + auto-discovery and no longer use duplicate `pi install -l` registration
- Pi custom-footer now tracks Claude statusline parity with richer runtime/git snapshots and a two-line footer layout (metadata + issue row), including pi-dex-safe reapply behavior.
- Pi npm packages now install globally (no per-project .pi/npm/)

---

## [0.5.29] - 2026-03-22

### Added
- `skills/merge-prs/SKILL.md` and `specialists/merge-prs.specialist.yaml` for PR merge workflow
- Release script now encodes `--tag latest` for npm publish

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- Detect default branch via `symbolic-ref` + master fallback, replaced 9 hardcoded `origin/main` references
- Optimized Pi installer with pre-check and diff-based sync
- Statusline improvements: fixed sessionId fallback, fixed hardcoded icons, added statusline-claim to .gitignore

### Fixed
- **Autocommit now uses `--no-verify`**: both Claude hook (`beads-claim-sync.mjs`) and Pi extension (`beads/index.ts`) skip pre-commit hooks on automated `bd close` commits

---

## [0.5.20] - 2026-03-21

### Added
- **`xtrm docs show`**: New command to display frontmatter for README, CHANGELOG, and docs/*.md files with `--raw` and `--json` options
- **`worktree-boundary.mjs`**: PreToolUse hook that blocks Write/Edit outside `.xtrm/worktrees/<name>` when in worktree session
- **`worktree-boundary.json`**: Policy for worktree boundary enforcement
- **`statusline.mjs`**: Two-line status injection showing XTRM, model, branch, and claim state

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- **`beads-claim-sync.mjs`**: Now stages untracked files before auto-commit on `bd close`
- **Statusline format**: XTRM bold prepended, no hardcoded colors (theme-adaptive), issue ID shown before title in claim line

### Fixed
- **plugin.json sync**: `sync-cli-version.mjs` now syncs both root and plugin cache plugin.json files

---

## [0.5.0] - 2026-03-20

### Added

#### xt CLI Redesign (epic hxmh)
- **`xt` binary alias**: `xt` registered as a secondary bin alias for `xtrm`
- **`xt claude` / `xt pi` runtime namespaces**: Session launcher with worktree-first flow; creates `<project>-xt-<runtime>-<date>` worktree, Dolt-bootstraps Beads server, execs the agent
- **`xt claude install/reload/status/doctor`** and **`xt pi install/setup/status/doctor/reload`**: Per-runtime management subcommands
- **`xt end`**: Session close — `xt/*` branch gate, dirty-tree gate, rebase `origin/main`, `--force-with-lease` push, `gh pr create`, optional worktree removal
- **`xt worktree list/clean/remove`**: List `xt/*` worktrees with merged status, batch-clean merged, manual remove
- **`xt init`**: Project init command
- **`skills/xt-end/SKILL.md`**: Autonomous session-close skill for agents

#### Pi Extensions — Directory Package Format
- All 13 Pi extensions converted from flat `.ts` files to directory packages: `<name>/index.ts` + `<name>/package.json` with `exports` field
- Format: `{"name": "@xtrm/pi-<name>", "version": "1.0.0", "type": "module", "exports": {".": "./index.ts"}}`

#### Pi Installer Improvements
- `xtrm pi install` now registers each extension via `pi install -l <path>` after copying
- `diffPiExtensions` now compares extension directories using `sha256(package.json + index.ts)`

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

- **`xtrm install all` / `basic`** now print a deprecation notice; primary entry point is `xtrm install`
- **Project namespace removed**: `xtrm install project <name>` removed
- **Gemini/Qwen scoped out**: no longer surfaced in `xtrm --help`
- **`exitOverride` fix**: `--help` now exits `0` instead of `1`
- **Version restarted at `0.5.0`** (was `2.4.6`)

### Fixed

- **Pi extensions not loadable**: flat `.ts` files were silently ignored — Pi requires directory packages with `package.json` + `exports`
- **Claude-only target detection**: `xtrm install all` enumerates Claude Code targets only
- **Project-skill install-all coverage**: regression tests verify merged hook counts and copied assets

### Previous Unreleased

- **`AGENTS.md` — bd (beads) issue tracking section**: comprehensive `bd` CLI reference
- **`xtrm install project all` / `xtrm install project '*'`**: non-interactive project skill install

---

## [2.0.0] - 2026-03-12

### Added

#### Project Skills Engine
- **`cli/src/commands/install-project.ts`**: Generic "Plug & Play" project skill installer with deep merge for `settings.json` hooks
- **`cli/src/commands/help.ts`**: Self-documenting help command with full CLI reference
- **Project skills directory structure**: `project-skills/<skill>/.claude/` standard for modular tool packages

#### Project Skills (5 skills shipped)
- **`service-skills-set`**: Docker service expertise with SessionStart, PreToolUse, PostToolUse hooks
- **`tdd-guard`**: Test-Driven Development enforcement with PreToolUse, UserPromptSubmit, SessionStart hooks
- **`ts-quality-gate`**: TypeScript/ESLint/Prettier quality gate with `quality-check.cjs` (ported from bartolli/claude-code-typescript-hooks)
- **`py-quality-gate`**: Python ruff/mypy quality gate with `quality-check.py` (custom implementation)
- **`main-guard`**: Git branch protection with `main-guard.cjs` (blocks direct edits to main/master)

#### Installation Commands
- **`xtrm install`**: Global installation (replaces `sync`)
- **`xtrm install all` / `xtrm install '*'`**: Non-interactive global install across all known targets
- **`~/.agents/skills`**: Skills-only target added so the installed `skills/` tree is available without touching hooks/config
- **`xtrm install project all` / `xtrm install project '*'`**: Install every project-specific skill package into the current repository
- **`xtrm install project <tool-name>`**: Install project-specific skill package
- **`xtrm install project list`**: List available project skills with descriptions

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### CLI Rebranding
- **Package renamed**: `jaggers-agent-tools` → `xtrm-tools`
- **Binary renamed**: `jaggers-config` → `xtrm`
- **Version bumped**: 1.7.0 → 2.0.0 (breaking changes)

#### Command Restructure
- **`sync` command** → renamed to `install` with updated messaging
- **Default action**: Now shows help instead of running sync automatically
- **`add-optional` command**: Removed (optional MCP servers now part of `install`)

#### Architecture Decision
- **Claude Code only support**: Removed multi-agent hook translation for Gemini/Qwen
- **Focus**: Robust, well-tested Claude Code installation engine

### Removed

#### Multi-Agent Support
- **`cli/src/utils/transform-gemini.ts`**: Deleted (Gemini hook translation)
- **`cli/src/adapters/gemini.ts`**: Deleted (Gemini adapter)
- **`cli/src/adapters/qwen.ts`**: Deleted (Qwen adapter)
- **`transformToGeminiHooks`**, **`transformToGeminiFormat`**: Removed from `config-adapter.ts`
- **Gemini/Qwen command generation**: Removed from `sync-executor.ts`

#### Deprecated Commands
- **`jaggers-config add-optional`**: Superseded by `xtrm install`
- **`jaggers-config sync`**: Superseded by `xtrm install`

### Fixed

- **Project skills structure**: Standardized `.claude/settings.json` + `.claude/skills/` format
- **Hook paths**: Corrected `$CLAUDE_PROJECT_DIR` references in all project skills
- **Documentation**: README.md updated with accurate skill list and installation instructions

### Documentation

- **README.md**: Added Project Skills section, manual setup guide for Gemini/Qwen users
- **Updated installation instructions**: `npm install -g github:Jaggerxtrm/xtrm-tools` recommended
- **Each project skill**: Includes `README.md` and `SKILL.md` with usage guide

### Migration Guide

#### For Existing Users

```bash
# Old command (no longer works)
jaggers-config sync

# New command
xtrm install

# Global installation (recommended)
npm install -g github:Jaggerxtrm/xtrm-tools

# One-time run
npx -y github:Jaggerxtrm/xtrm-tools install
```

#### For Gemini/Qwen Users

Automated hook translation is no longer supported. See README.md "Manual Setup for Gemini/Qwen" section for manual configuration instructions.

---

## [1.7.0] - 2026-02-25

### Added

#### GitNexus Integration
- **Optional MCP server**: `gitnexus` added to `config/mcp_servers_optional.json` with auto-install support (`npm install -g gitnexus`)
- **PreToolUse hook**: `hooks/gitnexus/gitnexus-hook.cjs` — enriches Grep/Glob/Bash tool calls with knowledge-graph context via `gitnexus augment`
- **4 knowledge-graph skills**: `skills/gitnexus/{exploring,debugging,impact-analysis,refactoring}/SKILL.md` — synced via standard pipeline

#### Unified 3-Phase Sync Flow
- **`cli/src/core/preflight.ts`**: Parallel `Promise.all` preflight checks across all targets. Returns `PreflightPlan` with file diffs, MCP status, and optional server list. Per-target error isolation — one bad target never aborts the rest.
- **`cli/src/core/interactive-plan.ts`**: Single `prompts` multiselect plan — all targets, files, MCP servers, and optional servers in one view. `[~]` drifted and `[?]` optional items pre-unchecked by default.

#### MCP CLI Sync
- **`sync-mcp-cli.ts`**: Unified MCP CLI sync for Claude, Gemini, and Qwen via official `mcp add/remove/list` commands. Idempotent — re-running is always safe.
- **Env file management**: `~/.config/jaggers-agent-tools/.env` — auto-created on first sync, validates required env vars (e.g. `CONTEXT7_API_KEY`), preserves existing values.
- **ConfigAdapter enhancements**: Qwen and Antigravity support added; `type` field auto-handled per agent; `EnvVarTransformer` extended for cross-agent compatibility.

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Sync Command — 3-Phase Rewrite
- `cli/src/commands/sync.ts` fully rewritten: Phase 1 preflight spinner → Phase 2 multiselect plan → Phase 3 ordered execution (prerequisite installs → file sync → MCP sync → post-install messages)
- `--dry-run`: displays full plan grouped by target, prints "Dry run — no changes written", exits cleanly
- `-y`/`--yes`: auto-applies pre-checked defaults without prompting
- `--prune`: propagated through `plan.syncMode` to `executeSync` correctly
- `--backport`: reverses sync direction (local → repo)

#### sync-executor.ts
- Removed inline `promptOptionalServers` call and manifest-based prompt tracking
- Added `selectedMcpServers?: string[]` parameter — optional server names pre-selected upstream in Phase 2

#### MCP Configuration
- Split into `config/mcp_servers.json` (core: serena, context7, github-grep, deepwiki) and `config/mcp_servers_optional.json` (optional: unitAI, omni-search-engine, gitnexus)
- `_notes.install_cmd` and `_notes.post_install_message` metadata — drives Phase 3 auto-install
- Core servers: removed unused `filesystem`, `git`, `memory`, `gmail`, `yfinance-market-intelligence`
- `serena` command updated to uvx-from-git with auto project detection

#### Exported Symbols
- `getCurrentServers(agent)` and `AgentName` exported from `cli/src/utils/sync-mcp-cli.ts` (consumed by `preflight.ts`)

### Deprecated
- **`jaggers-config add-optional`**: now prints a redirect notice — optional servers are part of `jaggers-config sync`
- **JSON file sync for Claude/Gemini/Qwen MCP**: superseded by official `mcp` CLI method
- **Repo `.env` files**: use centralized `~/.config/jaggers-agent-tools/.env`

### Removed
- **Old Claude-specific sync**: `cli/lib/sync-claude-mcp.js` (replaced by unified `sync-mcp-cli.ts`)

### Fixed
- **`--prune` propagation**: `runPreflight` now sets `syncMode: 'prune'` when `--prune` passed (was hardcoded `'copy'`)
- **Optional server "already installed" filter**: now uses live `getCurrentServers()` call per agent instead of only checking core MCP names

### Documentation
- Updated SSoT: `ssot_jaggers-agent-tools_installer_architecture` → v1.4.0
- Updated SSoT: `ssot_cli_ux_improvements` → v2.0.0
- Updated SSoT: `ssot_cli_universal_hub` → v2.2.0
- Updated SSoT: `ssot_cli_mcp_servers` → v3.2.1

---

## [1.6.0] - 2026-02-24

### Added

#### Documenting Skill Hardening
- **`drift_detector.py`**: New script with `scan`, `check`, and `hook` subcommands — detects stale memories by cross-referencing `tracks:` globs against git-modified files
- **`tracks:` frontmatter field**: Each memory now declares which file globs it documents; added to schema, all templates, and all 11 existing memories
- **Intra-memory INDEX blocks**: `validate_metadata.py` now auto-generates a `<!-- INDEX -->` TOC table inside each memory from `##` headings + first-sentence summaries — allows agents to navigate without reading full documents
- **Stop hook**: `config/settings.json` wired with Stop hook → `drift_detector.py hook`; fires at session end, injects a one-line reminder only when stale memories detected (zero token cost when clean)
- **23 tests**: `test_validate_metadata.py` (4) and `test_drift_detector.py` (8, including `**` glob regression tests) added to existing suite

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- **`validate_metadata.py`**: INDEX generation now unconditional (no longer blocked by schema validation errors)
- **`SKILL.md` workflow**: Rewritten with drift-first 5-step protocol and decision table (new feature → SSOT, bug fix → changelog only, etc.)
- **All 11 existing memories**: `tracks:` globs added; INDEX blocks regenerated

### Fixed
- `extract_headings`: closing ` ``` ` was captured as section summary due to `in_code` toggle firing before capture check — fixed with `continue`
- `match_files_to_tracks`: `**/` expansion was producing `*.py` (too broad); replaced with recursive segment-by-segment `_match_glob` helper
- `inject_index`: frontmatter split hardened with anchored regex to prevent corruption on non-standard file openings
- `generate_index_table`: anchor generation collapsed consecutive hyphens from stripped `()/` chars

### Documentation
- Updated SSOT: `ssot_jaggers-agent-tools_documenting_workflow_2026-02-03` → v2.0.0

---

## [1.5.0] - 2026-02-23

### Added

#### Service Skills Set (`project-skills/service-skills-set/`)
- **Complete rewrite** of project-specific service skill infrastructure — replaces deprecated `service-skill-builder`
- **Trinity skills** installed into `.claude/skills/` of any target project:
  - `creating-service-skills` — 3-phase workflow: scaffold → Serena LSP deep dive → hook registration
  - `using-service-skills` — SessionStart catalog injection + PreToolUse skill enforcement
  - `updating-service-skills` — PostToolUse drift detection
- **Scripts**:
  - `scaffolder.py` — generates SKILL.md skeleton, script stubs, and auto-detects official docs from 30+ technology mappings (Docker images, requirements.txt, Cargo.toml, package.json)
  - `deep_dive.py` — prints Serena LSP-driven research protocol with tool table for Phase 2
  - `cataloger.py` — SessionStart hook; outputs ~150-token XML service catalog
  - `skill_activator.py` — PreToolUse hook; territory glob + Bash command matching; injects skill load enforcement
  - `drift_detector.py` — PostToolUse hook (`check-hook` stdin mode) + manual `check`, `sync`, `scan` subcommands
  - `bootstrap.py` — shared registry CRUD and project root resolution via git
- **Service registry**: `.claude/skills/service-registry.json` with territory globs, skill path, last sync
- **Git hooks** (`pre-commit`, `pre-push`): idempotent marker-based installation for SSOT reminder and skill staleness warning
- **Installer** (`install-service-skills.py`): single-purpose ~90-line script; copies trinity, merges settings.json hooks, activates git hooks; idempotent
- **Phase 3 — Hook Registration**: new phase in `creating-service-skills` workflow verifies PreToolUse wiring, confirms territory globs in registry, communicates auto-activation to user

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- Project structure: moved into `project-skills/service-skills-set/` with `.claude/` subdirectory
- `settings.json` PostToolUse hook moved to project-level (was only in skill frontmatter — now always-on)
- PreToolUse added to `settings.json` for territory-based skill auto-enforcement

### Fixed
- `allowed-tools` in skill frontmatter: corrected to Claude Code native tool names — removed invalid MCP/Serena names
- `SessionStart` removed from skill frontmatter (unsupported); moved to `settings.json`
- Removed `disable-model-invocation: true` from workflow skill and scaffolder template
- `project_root.glob()` type error in `bootstrap.py` fixed by wrapping with `Path()`

### Documentation
- Added `project-skills/service-skills-set/service-skills-readme.md`
- New SSOT memory: `ssot_jaggers-agent-tools_service_skills_set_2026-02-23`

---

## [1.4.0] - 2026-02-23

### Changed

#### Delegating Skill Hardening
- **Description rewrite**: Proactive language with trigger keywords (`tests`, `typos`, `refactors`, `code reviews`, `debugging`) — auto-discovery now fires without explicit "delegate" keyword
- **Frontmatter cleanup**: Removed unsupported fields (`version`, `gemini-command`, `gemini-prompt`); added `allowed-tools: Bash`
- **CCS nested session fix**: All CCS execution commands now use `env -u CLAUDECODE ccs {profile} -p "{task}"` — confirmed working inside Claude Code sessions
- **Interactive menu**: Replaced TypeScript `ask_user()` pseudocode with prose `AskUserQuestion` instructions

#### skill-suggestion.py Hook
- **Orchestration patterns**: Added `ORCHESTRATION_PATTERNS` — hook now fires for code reviews, feature implementation, debugging, security audits, commit validation
- **CLAUDECODE detection**: Hints correctly say "Gemini or Qwen directly" when running inside Claude Code (CCS unavailable), "CCS backend" otherwise
- **Security exclusion fix**: Narrowed `security` exclude pattern to only block auth/vuln *implementation* — security *reviews* now correctly route to orchestration

### Files Modified
- `skills/delegating/SKILL.md` — Description, frontmatter, pseudocode, CCS command
- `hooks/skill-suggestion.py` — Orchestration patterns, CLAUDECODE detection, security exclusion

### Documentation
- Updated SSOT: `ssot_cli_hooks_2026-02-03` → v1.1.0
- New SSOT: `ssot_jaggers-agent-tools_delegating_skill_2026-02-23` v1.0.0

---

## [1.3.0] - 2026-02-22

### Added

#### CLI UX Improvements (vsync-inspired)
- **Ora Spinners**: Visual feedback for all async operations (detect, diff, sync)
- **Enhanced Status**: Last sync time, item counts, health indicators, actionable hints
- **Single Confirmation**: Collect all changesets, display full plan, ask once
- **Drifted Items Feedback**: Report skipped drifted items post-sync with backport hint

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Safety Improvements
- **Prune Mode Guard**: Added `PruneModeReadError` — aborts if system read fails in prune mode
- **Repo Root Detection**: Dynamic detection via `findRepoRoot()` utility (walks up looking for `skills/` + `hooks/`)
- **Dry-Run Banner**: Moved from before target selection to after plan display
- **Error Handling**: Global handlers for clean error messages (no stack traces)
- **Ignored Items**: Filter `__pycache__`, `.DS_Store`, `node_modules` from diff scanning

### Dependencies
- Added `ora` for spinner UI

### Files Modified
- `cli/src/core/diff.ts` — Prune guard, ignored items filtering
- `cli/src/utils/repo-root.ts` — New utility
- `cli/src/commands/sync.ts` — Spinners, single confirm, feedback improvements
- `cli/src/commands/status.ts` — Enhanced output with timestamps
- `cli/src/core/manifest.ts` — Added `getManifestPath()`
- `cli/src/index.ts` — Global error handlers

### Documentation
- New SSOT: `ssot_cli_ux_improvements_2026-02-22.md`

---

## [1.2.0] - 2026-02-21

### Added

#### CLI: TypeScript Migration
- **Full TypeScript rewrite** of `cli/` — all modules ported from plain JavaScript ESM to strict TypeScript
- **Commander.js** replaces `minimist` for structured sub-command routing
- **Zod schemas** for runtime validation of `ChangeSet`, `SyncMode`, `Manifest`, `MCPServer`
- **Adapter Pattern** — `ToolAdapter` base class with `ClaudeAdapter`, `GeminiAdapter`, `QwenAdapter` implementations
  - `detectAdapter(systemRoot)` factory replaces scattered `includes('.claude')` checks codebase-wide
- **Rollback protection** — `core/rollback.ts` backs up every file before write; restores all on any failure
- **Hash-only diffing** — Pure MD5 comparison via `utils/hash.ts`; mtime used only as drift tie-breaker
- **`prepare` npm script** — auto-builds on `npm install`, restoring `npx github:Jaggerxtrm/jaggers-agent-tools` support
- **`vitest` test infrastructure** added to devDependencies (tests deferred, see `docs/plans/cli-testing.md`)

#### New sub-commands
- `jaggers-config sync [--dry-run] [-y] [--prune] [--backport]` — main sync
- `jaggers-config status` — read-only diff view (no file writes)
- `jaggers-config reset` — replaces `--reset` flag from old CLI

#### Windows Compatibility (baked in)
- `registry.ts` normalises backslashes before path matching
- `config-adapter.ts` uses `python` (not `python3`) on Windows for hook scripts
- `sync-executor.ts` falls back from symlinks to copy on Windows with a user warning

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- `cli/package.json` `bin` and root `package.json` `bin` now point to `cli/dist/index.js` (compiled output)
- `cli/package.json` `scripts` updated: `build` (tsup), `dev` (tsx), `typecheck` (tsc), `test` (vitest), `start` (node dist)
- Old `cli/index.js` and `cli/lib/*.js` preserved on disk but no longer referenced

### Fixed
- **Double-shebang bug** in tsup output — removed `banner` config, relying on tsup's auto-detection from `src/index.ts`

---

## [1.1.1] - 2026-02-03

### Added
- **Orchestrating Agents Skill**: Multi-model collaboration skill for Gemini and Qwen.
- **Handshaking Workflows**: Deep multi-turn loops (Collaborative Design, Adversarial Review, Troubleshoot Session).
- **Gemini Command Sync**: CLI support for synchronizing `.toml` commands and auto-generating them from skills.
- **Cross-Agent Interactivity**: Support for both Gemini (`ask_user`) and Claude (`AskUserQuestion`) interactive menus.
- Implement specialized Gemini slash commands (/delegate, /document, /prompt)
- Enable zero-cloning installation via npx github:Jaggerxtrm/jaggers-agent-tools
- Implement Vault Sync Architecture for non-destructive settings management. Protects local secrets, MCP servers, and auth data during sync. Includes atomic writes and dry-run mode.
- **Architecture Roadmap**: Document CLI architectural improvements in ROADMAP.md based on multi-agent orchestration findings (Transactional Sync, Manifest Versioning, Namespace Prefixes, Observability).

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- **CLI Enhancement**: Automatically transforms `SKILL.md` into Gemini `.toml` command files during sync.
- **Hook Migration**: Refined hook transformation logic for cross-agent compatibility.
- Update SSOT and CHANGELOG for cross-agent compatibility and CLI improvements
- Consolidate all v1.1.0 improvements: Zero-Cloning, Metadata-driven commands, and multi-turn orchestration
- **ROADMAP.md**: Added "CLI Architecture Improvements" section with 5 phases addressing transactional sync, versioning, collision detection, observability, and transformation refactoring.

### Fixed
- Fix hook execution timeouts by updating settings.json to use milliseconds and enhancing transform-gemini.js to handle unit mismatches and improve hook naming.
- Prevent redundant auto-generation of commands for core skills in CLI
- Fix hardcoded paths in settings.json during sync
- Fix ReferenceError in sync.js by adding missing import and verify via Qwen handshake

---

## [6.0.0] - 2026-02-01

### Added

#### `delegating` Skill (Unified)
- **New `delegating` skill** replaces `ccs-delegation`
- **Unified Backends**: Supports both CCS (cost-optimized) and unitAI (multi-agent workflows)
- **Configuration-Driven**: All logic defined in `config.yaml`
- **Auto-Focus**: Detects security/performance/quality focus from keywords
- **Autonomous Workflow Selection**: Claude picks optimal unitAI workflow based on patterns

### Removed

#### `ccs-delegation` Skill
- **Deprecated**: Fully replaced by `delegating` skill
- **Removed**: `skills/ccs-delegation` directory deleted

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Skill Suggestions Hook
- **Updated**: Suggests `/delegation` instead of `/ccs-delegation`
- **Renamed**: `skill-suggestion.sh` → `skill-suggestion.py` for Python implementation

---

## [5.1.0] - 2026-01-30

### Changed

#### Naming Convention Alignment
- **Skill `p` renamed to `prompt-improving`**
  - Updated skill directory: `~/.claude/skills/p` → `~/.claude/skills/prompt-improving`
  - Updated YAML frontmatter: `name: p` → `name: prompt-improving`
  - Updated trigger syntax: `/p` → `/prompt-improving`
  - Updated hook suggestions to reference `/prompt-improving`
  - Follows Claude's naming convention with `-ing` suffix for improved clarity

#### Breaking Changes
- **`/p` command no longer works** - Use `/prompt-improving` instead
- Users with muscle memory for `/p` will need to adapt to `/prompt-improving`
- Hook suggestions now display `/prompt-improving` in systemMessage

#### Migration Guide (5.0.0 → 5.1.0)
**For Users:**
- Replace all `/p "prompt"` invocations with `/prompt-improving "prompt"`
- Update any documentation or workflows referencing the `/p` skill

**For Backward Compatibility (Optional):**
If you prefer to keep `/p` working via symlink:
```bash
ln -s ~/.claude/skills/prompt-improving ~/.claude/skills/p
```

---

## [5.0.0] - 2026-01-30

### Added

#### Skills Enhancement
- **UserPromptSubmit Hook** (`~/.claude/hooks/skill-suggestion.sh`)
  - Proactive skill suggestions for `/p` and `/ccs` based on prompt analysis
  - Bilingual pattern matching (Italian + English)
  - Flexible synonym detection (e.g., "correggi|fix|sistema|repair")
  - Sub-100ms execution time, no LLM calls
  - Opt-in configuration via `settings.json`
  - Detects simple tasks (typo, test, refactor, docs) → suggests `/ccs`
  - Detects short/generic prompts → suggests `/p` for structure

#### Configuration
- **skillSuggestions config** in `settings.json`
  - `enabled: true` - Hook active by default
  - Can be disabled without restart
- **UserPromptSubmit hook registration** in `settings.json`
  - Timeout: 1s
  - Command: `~/.claude/hooks/skill-suggestion.sh`

#### Skill Features
- **AskUserQuestion dialogs** in `ccs-delegation` skill for interactive delegation choice
- **AskUserQuestion clarification** in `p` skill for ambiguous prompts (<8 words)

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Skill `p` (Prompt Improver)
- **SKILL.md**: Reduced from 118 to 64 lines (-46% size)
- **Simplified context detection**: From 10 categories to 3 (ANALYSIS, DEV, REFACTOR)
- **Removed multi-iteration improvement loop**: Single-pass processing only
- **Inline scoring heuristics**: Replaced complex quality metrics with simple keyword checks
- **Reference structure**: Merged prefill patterns into `xml_core.md` (+20 lines)

#### Skill `ccs-delegation`
- **SKILL.md**: Reduced from 486 to 151 lines (-69% size)
- **Keyword-based profile selection**: Replaced quantitative complexity scoring (0-10 scale)
  - Simple patterns: `typo|test|doc` → glm
  - Reasoning patterns: `analiz|think|reason` → gemini
  - Architecture patterns: `architecture|entire|codebase` → gemini
- **Bilingual support**: IT+EN keywords throughout (e.g., "correggi|fix", "aggiungi.*test|add.*test")
- **Simplified execution flow**: Detect → Ask → Select Profile → Execute (removed fallback chains)

#### Performance Improvements
- **Skill load time**: 5-8s → <1s (-80-85% reduction)
- **Total token overhead**: 155KB → 16KB (-90% reduction)
- **Pattern matching**: Extended from basic English to IT+EN with wildcards

### Removed

#### Skill `p` References (46KB total)
- `quality_metrics.md` (12.7KB, 511 lines) - Complex 0-100 scoring system
- `context_detection_rules.md` (10.4KB) - 10-category detection rules
- `prefill_patterns.md` (10KB) - Standalone prefill examples (merged into xml_core.md)
- `before_after_examples.md` (12.9KB) - Redundant examples

#### Skill `ccs-delegation` References (95KB total)
- `task_complexity_scoring.md` (14.4KB, 478 lines) - Quantitative complexity algorithm
- `smart_context_gathering.md` (16.6KB, 643 lines) - Multi-level context system
- `fallback_chain.md` (15.5KB) - Edge-case fallback handling
- `parallel_delegation.md` (17.1KB) - Multi-agent parallel execution
- `delegation_history_analysis.md` (15.7KB) - Learning/persistence system

### Fixed

#### Pattern Matching
- **Too rigid English-only patterns** → Extended to bilingual IT+EN with synonyms
- **Missing common terms** → Added: "rimuovi|remove", "modifica|modify", "sistema|repair"
- **Case sensitivity issues** → All patterns use case-insensitive matching (`grep -i`)

#### Hook Configuration
- **Hook script not executable** → Added `chmod +x` to deployment checklist
- **Missing skillSuggestions config** → Added to `settings.json` with `enabled: true`

---

## [4.2.0] - Pre-refactoring baseline

### Changed
#### Skills State Before Refactoring
- **Skill `p`**: 118 lines, 52KB references (9 files)
- **Skill `ccs-delegation`**: 486 lines, 103KB references (6 files)
- **Total overhead**: 155KB token cost per skill activation
- **Load time**: 5-8 seconds per skill invocation
