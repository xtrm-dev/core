#!/usr/bin/env python3
"""Full-text search over the Substrate journal (FTS5 + BM25), read-only on state.db.

Source: $SUBSTRATE_DB, else ~/.xtrm/state.db (the same store as sb). Side index in
$XDG_CACHE_HOME/journal-search/index.db (default ~/.cache), incremental by created_at; one index per source.
  jsearch.py "promote merge 1490"
  jsearch.py "rollback operator" -p PROJ -k decision,blocker --since 2026-11-10 -n 20
  jsearch.py --rebuild
FTS5 query syntax: words AND by default, "exact phrase", OR, NOT, prefix*.
"""
import argparse, datetime as dt, json, os, sqlite3, sys, zlib

SRC = os.path.expanduser(os.environ.get("SUBSTRATE_DB") or "~/.xtrm/state.db")
_CACHE = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
# One index per source store, so a second Substrate database never mixes into the first one's index.
IDX = os.path.join(_CACHE, "journal-search",
                   "index.db" if SRC == os.path.expanduser("~/.xtrm/state.db")
                   else "index-%08x.db" % zlib.crc32(os.path.realpath(SRC).encode()))


def text_of(raw):
    if not raw:
        return ""
    try:
        v = json.loads(raw)
    except ValueError:
        return raw
    out = []

    def walk(x):
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif x is not None:
            out.append(str(x))

    walk(v)
    return "\n".join(out)


def sync(rebuild=False):
    os.makedirs(os.path.dirname(IDX), exist_ok=True)
    ix = sqlite3.connect(IDX)
    if rebuild:
        ix.executescript("DROP TABLE IF EXISTS j; DROP TABLE IF EXISTS meta;")
    ix.executescript(
        "CREATE VIRTUAL TABLE IF NOT EXISTS j USING fts5("
        "body, ref UNINDEXED, prefix UNINDEXED, seq UNINDEXED, kind UNINDEXED, who UNINDEXED,"
        "ts UNINDEXED, title, tokenize='unicode61 remove_diacritics 2');"
        "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER);"
    )
    last = (ix.execute("SELECT v FROM meta WHERE k='last_ts'").fetchone() or [0])[0]
    src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    rows = src.execute(
        "SELECT p.prefix||'-'||i.human_number, p.prefix, j.sequence, j.kind, j.participant_id, j.created_at,"
        " i.title, j.semantic_json, j.result_json, j.mechanical_json, j.refs_json"
        " FROM issue_journal j JOIN issues i ON i.id=j.issue_id JOIN projects p ON p.id=i.project_id"
        " WHERE j.created_at > ? ORDER BY j.created_at",
        (last,),
    ).fetchall()
    for r in rows:
        body = "\n".join(t for t in (text_of(r[7]), text_of(r[8]), text_of(r[9]), text_of(r[10])) if t)
        ix.execute("INSERT INTO j VALUES (?,?,?,?,?,?,?,?)", (body, r[0], r[1], r[2], r[3], r[4] or "", r[5], r[6]))
    if rows:
        ix.execute("INSERT OR REPLACE INTO meta VALUES ('last_ts', ?)", (rows[-1][5],))
    ix.commit()
    return ix, len(rows)


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("query", nargs="?")
    a.add_argument("-p", "--prefix", help="project prefix, e.g. PROJ")
    a.add_argument("-k", "--kind", help="comma list: decision,finding,blocker,result,handoff,...")
    a.add_argument("-w", "--who", help="participant substring")
    a.add_argument("-r", "--ref", help="one issue, e.g. PROJ-120")
    a.add_argument("--since", help="YYYY-MM-DD (UTC)")
    a.add_argument("-n", type=int, default=15)
    a.add_argument("--rebuild", action="store_true")
    o = a.parse_args()
    ix, added = sync(o.rebuild)
    if not o.query:
        print(f"index synced, +{added} entries, total {ix.execute('SELECT count(*) FROM j').fetchone()[0]}")
        return
    where, args = ["j MATCH ?"], [o.query]
    if o.prefix:
        where.append("prefix = ?"); args.append(o.prefix.upper())
    if o.ref:
        where.append("ref = ?"); args.append(o.ref.upper())
    if o.kind:
        ks = o.kind.split(",")
        where.append(f"kind IN ({','.join('?' * len(ks))})"); args += ks
    if o.who:
        where.append("who LIKE ?"); args.append(f"%{o.who}%")
    if o.since:
        ms = int(dt.datetime.strptime(o.since, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        where.append("ts >= ?"); args.append(ms)
    sql = ("SELECT ref, seq, kind, who, ts, bm25(j, 1.0, 0, 0, 0, 0, 0, 0, 0.5) AS s,"
           " snippet(j, 0, '[', ']', ' … ', 24) FROM j WHERE " + " AND ".join(where) + " ORDER BY s LIMIT ?")
    try:
        hits = ix.execute(sql, args + [o.n]).fetchall()
    except sqlite3.OperationalError as e:
        # Plain words with '-', '#', '.' break FTS5 syntax: retry with every token quoted as a phrase.
        safe = " ".join('"' + t.replace('"', '') + '"' for t in o.query.split() if t.replace('"', ''))
        try:
            hits = ix.execute(sql, [safe] + args[1:] + [o.n]).fetchall()
            print(f"(query read as {safe}; FTS5 said: {e})")
        except sqlite3.OperationalError:
            sys.exit(f"query error: {e}")
    for ref, seq, kind, who, ts, s, snip in hits:
        t = dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).strftime("%m-%d %H:%MZ")
        print(f"{ref} seq{seq} {kind} {t} {who} ({-s:.1f})\n    {' '.join(snip.split())}")
    print(f"-- {len(hits)} hit(s); index +{added} new")


if __name__ == "__main__":
    main()
