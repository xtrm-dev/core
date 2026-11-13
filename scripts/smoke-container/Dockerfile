# Pre/post-release smoke-test container for the xtrm trio (xt / sp / xtmux).
# Build:  docker build -t xtrm-smoke scripts/smoke-container/
# Run:    docker run --rm xtrm-smoke ./verify.sh
FROM node:24-alpine

# bash      — verify.sh is bash (arrays, [[ ]]).
# git       — clones the three xtrm repos.
# sqlite    — xtmux observability db lives in SQLite.
# tmux      — the stage-5 live xtmux scenario needs a real server.
# jq        — snapshot assertions over registry.json / hooks.json.
# curl+unzip+tar — fetch the musl bun and beads binaries below.
# gcompat   — beads ships a glibc-linked binary; this is the musl shim for it.
# libstdc++ — bun runtime dependency.
RUN apk add --no-cache \
      bash git curl unzip jq sqlite tmux util-linux-misc \
      gcompat libstdc++ ca-certificates

# @jaggerxtrm/xtmux and @jaggerxtrm/specialists both run on Bun. The `bun` npm
# package ships a glibc binary that is ENOEXEC on musl, so install the official
# musl build. Pinned to xtmux's declared bun dependency.
#
# It lives in /opt, NOT /usr/local/bin: xtmux depends on the `bun` npm package,
# whose own `bun` bin link would otherwise overwrite this binary on every
# `npm i -g @jaggerxtrm/xtmux`. /opt/bun/bin goes first in PATH so the musl
# build always wins for `sp` (#!/usr/bin/env bun) and for verify.sh.
ARG BUN_VERSION=1.4.4
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) bun_arch=x64 ;; \
      arm64) bun_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}-musl.zip" -o /tmp/bun.zip \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && install -D -m 0755 /tmp/bun/*/bun /opt/bun/bin/bun \
 && rm -rf /tmp/bun /tmp/bun.zip \
 && /opt/bun/bin/bun --version
ENV PATH="/opt/bun/bin:${PATH}" \
    XTMUX_BUN="/opt/bun/bin/bun" \
    XTRM_SMOKE_BUN="/opt/bun/bin/bun"

# beads (`bd`) is the xtrm issue tracker and a hard dependency of xtmux-events.
# @beads/bd's postinstall download does not resolve on musl, so take the
# release binary directly (works via gcompat, verified at build time).
ARG BEADS_VERSION=1.1.0
RUN curl -fsSL "https://github.com/gastownhall/beads/releases/download/v${BEADS_VERSION}/beads_${BEADS_VERSION}_linux_${TARGETARCH:-amd64}.tar.gz" -o /tmp/beads.tgz \
 && tar -xzf /tmp/beads.tgz -C /tmp bd \
 && install -m 0755 /tmp/bd /usr/local/bin/bd \
 && rm -f /tmp/beads.tgz /tmp/bd \
 && bd version

# git needs an identity for the stage-4 drift commits.
RUN git config --global user.email smoke@xtrm.local \
 && git config --global user.name  "xtrm smoke" \
 && git config --global init.defaultBranch main \
 && git config --global advice.detachedHead false

WORKDIR /smoke
COPY verify.sh ./
RUN chmod 0755 verify.sh

# Root is deliberate: the harness exists to exercise the documented
# `npm i -g` global-install path into /usr/local, plus `xt init` writing to
# $HOME. The image is an ephemeral local test subject — it serves nothing,
# exposes no port, and is discarded with `docker run --rm`.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["./verify.sh"]
