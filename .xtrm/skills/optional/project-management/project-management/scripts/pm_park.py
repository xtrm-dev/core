#!/usr/bin/env python3
"""Park a long-idle lead and wake it later: a durable timer, a digest, a fresh session in the same worktree.

A session that only waits for hours holds memory for nothing. `park` records it and sets one systemd user timer;
the caller then closes its pane. `wake` (run by the timer) decides whether the wake is due, passes the launch
preflight gate, writes a digest, opens a tmux window in the same worktree, starts a FRESH session of the same runtime
with the same name and role, and pastes the respawn nudge. The record is $PM_STATE_DIR/parked/<name>.json; the
record and the Substrate journal of <ref> are the only memory: the timer is a systemd unit, so it outlives every session.

  pm_park.py park NAME --ref REF --role ROLE (--at UTC | --check CMD --deadline UTC) [--self --manager-told]
                 [--reason TEXT] [--every SECONDS] [--worktree DIR] [--runtime claude|pi] [--pane ID] [--model M]
  pm_park.py wake NAME [--force]        run by the timer: check, gate, digest, launch, nudge
  pm_park.py list [--json]              parked sessions: wake spec, unit, state

park refuses unless: a handoff entry by NAME is its last entry on REF; --self comes with --manager-told (the lead has
told the manager); a wake is set. With --check, CMD exit 0 wakes, 1 means not yet (the timer fires again every
--every seconds), any other exit, a timeout or a passed --deadline wakes anyway and says so. The check is stored and
journaled verbatim: it must not contain credentials. All times are UTC.
The agent never starts from the timer directly: always inside a tmux window. Settings (pm_config, PM_ prefix):
park_launch (command that starts the runtime; default `claude --dangerously-skip-permissions` or `pi`),
park_max_attempts (3), park_retry_s (300), park_nudge_delay_s (20), park_check_timeout_s (120), and the gate limits
park_gate_load1 (15), park_gate_psi_full (10), park_gate_mem_gb (4).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402
import pm_role  # noqa: E402
import pm_session  # noqa: E402

UNIT_PREFIX = "pm-park-"
LIVE_STATES = ("parked", "waking")
GATE_LOAD1, GATE_PSI_FULL, GATE_MEM_KB = 15.0, 10.0, 4 * 1024 * 1024
PROC = "/proc"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
LAUNCH_DEFAULT = {"claude": "claude --dangerously-skip-permissions", "pi": "pi"}
LAUNCH_ROLE = {"board_helper": "board-helper"}
PASS_ENV = ("PATH", "PM_CONFIG", "PM_PROJECT", "PM_STATE_DIR", "TMUX_TMPDIR")
SCRIPT = pathlib.Path(__file__).resolve()


class ParkError(Exception):
    pass


# --- primitives (tests replace run, now, sleep) ---------------------------------------------------------------------

def run(args: list[str], input: str | None = None, timeout: int = 60) -> subprocess.CompletedProcess:
    """One subprocess call; a missing binary or a timeout is a result, never an exception."""
    try:
        return subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", "timed out")
    except OSError as exc:
        return subprocess.CompletedProcess(args, 127, "", str(exc))


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def sleep(seconds: float) -> None:
    time.sleep(seconds)


def fmt(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(text: str) -> dt.datetime:
    s = str(text).strip().replace(" ", "T", 1)
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        raise ParkError(f"time {text!r} is not an ISO UTC time (example 2026-11-22T15:30:00Z)")
    return t.replace(tzinfo=dt.timezone.utc) if t.tzinfo is None else t.astimezone(dt.timezone.utc)


def setting_int(name: str, default: int) -> int:
    try:
        return int(str(pm_config.get(name, default)))
    except (ValueError, SystemExit):
        return default


def setting_float(name: str, default: float) -> float:
    try:
        return float(str(pm_config.get(name, default)))
    except (ValueError, SystemExit):
        return default


def sb_bin() -> str:
    return str(pm_config.get("PM_SB_BIN", "sb"))


# --- state ----------------------------------------------------------------------------------------------------------

def parked_dir() -> pathlib.Path:
    return pm_config.state_dir() / "parked"


def record_path(name: str) -> pathlib.Path:
    return parked_dir() / f"{name}.json"


def load(name: str) -> dict:
    try:
        return json.loads(record_path(name).read_text())
    except (OSError, ValueError):
        raise ParkError(f"no park record for {name!r} at {record_path(name)}")


def save(rec: dict) -> None:
    path = record_path(rec["name"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(rec, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def records(states: tuple[str, ...] | None = None) -> list[dict]:
    out = []
    for p in sorted(parked_dir().glob("*.json")):
        try:
            rec = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if states is None or rec.get("state") in states:
            out.append(rec)
    return out


def wake_text(rec: dict) -> str:
    w = rec["wake"]
    if w.get("at"):
        return f"at {w['at']}"
    return f"check `{w['check']}` every {w['every']}s, deadline {w['deadline']}"


# --- Substrate ------------------------------------------------------------------------------------------------------

def journal_entries(ref: str) -> list[dict]:
    r = run([sb_bin(), "journal", "show", ref, "--tail", "500", "--json"])
    if r.returncode != 0:
        raise ParkError(f"sb journal show {ref} failed: {(r.stderr or r.stdout).strip()[:200]}")
    try:
        data = json.loads(r.stdout).get("data") or []
    except ValueError:
        raise ParkError(f"sb journal show {ref} returned no JSON")
    return sorted(data, key=lambda e: e.get("sequence", 0))


def journal_append(ref: str, kind: str, summary: str) -> int | None:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump({"summary": summary}, fh)
    try:
        r = run([sb_bin(), "journal", "append", ref, "--kind", kind, "--semantic", fh.name])
    finally:
        os.unlink(fh.name)
    m = re.search(r"seq\s+(\d+)", r.stdout or "")
    return int(m.group(1)) if r.returncode == 0 and m else None


def handoff_guard(name: str, ref: str) -> int:
    """Seq of the handoff that ends `name`'s entries on `ref`; refuse when its last entry there is anything else."""
    mine = [e for e in journal_entries(ref) if e.get("participantId") == name]
    if not mine:
        raise ParkError(f"refused: {name} has no journal entry on {ref}; write a handoff entry first "
                        f"(sb journal append {ref} --kind handoff)")
    last = mine[-1]
    if last.get("kind") != "handoff":
        raise ParkError(f"refused: the last entry of {name} on {ref} is seq {last.get('sequence')} kind "
                        f"{last.get('kind')}, not a handoff; write the handoff entry after your last action")
    return int(last["sequence"])


# --- park -----------------------------------------------------------------------------------------------------------

def unit_name(name: str) -> str:
    return UNIT_PREFIX + re.sub(r"[^A-Za-z0-9_.-]", "-", name)


def timer_cmd(rec: dict) -> list[str]:
    w, unit = rec["wake"], rec["unit"]
    cmd = ["systemd-run", "--user", "--unit", unit, "--collect", "--description", f"pm_park wake {rec['name']}",
           "--timer-property=AccuracySec=1s",
           "--property=KillMode=process"]  # a tmux server the wake starts must outlive the wake unit
    for key in PASS_ENV:
        if os.environ.get(key):
            cmd.append(f"--setenv={key}={os.environ[key]}")
    cmd.append("--setenv=SUBSTRATE_HOLDER=pm_park")  # the wake and failure entries are attributed to the tool, not a person
    if w.get("at"):
        cmd.append("--on-calendar=" + parse_utc(w["at"]).strftime("%Y-%m-%d %H:%M:%S UTC"))
        cmd.append(f"--on-unit-inactive={rec['retry_s']}s")
    else:
        cmd += [f"--on-active={w['every']}s", f"--on-unit-inactive={w['every']}s"]
    return cmd + [sys.executable, str(SCRIPT), "wake", rec["name"]]


def tmux_fact(pane: str, fmt_: str) -> str | None:
    r = run(["tmux", "display-message", "-p", "-t", pane, fmt_])
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def park(a: argparse.Namespace) -> int:
    if not NAME_RE.match(a.name):
        raise ParkError(f"name {a.name!r} must match {NAME_RE.pattern}")
    if bool(a.at) == bool(a.check):
        raise ParkError("refused: set exactly one wake: --at <UTC> or --check '<cmd>' with --deadline <UTC>")
    if a.check and not a.deadline:
        raise ParkError("refused: --check needs --deadline <UTC>; a check alone could wait for ever")
    if a.at and a.deadline:
        raise ParkError("refused: --deadline goes with --check only")
    if not a.self and a.name == os.environ.get("SUBSTRATE_HOLDER"):
        a.self = True  # the parked session is the caller: omitting --self does not bypass the manager rule
    if a.self and not a.manager_told:
        raise ParkError("refused: --self needs --manager-told: tell the manager (route_target.py manager) you park "
                        "yourself and until when, then add the flag (operator ruling 2026-11-22)")
    if a.role not in pm_role.ROLES:
        raise ParkError(f"role must be one of {', '.join(pm_role.ROLES)}")
    t0 = now()
    wake: dict = {"at": None, "check": None, "deadline": None, "every": None}
    if a.at:
        wake["at"] = fmt(parse_utc(a.at))
        if parse_utc(a.at) <= t0:
            raise ParkError(f"refused: --at {wake['at']} is not in the future (now {fmt(t0)})")
    else:
        wake.update(check=a.check, deadline=fmt(parse_utc(a.deadline)), every=max(30, a.every))
        if parse_utc(a.deadline) <= t0:
            raise ParkError(f"refused: --deadline {wake['deadline']} is not in the future (now {fmt(t0)})")
    old = record_path(a.name)
    if old.exists() and load(a.name).get("state") in LIVE_STATES:
        raise ParkError(f"refused: {a.name} is already parked ({old}); wait for the wake or stop unit "
                        f"{unit_name(a.name)}.timer and set the record state to cancelled")
    handoff_seq = handoff_guard(a.name, a.ref)

    worktree = a.worktree
    pane = a.pane
    if not (worktree and pane):
        try:
            import route_target
            found = route_target.find(a.name)
            if found:
                pane = pane or found.get("pane")
                worktree = worktree or next((s.get("cwd") for s in route_target.sessions()
                                             if route_target.address(s) == found["address"]), None)
        except Exception:  # noqa: BLE001 - the host is optional; the flags give the same facts
            pass
    worktree = worktree or os.getcwd()
    if not pathlib.Path(worktree).is_dir():
        raise ParkError(f"refused: worktree {worktree} is not a directory")
    session = tmux_fact(pane, "#{session_name}") if pane else None
    rec = {"name": a.name, "role": a.role, "ref": a.ref, "worktree": str(pathlib.Path(worktree).resolve()),
           "runtime": a.runtime, "model": a.model, "tmux_target": f"{session}:" if session else None,
           "pane_id": pane, "park_time": fmt(t0), "handoff_seq": handoff_seq, "park_seq": None, "wake": wake,
           "reason": a.reason, "self": bool(a.self), "unit": unit_name(a.name), "state": "parked", "attempts": 0,
           "gate_waits": 0, "retry_s": setting_int("PM_PARK_RETRY_S", 300), "wake_time": None, "wake_cause": None,
           "wake_pane": None}
    try:
        previous = old.read_bytes()
    except OSError:
        previous = None
    save(rec)
    r = run(timer_cmd(rec))
    if r.returncode != 0:
        if previous is None:
            record_path(a.name).unlink(missing_ok=True)
        else:
            old.write_bytes(previous)  # keep the earlier (terminal) record when the new timer cannot be set
        raise ParkError(f"refused: systemd-run failed ({r.returncode}): {(r.stderr or r.stdout).strip()[:300]}")
    rec["park_seq"] = journal_append(a.ref, "note", (
        f"park: {a.name} ({a.role}) parked {fmt(t0)} UTC after handoff seq {handoff_seq}; wake {wake_text(rec)}; "
        f"reason: {a.reason}; unit {rec['unit']}.timer. Peers: write to the journal of {a.ref}, not to its socket."))
    save(rec)
    print(f"parked {a.name} ({a.role}) on {a.ref}; wake {wake_text(rec)}; unit {rec['unit']}.timer; "
          f"record {record_path(a.name)}; park journal seq {rec['park_seq']}")
    print(f"next: verify the record, then close the pane yourself: {pane or '(pane id unknown: close your own pane)'}")
    print("then: one Jira comment for the whole park batch through the board helper")
    return 0


# --- wake -----------------------------------------------------------------------------------------------------------

def gate() -> tuple[bool, str]:
    """The launch preflight gate: load1 <= 15, PSI memory full avg10 <= 10, MemAvailable >= 4 GB."""
    try:
        load1 = float(pathlib.Path(PROC, "loadavg").read_text().split()[0])
        full = re.search(r"^full avg10=([0-9.]+)", pathlib.Path(PROC, "pressure", "memory").read_text(), re.M)
        psi = float(full.group(1)) if full else 0.0
        avail = int(re.search(r"^MemAvailable:\s+(\d+)", pathlib.Path(PROC, "meminfo").read_text(), re.M).group(1))
    except (OSError, ValueError, AttributeError, IndexError) as exc:
        return False, f"gate unreadable ({type(exc).__name__}); treated as shut"
    line = f"load1={load1} psi_full_avg10={psi} mem_available_gb={avail / 1048576:.1f}"
    ok = (load1 <= setting_float("PM_PARK_GATE_LOAD1", GATE_LOAD1) and psi <= setting_float("PM_PARK_GATE_PSI_FULL", GATE_PSI_FULL)
          and avail >= setting_float("PM_PARK_GATE_MEM_GB", GATE_MEM_KB / 1048576) * 1048576)
    return ok, line


def decide(rec: dict, force: bool) -> tuple[bool, str, str | None]:
    """(wake now?, cause, note). Only a check that answers 1 before its deadline is 'not yet'."""
    w, t = rec["wake"], now()
    if force:
        return True, "forced by hand", None
    if w.get("at"):
        if t >= parse_utc(w["at"]):
            return True, f"scheduled time {w['at']} reached", None
        return False, "scheduled time not reached", None
    if t >= parse_utc(w["deadline"]):
        return True, "deadline passed", f"deadline {w['deadline']} passed before the check answered 0"
    timeout = setting_int("PM_PARK_CHECK_TIMEOUT_S", 120)
    r = run(["sh", "-c", w["check"]], timeout=timeout)
    if r.returncode == 0:
        return True, "check passed", None
    if r.returncode == 1:
        return False, "check answered 1 (not yet)", None
    if r.returncode == 124 and r.stderr == "timed out":
        return True, "check error", f"check timed out after {timeout}s"
    return True, "check error", f"check exited {r.returncode}: {(r.stderr or r.stdout).strip()[:160]}"


def truncate(text: str, n: int = 400) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n] + " ..."


def digest(rec: dict, woken: dt.datetime, cause: str) -> pathlib.Path:
    ref, name = rec["ref"], rec["name"]
    out = [f"# Park digest for {name} ({rec['role']}) on {ref}", "",
           f"Parked {rec['park_time']} UTC (journal seq {rec['park_seq']}, handoff seq {rec['handoff_seq']}); "
           f"woken {fmt(woken)} UTC; cause: {cause}.", "", f"## sb issue resume {ref}", ""]
    r = run([sb_bin(), "issue", "resume", ref])
    out.append(r.stdout.strip() if r.returncode == 0 else f"(unavailable: {(r.stderr or r.stdout).strip()[:200]})")
    out += ["", f"## Journal entries on {ref} since the park (seq > {rec['park_seq'] or rec['handoff_seq']})", ""]
    try:
        since = int(rec["park_seq"] or rec["handoff_seq"])
        new = [e for e in journal_entries(ref) if e.get("sequence", 0) > since]
        out += [f"- seq {e['sequence']} {e.get('kind')} by {e.get('participantId')}: "
                f"{truncate((e.get('semantic') or {}).get('summary', ''))}" for e in new] or ["- none"]
    except ParkError as exc:
        out.append(f"(unavailable: {exc})")
    out += ["", f"## Answers inbox rows naming {name}", ""]
    rows = []
    try:
        for line in pm_config.answers_inbox().read_text().splitlines():
            if re.search(r"(?<![\w.-])" + re.escape(name) + r"(?![\w.-])", line):
                rows.append("- " + truncate(line))
    except OSError:
        pass
    out += rows[-20:] or ["- none"]
    out += ["", f"## Pull requests merged since {rec['park_time']}", ""]
    slug = pm_config.get("PM_REPO_SLUG")
    if not slug:
        out.append("(repo_slug is not configured)")
    else:
        r = run(["gh", "pr", "list", "--repo", str(slug), "--state", "merged", "--search",
                 f"merged:>={rec['park_time']}", "--json", "number,title,mergedAt,url", "--limit", "50"])
        try:
            prs = json.loads(r.stdout) if r.returncode == 0 else None
        except ValueError:
            prs = None
        if prs is None:
            out.append(f"(unavailable: {(r.stderr or r.stdout).strip()[:200]})")
        else:
            out += [f"- #{p['number']} {truncate(p['title'], 120)} ({p.get('mergedAt')}) {p.get('url')}"
                    for p in prs] or ["- none"]
    path = parked_dir() / f"{name}.digest.md"
    path.write_text("\n".join(out) + "\n")
    return path


def nudge_text(rec: dict, woken: dt.datetime, cause: str, note: str | None, digest_path: pathlib.Path) -> str:
    refs = SCRIPT.parent.parent / "references" / f"{rec['role']}.md"
    role_file = str(refs) if refs.is_file() else f"the {rec['role']} role file of the project-management pack"
    kit = SCRIPT.parent / "pm_session.py"
    route = SCRIPT.parent / "route_target.py"
    return "\n".join([
        f"[pm_park wake {rec['name']}] You were respawned after a pause: a fresh session, not a resume of the old one.",
        f"Parked {rec['park_time']} UTC, woken {fmt(woken)} UTC. Reason for the pause: {rec['reason']}. "
        f"Wake cause: {cause}" + (f" ({note})" if note else "") + ".",
        f"1. Load your role file {role_file} and the session kit: python3 {kit} show.",
        f"2. Read your handoff, journal seq {rec['handoff_seq']} on {rec['ref']} "
        f"(sb journal show {rec['ref']} --kind handoff), and the digest {digest_path}.",
        f"3. Find the manager (python3 {route} manager), tell it you are back up, and ask it to send any "
        f"information useful to you beyond the handoff and the digest.",
        f"[end pm_park wake {rec['name']}]"])


def window_env(rec: dict) -> dict:
    env = {"SUBSTRATE_HOLDER": rec["name"], "XTRM_AGENT_NAME": rec["name"],
           "XTMUX_AGENT_ROLE": LAUNCH_ROLE.get(rec["role"], rec["role"]), "SUBSTRATE_ISSUE_REF": rec["ref"]}
    if rec["runtime"] == "claude":
        env.update(MCP_SDK_GENERATION=os.environ.get("MCP_SDK_GENERATION") or "v2",
                   MCP_PROTOCOL_NEGOTIATION=os.environ.get("MCP_PROTOCOL_NEGOTIATION") or "auto")
    env.update({k: os.environ[k] for k in ("PM_CONFIG", "PM_PROJECT", "PM_STATE_DIR") if os.environ.get(k)})
    return env


def launch_command(rec: dict) -> str:
    base = pm_config.get("PM_PARK_LAUNCH") or LAUNCH_DEFAULT[rec["runtime"]]
    return "exec " + str(base) + (f" --model {shlex.quote(rec['model'])}" if rec.get("model") else "")


def pane_alive(pane: str) -> bool:
    r = run(["tmux", "display-message", "-p", "-t", pane, "#{pane_dead}"])
    return r.returncode == 0 and r.stdout.strip() == "0"


def open_window(rec: dict) -> str:
    """Open a detached tmux window in the worktree and start the runtime in it; return its pane id."""
    env = [x for k, v in window_env(rec).items() for x in ("-e", f"{k}={v}")]
    common = ["-d", "-P", "-F", "#{pane_id}", "-n", rec["name"], "-c", rec["worktree"], *env, launch_command(rec)]
    session = (rec.get("tmux_target") or "").rstrip(":")
    r = run(["tmux", "new-window", "-t", f"{session}:", *common]) if session else None
    if r is None or r.returncode != 0:
        # The old pane was the last window of its session, so the session is gone with it: make it again.
        session = session or rec["name"]
        r = run(["tmux", "new-session", "-s", session, *common])
    if r.returncode != 0:
        raise ParkError(f"tmux could not open a window: {(r.stderr or r.stdout).strip()[:200]}")
    return r.stdout.strip()


def confirm_alive(pane: str) -> bool:
    for _ in range(4):
        sleep(1)
        if not pane_alive(pane):
            return False
    return True


def send_nudge(pane: str, text: str, marker: str, end_marker: str) -> bool:
    """Paste the nudge, press Enter, and look for its first or last tag in the pane (the TUI scrolls the first line
    away once the session answers); one retry when neither is there."""
    sleep(setting_int("PM_PARK_NUDGE_DELAY_S", 20))
    for _ in range(2):
        if not pane_alive(pane):
            return False
        buf = "pmpark-" + re.sub(r"\W", "-", marker)
        run(["tmux", "load-buffer", "-b", buf, "-"], input=text)
        run(["tmux", "paste-buffer", "-d", "-p", "-b", buf, "-t", pane])
        sleep(1)
        run(["tmux", "send-keys", "-t", pane, "Enter"])
        sleep(3)
        cap = run(["tmux", "capture-pane", "-p", "-J", "-S", "-300", "-t", pane])
        shown = " ".join((cap.stdout or "").split())
        if marker in shown or end_marker in shown:
            return True
        sleep(5)
    return False


def stop_timer(rec: dict) -> None:
    run(["systemctl", "--user", "stop", rec["unit"] + ".timer"])


def retry_interval(rec: dict) -> int:
    """Seconds until the timer fires again: --check mode repeats every `every`, --at mode every `retry_s`."""
    return int(rec["wake"].get("every") or rec["retry_s"])


def wake(a: argparse.Namespace) -> int:
    rec = load(a.name)
    # A user timer starts in $HOME. sb and gh resolve the project from the checkout they run in, and sb outside
    # one falls back to the remote server (seen 2026-11-22), so every call of the wake runs in the session's worktree.
    if pathlib.Path(rec["worktree"]).is_dir():
        os.chdir(rec["worktree"])
    if rec["state"] not in LIVE_STATES:
        print(f"{a.name}: state {rec['state']}; nothing to do")
        stop_timer(rec)
        return 0
    if rec.get("due"):  # decided on an earlier firing: a retry never re-runs the check
        cause, note = rec["due"]["cause"], rec["due"]["note"]
    else:
        due, cause, note = decide(rec, a.force)
        if not due:
            print(f"{a.name}: {cause}")
            return 0
        rec["due"] = {"cause": cause, "note": note}
        save(rec)
    ok, line = gate()
    if not ok:
        rec["gate_waits"] += 1
        rec["last_gate"] = f"{fmt(now())} {line}"
        save(rec)
        print(f"{a.name}: launch gate shut ({line}); the timer retries in {retry_interval(rec)}s")
        return 0
    woken = now()
    rec.update(state="waking", wake_time=fmt(woken), wake_cause=cause + (f" ({note})" if note else ""))
    save(rec)
    try:
        dpath = digest(rec, woken, rec["wake_cause"])
        pm_role.write(rec["role"], rec["worktree"])
        pm_session.init(None, rec["ref"], rec["worktree"], own=False)
        pane = rec.get("wake_pane")
        if not (pane and pane_alive(pane)):
            pane = open_window(rec)
            rec["wake_pane"] = pane
            save(rec)
        if not confirm_alive(pane):
            raise ParkError(f"pane {pane} died within seconds of the start; check the launch command "
                            f"({launch_command(rec)}) and PATH of unit {rec['unit']}")
        text = nudge_text(rec, woken, cause, note, dpath)
        if not send_nudge(pane, text, f"[pm_park wake {rec['name']}]", f"[end pm_park wake {rec['name']}]"):
            raise ParkError(f"the nudge did not show in pane {pane}")
    except Exception as exc:  # noqa: BLE001 - any failure of an attempt is counted, never left as 'waking' for ever
        rec["attempts"] += 1
        rec["last_error"] = f"{fmt(now())} {type(exc).__name__}: {exc}"
        if rec["attempts"] >= setting_int("PM_PARK_MAX_ATTEMPTS", 3):
            rec["state"] = "failed"
            save(rec)
            journal_append(rec["ref"], "blocker", (
                f"wake failed: {a.name} ({rec['role']}) did not come up after {rec['attempts']} attempts: {exc}. "
                f"For the manager: start it by hand in {rec['worktree']} and read {parked_dir() / (a.name + '.digest.md')}."))
            stop_timer(rec)
            print(f"{a.name}: FAILED after {rec['attempts']} attempts: {exc}")
            return 1
        rec["state"] = "parked"
        save(rec)
        print(f"{a.name}: attempt {rec['attempts']} failed: {exc}; the timer retries in {retry_interval(rec)}s")
        return 1
    rec["state"] = "woken"
    seq = journal_append(rec["ref"], "note", (
        f"wake: {a.name} ({rec['role']}) woken {fmt(woken)} UTC (parked {rec['park_time']}); cause: {rec['wake_cause']}; "
        f"fresh {rec['runtime']} session in pane {rec['wake_pane']} of {rec['worktree']}; digest {dpath}."
        + (f" For the manager: {note}." if note else "")))
    if seq is None:
        rec["journal_error"] = f"{fmt(now())} the wake entry could not be written on {rec['ref']}"
        print(f"{a.name}: WARNING {rec['journal_error']}")
    save(rec)
    stop_timer(rec)
    print(f"{a.name}: woken ({rec['wake_cause']}), pane {rec['wake_pane']}")
    return 0


# --- list -----------------------------------------------------------------------------------------------------------

def timer_loaded(rec: dict) -> bool:
    """False when systemd no longer knows the transient timer (they do not survive a reboot)."""
    r = run(["systemctl", "--user", "show", "-p", "LoadState", "--value", rec["unit"] + ".timer"])
    return r.returncode != 0 or r.stdout.strip() != "not-found"


def list_cmd(a: argparse.Namespace) -> int:
    recs = records()
    if a.json:
        for r in recs:
            r["unit_missing"] = r["state"] in LIVE_STATES and not timer_loaded(r)
        print(json.dumps(recs))
        return 0
    if not recs:
        print("no parked sessions")
    for r in recs:
        gone = r["state"] in LIVE_STATES and not timer_loaded(r)
        print(f"{r['name']:<28} {r['state']:<8} {r['role']:<8} {r['ref']:<12} wake {wake_text(r)}; "
              f"unit {r['unit']}.timer" + (" MISSING (lost, e.g. after a reboot: re-park or wake by hand)" if gone else "")
              + f"; parked {r['park_time']}")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="pm_park.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="action", required=True)
    p = sub.add_parser("park")
    p.add_argument("name")
    p.add_argument("--ref", required=True)
    p.add_argument("--role", required=True)
    p.add_argument("--at")
    p.add_argument("--check")
    p.add_argument("--deadline")
    p.add_argument("--every", type=int, default=300, help="seconds between checks (at least 30)")
    p.add_argument("--self", action="store_true")
    p.add_argument("--manager-told", action="store_true")
    p.add_argument("--reason", default="long idle wait")
    p.add_argument("--worktree")
    p.add_argument("--runtime", choices=("claude", "pi"), default="claude")
    p.add_argument("--pane")
    p.add_argument("--model")
    p.set_defaults(fn=park)
    w = sub.add_parser("wake")
    w.add_argument("name")
    w.add_argument("--force", action="store_true")
    w.set_defaults(fn=wake)
    ls = sub.add_parser("list")
    ls.add_argument("--json", action="store_true")
    ls.set_defaults(fn=list_cmd)
    a = ap.parse_args(argv)
    try:
        return a.fn(a)
    except ParkError as exc:
        print(f"pm_park: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
