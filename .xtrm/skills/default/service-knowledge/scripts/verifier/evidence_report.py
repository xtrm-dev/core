#!/usr/bin/env python3
"""Evidence report renderer: JSON (machine) and Markdown (human) forms.

The JSON form is the manifest itself. The Markdown form is what an operator reads
in a PR comment: it leads with the verdict summary, then lists every flagged claim
(CONFLICT or UNKNOWN) with its source_refs so a human can adjudicate in seconds.
"""
from __future__ import annotations

from .manifest import ClaimManifest
from .taxonomy import Verdict


def render_json(manifest: ClaimManifest) -> str:
    return manifest.to_json()


def render_markdown(manifest: ClaimManifest) -> str:
    counts = manifest.verdict_counts()
    total = len(manifest.claims)
    out: list[str] = []
    out.append(f"# Claim Verifier Report — `{manifest.service_id}`")
    out.append("")
    out.append(f"_verifier {manifest.to_dict()['verifier_id']} v{manifest.to_dict()['verifier_version']} · schema v{manifest.to_dict()['schema_version']}_")
    out.append("")
    out.append("## Summary")
    out.append("")
    out.append(f"- Claims checked: **{total}**")
    out.append(f"- ✅ PASS: **{counts.get('PASS', 0)}**")
    out.append(f"- ❌ CONFLICT: **{counts.get('CONFLICT', 0)}**")
    out.append(f"- ❓ UNKNOWN: **{counts.get('UNKNOWN', 0)}**")
    out.append("")

    if manifest.structural_issues:
        out.append("## Structural issues")
        out.append("")
        for issue in manifest.structural_issues:
            out.append(f"- **[{issue.get('severity', '?')}]** `{issue.get('code', '?')}`: {issue.get('message', '')}")
        out.append("")

    flagged = [c for c in manifest.claims if c.verdict in (Verdict.CONFLICT, Verdict.UNKNOWN)]
    out.append("## Flagged claims")
    out.append("")
    if not flagged:
        out.append("_No claims flagged. All extracted claims verified PASS._")
        out.append("")
        return "\n".join(out)

    for claim in flagged:
        icon = "❌" if claim.verdict is Verdict.CONFLICT else "❓"
        out.append(f"### {icon} [{claim.verdict.value}] {claim.claim_type.value}")
        out.append("")
        out.append(f"- **Section:** {claim.section_path or '(top)'}")
        out.append(f"- **Claim:** {claim.claim_text}")
        if claim.subject:
            out.append(f"- **Subject:** `{claim.subject}`")
        if claim.objects:
            out.append(f"- **Objects:** {', '.join('`' + o + '`' for o in claim.objects)}")
        if claim.completeness.value != "unknown" or claim.expected_count is not None:
            counts_txt = f"completeness={claim.completeness.value}"
            if claim.expected_count is not None:
                counts_txt += f", expected={claim.expected_count}"
            if claim.observed_count is not None:
                counts_txt += f", observed={claim.observed_count}"
            out.append(f"- **Set:** {counts_txt}")
        out.append(f"- **Comparison:** `{claim.comparison.value}`")
        if claim.source_refs:
            out.append(f"- **Source refs:** {', '.join('`' + r + '`' for r in claim.source_refs)}")
        else:
            out.append("- **Source refs:** _none resolved_")
        for advisory in claim.advisories:
            out.append(f"- ⚠️ {advisory}")
        out.append("")
    return "\n".join(out)
