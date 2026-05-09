#!/usr/bin/env python3
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BOOTSTRAP_DIR = Path(__file__).parent.parent.parent / "creating-service-skills" / "scripts"
sys.path.insert(0, str(BOOTSTRAP_DIR))
from bootstrap import RootResolutionError, find_service_for_path, get_project_root, get_registry_path, get_service, is_gitnexus_available, load_registry, run_gitnexus_json, save_registry  # noqa: E402

def check_drift(file_path: str, project_root: str | None = None) -> dict:
    if project_root is None:
        try: project_root = get_project_root()
        except RootResolutionError: return {"drift": False, "reason": "Cannot resolve project root"}
    fp = Path(file_path)
    if fp.is_absolute():
        try: file_path = str(fp.relative_to(project_root))
        except ValueError: pass
    service_id = find_service_for_path(file_path, project_root)
    if not service_id: return {"drift": False, "reason": "No service owns this file"}
    service = get_service(service_id, project_root)
    if not service: return {"drift": False, "reason": "Service not found in registry"}
    return {"drift": True, "service_id": service_id, "service_name": service.get("name", service_id), "skill_path": service.get("skill_path"), "last_sync": service.get("last_sync", ""), "file_path": file_path, "message": f"[Skill Sync]: Implementation drift detected in '{service_id}'. File '{file_path}' was modified."}

def check_drift_from_hook_stdin() -> None:
    try: data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError): sys.exit(0)
    file_path = data.get("tool_input", {}).get("file_path", "")
    if not file_path: sys.exit(0)
    result = check_drift(file_path)
    if result.get("drift"): print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": result["message"]}}))
    sys.exit(0)

def _print_missing_registry_hint(project_root: str | None = None) -> None:
    if project_root is None:
        try: project_root = get_project_root()
        except RootResolutionError: project_root = "."
    root = Path(project_root)
    print(f"Registry not found. Expected one of: {root / 'service-registry.json'}, {root / '.claude/skills/service-registry.json'}, {root / '.xtrm/skills/user/packs/*/service-registry.json'}", file=sys.stderr)

def update_sync_time(service_id: str, project_root: str | None = None) -> bool:
    try: registry = load_registry(project_root)
    except Exception: return False
    if "services" not in registry or service_id not in registry["services"]: return False
    registry["services"][service_id]["last_sync"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try: save_registry(registry, project_root); return True
    except Exception: return False

def _classify_tier(symbols: list[str], processes: list[str]) -> str:
    if processes or len(symbols) >= 2: return "high impact"
    if symbols: return "medium"
    return "cosmetic"

def _extract_cross_territory(file_path: str, service_id: str, project_root: str) -> list[str]:
    registry = load_registry(project_root)
    text = (Path(project_root) / file_path).read_text(encoding="utf-8", errors="ignore")
    out = []
    for other_id, service in registry.get("services", {}).items():
        if other_id == service_id: continue
        for pattern in service.get("territory", []):
            base = pattern.replace("/**/*", "").replace("/**", "").rstrip("/")
            if base and base in text: out.append(f"cross-territory drift signal: {other_id}"); break
    return out

def _enrich_item(item: dict, project_root: str) -> dict:
    symbols = []
    det = run_gitnexus_json(["detect_changes", "--scope", "unstaged"], timeout=2.0)
    if isinstance(det, dict) and isinstance(det.get("symbols"), list): symbols = list(dict.fromkeys(det["symbols"]))
    processes = []
    for s in symbols:
        imp = run_gitnexus_json(["impact", s, "--direction", "upstream"], timeout=2.0)
        if isinstance(imp, dict):
            for p in imp.get("affected_processes", []):
                if isinstance(p, dict) and p.get("name"): processes.append(p["name"])
    item["symbols"] = list(dict.fromkeys(symbols))
    item["processes"] = list(dict.fromkeys(processes))
    item["cross_territory"] = _extract_cross_territory(item["file_path"], item["service_id"], project_root)
    item["tier"] = _classify_tier(item["symbols"], item["processes"])
    return item

def scan_drift(project_root: str | None = None, enrich_with_gitnexus: bool = False) -> list[dict]:
    if project_root is None:
        try: project_root = get_project_root()
        except RootResolutionError: return []
    root = Path(project_root)
    if not get_registry_path(project_root).exists(): _print_missing_registry_hint(project_root); return []
    registry = load_registry(project_root)
    drifted = []
    for service_id, service in registry.get("services", {}).items():
        last_sync_str = service.get("last_sync", "")
        if not last_sync_str: continue
        try: sync_time = datetime.fromisoformat(last_sync_str.replace("Z", "+00:00"))
        except ValueError: continue
        for pattern in service.get("territory", []):
            for fp in root.glob(pattern):
                if fp.is_file() and datetime.fromtimestamp(fp.stat().st_mtime, tz=timezone.utc) > sync_time:
                    drifted.append({"service_id": service_id, "service_name": service.get("name", service_id), "file_path": str(fp.relative_to(root)), "last_sync": last_sync_str})
    if not enrich_with_gitnexus or not drifted: return drifted
    ok, reason = is_gitnexus_available(timeout=2.0)
    if not ok: print(f"gitnexus enrichment skipped: {reason}", file=sys.stderr); return drifted
    out = []
    for item in drifted:
        try: out.append(_enrich_item(item, project_root))
        except Exception as exc: print(f"gitnexus enrichment skipped for {item['file_path']}: {exc}", file=sys.stderr); out.append(item)
    return out

def main() -> None:
    args = sys.argv[1:]
    if not args: sys.exit(1)
    enrich = "--enrich-with-gitnexus" in args
    cmd = args[0]
    if cmd == "check-hook": check_drift_from_hook_stdin()
    elif cmd == "check" and len(args) > 1:
        r = check_drift(args[1]); print(r["message"] if r.get("drift") else f"No drift: {r.get('reason', 'OK')}")
    elif cmd == "sync" and len(args) > 1: sys.exit(0 if update_sync_time(args[1]) else 1)
    elif cmd == "scan":
        d = scan_drift(enrich_with_gitnexus=enrich)
        if not d: print("No drift detected."); return
        print(f"Found {len(d)} drifted service(s):")
        for i in d:
            print(f"  {i['service_id']}: {i['file_path']} (last sync: {i['last_sync']})")
            if enrich: print(f"    tier={i.get('tier','cosmetic')} symbols={','.join(i.get('symbols', [])) or '-'} processes={','.join(i.get('processes', [])) or '-'} cross_territory={'; '.join(i.get('cross_territory', [])) or '-'}")
    else: sys.exit(1)

if __name__ == "__main__": main()
