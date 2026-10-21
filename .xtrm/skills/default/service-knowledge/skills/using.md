
# Using Service Knowledge

> Detailed **discover / activate** flow for the `service-knowledge` router.
>
> **Path model:** `.claude/skills/<service>/SKILL.md` shown below is the **Claude-Code view** (a symlink). The canonical home for per-service skills is under `.xtrm/skills/<pack>/` — scripts resolve it via `bootstrap.get_service_skill_path_str`. Machinery scripts live at `.xtrm/skills/default/service-knowledge/scripts/` (the active view of this skill).

## Role: The Concierge

You are the **Service Skills Concierge**. Your job is to help users discover and
activate expert personas registered in the repo service registry (canonical:
`.xtrm/skills/<pack>/service-knowledge/service-registry.json`; `.claude/skills/`
shows the legacy Claude-Code view of the same registry).

---

## How the Catalog Works

At session start, the `SessionStart` hook (configured in `.claude/settings.json`)
runs `cataloger.py` and injects a lightweight XML block into your context:

```xml
<project_service_catalog>
Available expert personas:
- db-expert: SQL & schema optimization (Path: .claude/skills/db-expert/SKILL.md)
- auth-service: JWT authentication expert (Path: .claude/skills/auth-service/SKILL.md)
</project_service_catalog>
<instruction>To activate an expert, read its SKILL.md from the provided path.</instruction>
```

This costs ~150 tokens per session regardless of how many experts are registered
(Progressive Disclosure: full skill bodies are loaded only when needed).

---

## Workflow

### 1. Check the Injected Catalog

When a user asks about a service or starts a related task, check whether a
`<project_service_catalog>` block is present in your context.

If no catalog was injected (e.g. first run, no services registered), generate one:

```bash
python3 "$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-knowledge/scripts/cataloger.py"
```

### 2. Activate an Expert Persona

When a task matches an expert's domain, read that skill's SKILL.md:

```
Read: .claude/skills/<service-id>/SKILL.md
```

Then adopt the expert's persona, constraints, and knowledge for the duration
of the task.

**Example:**
```
User: "Optimize this database query"
You:  [Catalog shows db-expert matches]
      [Read .claude/skills/db-expert/SKILL.md]
      [Apply Senior Database Engineer persona and expertise]
```

### 2.25 Search Evidence, Not Just Titles (FTS5 + MCP tools)

The catalog is a **name list** — enough to activate an expert whose name you already
recognize. When the task doesn't name a service directly (an alert with an unfamiliar
label, a stack trace pointing at an unclear file, a symptom that could be one of several
services), reach for the evidence index instead of guessing from titles.

Two surfaces read the same per-repo FTS5 index at `.xtrm/cache/service-knowledge.sqlite`:

- **CLI**: `service-knowledge index query "<text>"` — free-text ranked hits; add
  `--paths <file[,file]>` to bias by territory, `--service-id <id>` to restrict,
  `--bundle` for the §3.2 evidence-bundle shape.
- **MCP tools** (read-only, sub-10ms):
  - `knowledge_search` — ranked evidence bundle for free text
  - `knowledge_get` — one item by `item_id` or `skill_path`
  - `knowledge_evidence_for_files` — evidence bundle for a list of touched paths
    (what the PreToolUse activator uses internally)

Both return evidence, never conclusions — the ranked hits tell you *which* SKILL(s) to
`Read` in the next step. Prefer these over grep for any question about which service owns a
symptom or a path.

Concept help: `service-knowledge help mcp`, `service-knowledge help activator`.

### 2.5 Navigate with the Graph, Not Just Globs

The registry maps a service to its territory **globs** — enough to *find* the skill, but
not to understand how the service connects to others. Once an expert is active, navigate
with the **GitNexus knowledge graph** for anything cross-cutting:

| Question | Use |
|---|---|
| "What else breaks if I change this symbol?" | `gitnexus impact <symbol> --direction upstream` |
| "Who calls / is called by this?" | `gitnexus context <symbol>` |
| "Which service owns this execution flow?" | `gitnexus query "<concept>"` (process-grouped) |
| "Trace the full flow end to end" | `READ gitnexus://repo/<repo>/process/<name>` |

This matters when a task spans services: the registry tells you *which* skills exist; the
graph tells you which ones a change actually **touches**. Cross-service drift signals in a
service's SKILL.md (and in `drift_detector.py` output) come from this same graph.

**Fallback:** if no GitNexus index is present, fall back to the registry territory globs
and the `cross_territory` hints in drift output — navigation still works, just without
blast-radius precision. The graph is an enhancement, never a hard dependency.

### 3. Handle Missing Experts

If no registered expert covers the user's need:
1. Inform the user no expert exists for this domain
2. Offer to create one: "I can create a service skill using `/creating-service-knowledge`"

### 3.5 Absent or Stale Knowledge — commit corpus is first-class memory

When the registry is absent, or a skill's knowledge is stale (drift marker
present, `last_sync_ref` behind HEAD), do NOT block on updating
service-knowledge. Memory priority per task:

1. **service-knowledge, if present** — use the registry and skill bodies as-is;
   never grep-hunt for `service-registry.json` speculatively.
2. **Commit corpus — always available** — fall back to `git log -p --follow --
   <file>` for per-file history, `git log --grep`/`--oneline` for corpus, and
   diffs vs `last_sync_ref` when a registry states one. Commits do not go stale.
3. **bd memories** — before workflow-sensitive questions, run
   `bd memories <topic>` / `bd recall <key>`; write durable findings back with
   `bd remember`.

**Drift doctrine**: a drift marker (`.service-skills-drift-pending` or
`service-knowledge status`) is **advisory**. Suggest the update, proceed with
current knowledge + commit corpus in parallel; reconcile via
`/updating-service-knowledge` and stamp `last_sync_ref` after. Never block task
work on updating service-knowledge, and rebuild the index only after a
successful reconcile.

---

## Session Start Hook

The catalog injection is not handled by skill frontmatter hooks. Configure it in
`.claude/settings.json` using `SessionStart`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "python3 \"$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-knowledge/scripts/cataloger.py\""
      }]
    }]
  }
}
```

---

## Tool Restrictions

Read-only — no write access:
- ✅ `Read` — read SKILL.md files to activate expert personas
- ✅ `Glob` — browse `.claude/skills/` directory

## Related Skills

- `/creating-service-knowledge` — Scaffold new expert personas
- `/updating-service-knowledge` — Sync skills when implementation drifts

---

## Per-repo umbrella (load first for cross-service tasks)

Each repo has a generated umbrella skill `<repo>-services` at `.xtrm/skills/<pack>/service-knowledge/SKILL.md` — the service map + cross-service health story. When a task spans services, load the umbrella first; it links every per-service skill. It is regenerated from the registry (`umbrella_generator.py`); only its `<!-- SEMANTIC_START -->` block is hand-edited.
