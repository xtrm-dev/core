"""Turn state and prompt epoch from a Claude Code transcript tail (CORE-2594).

Fail-open by construction: anything unexpected yields state 'unknown', and the
monitor never delivers on 'unknown'. Only user/assistant/system rows decide;
other row types are skipped because new metadata rows appear every release.
The transcript layout is internal and undocumented: the drift guards turn a
silent mis-detection into 'unknown'.
"""
import json, os, re

TAIL = 262144          # first read: the last 256 KB
TAIL_MAX = 4194304     # widen to 4 MB when one long turn holds no user row

_NOT_PROMPT_PREFIX = ("<command-", "<local-command", "<task-notification", "<system-reminder", "<channel ", "[skill-suggest]")
_CONTROL = re.compile(r"^(continue|cont|go on|go ahead|proceed|carry on|keep going|next|yes|yep|yeah|ok|okay|k|do it|go|thanks|thank you|ty|nice|cool|perfect|great)( please| pls| now| then| on)?$")
_PEER = re.compile(r"^\s*(?:\[cross-agent message\b|\[from peer\b|Another Claude session\b|Coordinator\b|From\s+\S+|[\w.-]*coord[\w.-]*\s*(?:->|→|:)|\S+\s*(?:->|→)\s*\S+\s*:)", re.I)


def is_control_nudge(text):
    t = re.sub(r"\s+", " ", re.sub(r"[.!…]+$", "", text.strip().lower()))
    return len(t.split(" ")) <= 3 and bool(_CONTROL.match(t))


def is_peer_relay(text):
    return bool(_PEER.match(text))


def _text_of(row):
    c = (row.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _has_tool_result(row):
    c = (row.get("message") or {}).get("content")
    return isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)


def _parse(tail_bytes, cut):
    lines = tail_bytes.split(b"\n")
    if cut and len(lines) > 1:
        lines = lines[1:]  # the read began mid-file: the first line may be cut
    rows = []
    for raw in lines:
        raw = raw.strip()
        if raw:
            rows.append(json.loads(raw))
    return rows


def classify_rows(rows):
    """(state, reason): running | idle | unknown."""
    asst = [r for r in rows if r.get("type") == "assistant"]
    users = [r for r in rows if r.get("type") == "user"]
    if asst and not users:
        return "unknown", "drift:no-user-rows"
    if any("stop_reason" not in (r.get("message") or {}) for r in asst):
        return "unknown", "drift:no-stop_reason"
    for r in reversed(rows):
        ty = r.get("type")
        m = r.get("message") or {}
        if ty == "system":
            if r.get("subtype") == "turn_duration":
                return "idle", "turn_duration"
            continue
        if ty == "assistant":
            sr = m.get("stop_reason")
            if sr in ("end_turn", "max_tokens", "stop_sequence"):
                return "idle", "assistant:" + sr
            if sr in ("tool_use", None):
                return "running", "assistant:" + str(sr)
            return "unknown", "assistant:" + str(sr)
        if ty == "user":
            txt = _text_of(r)
            if "Request interrupted by user" in txt:
                return "idle", "interrupted"
            if r.get("isMeta") or txt.startswith("<local-command-"):
                continue
            return "running", "user"
    return "unknown", "no-significant-row"


def last_turn_start(rows):
    """The last row that starts a turn: a user row that is not meta and not a tool result."""
    for r in reversed(rows):
        if r.get("type") == "user" and not r.get("isMeta") and not _has_tool_result(r):
            return r
    return None


def eligible_prompt(row):
    """The prompt text if this turn-start row is something a person typed and a skill could help with, else (None, reason)."""
    if row is None:
        return None, "no_turn_start"
    origin = row.get("origin") or {}
    if (origin.get("kind") not in (None, "human")) or row.get("promptSource") == "system" or row.get("turnOrigin") not in (None, "human"):
        return None, "not_human"
    txt = _text_of(row).strip()
    if not txt:
        return None, "empty"
    if txt.startswith("/") or txt.startswith(_NOT_PROMPT_PREFIX):
        return None, "command"
    if is_peer_relay(txt):
        return None, "peer_relay"
    if is_control_nudge(txt):
        return None, "control_nudge"
    if len(txt) < 12:
        return None, "too_short"
    return txt, None


def tool_uses(rows):
    """[(tool_use id, tool name, file path or None)] for every tool call in the rows, oldest first."""
    out = []
    for r in rows:
        if r.get("type") != "assistant":
            continue
        c = (r.get("message") or {}).get("content")
        for b in c if isinstance(c, list) else []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                fp = inp.get("file_path") or inp.get("path")
                out.append((b.get("id"), str(b.get("name")), fp if isinstance(fp, str) else None))
    return out


def structured_context(tools):
    """PRD 12b: a small structured context for the classifier: the last few tool names and the files in play."""
    names = [t[1] for t in tools][-5:]
    files = []
    for _, _, fp in reversed(tools):
        if fp and fp not in files:
            files.append(fp)
        if len(files) >= 10:
            break
    return {"tools": names, "files": files[::-1]}


def snapshot(path, size, need_epoch=False):
    """Read the tail and return {state, why, epoch, row}. Never raises.

    The state needs only the last rows. The epoch is the last turn-start row, which on a
    long tool-heavy turn lies far behind the tail: need_epoch widens the read (to 4 MB)
    until that row is found. The delivery gate sets it; the cheap per-change scan does not."""
    w = TAIL
    try:
        while True:
            with open(path, "rb") as f:
                f.seek(max(0, size - w))
                data = f.read()
            rows = _parse(data, size > w)
            state, why = classify_rows(rows)
            start = last_turn_start(rows)
            if (why == "drift:no-user-rows" or (need_epoch and start is None)) and w < TAIL_MAX and w < size:
                w *= 4
                continue
            return {"state": state, "why": why, "epoch": (start or {}).get("uuid"), "row": start, "tools": tool_uses(rows)}
    except Exception as e:  # bad json, io: fail open
        return {"state": "unknown", "why": "exc:" + type(e).__name__, "epoch": None, "row": None, "tools": []}


def find_transcript(sid, home=None):
    import glob
    base = os.path.join(home or os.path.expanduser("~"), ".claude", "projects", "*", sid + ".jsonl")
    g = glob.glob(base)
    return g[0] if g else None
