---
updated_at: 2026-05-09
---

# Security Exception: basic-ftp@5.2.0

- ID: DEP-HIGH-002
- Status: signed exception
- Date: 2026-05-09
- Reviewer: Dawid (agent)
- Scope: prod dependency chain via `proxy-agent -> pac-proxy-agent -> get-uri -> basic-ftp`
- Reachability: PAC/FTP-only path. Not used in normal direct app flow; requires proxy-agent resolution plus hostile PAC/FTP endpoint or equivalent attacker-controlled proxy input.
- Mitigation: keep PAC/FTP proxy sources untrusted-disabled in prod runtime; monitor upstream chain for fixed release.
- Exception expires: 2026-06-09
- Reason: no clean patch-level fix available in current upstream chain without behavior risk.
