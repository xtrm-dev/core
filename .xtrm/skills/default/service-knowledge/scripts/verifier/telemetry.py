#!/usr/bin/env python3
"""Structured telemetry: one JSON line per invocation to stderr.

Shape (grep with ``component=verifier``):
    {timestamp, component, event, candidate_hash, current_hash, service_id,
     claim_count, verdict_counts_by_type, duration_ms}

Deliberately carries NO raw claim text and NO source content — only claim_id-level
aggregates and content hashes — so the line is safe to log anywhere.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .manifest import ClaimManifest

COMPONENT = "verifier"
EVENTS_REL = Path(".xtrm") / "state" / "service-knowledge" / "events.jsonl"


def _consumer_root() -> Path:
    """Best-effort consumer root for the jsonl side-channel."""
    override = os.environ.get("SERVICE_KNOWLEDGE_CONSUMER_ROOT")
    if override:
        return Path(override)
    return Path.cwd()


def _append_jsonl(record: dict) -> None:
    """Best-effort append to events.jsonl. Never raises into the caller."""
    try:
        path = _consumer_root() / EVENTS_REL
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
    except OSError:
        pass


def verdict_counts_by_type(manifest: ClaimManifest) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for claim in manifest.claims:
        bucket = counts.setdefault(claim.claim_type.value, {"PASS": 0, "CONFLICT": 0, "UNKNOWN": 0})
        bucket[claim.verdict.value] += 1
    return counts


def emit_run(manifest: ClaimManifest, duration_ms: float, stream=None) -> str:
    """Write the telemetry line to stderr (or ``stream``) and to events.jsonl; return it."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "component": COMPONENT,
        "event": "run",
        "candidate_hash": manifest.candidate_hash,
        "current_hash": manifest.current_hash,
        "service_id": manifest.service_id,
        "claim_count": len(manifest.claims),
        "verdict_counts_by_type": verdict_counts_by_type(manifest),
        "duration_ms": round(duration_ms, 3),
    }
    line = json.dumps(record, sort_keys=True)
    print(line, file=stream or sys.stderr)
    _append_jsonl(record)
    return line


class Timer:
    """Tiny wall-clock timer for the duration_ms field."""

    def __init__(self) -> None:
        self._start = time.perf_counter()

    def elapsed_ms(self) -> float:
        return (time.perf_counter() - self._start) * 1000.0
