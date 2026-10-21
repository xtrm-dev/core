#!/usr/bin/env python3
"""Claim extractor: pull the 5 implemented claim types out of a SKILL diff.

Only NEW/MODIFIED candidate lines are eligible (the diff_result changed-set gates
every match), so unchanged prose never re-surfaces as a claim. Each extractor
states a claim, resolves the ground truth from the source corpus, and assigns a
deterministic verdict:

    quoted_literal       — "the X is `L`"      → source defines X = L'  → PASS/CONFLICT
    set_claim            — closure-marked set   → resolve members/count  → PASS/CONFLICT/UNKNOWN
    metric_label_set     — metric labels        → source labelnames      → PASS/CONFLICT
    environment_constant — env var (+ value)    → compose environment    → PASS/CONFLICT
    compose_resource     — "the `svc` service"  → compose services       → PASS/CONFLICT

Anything the deterministic layer cannot resolve stays UNKNOWN (handed to the PR2
residual critic). Curatorial SEMANTIC blocks are skipped — claims are never
extracted from human-authored content (research §2.6).
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from .authority import Authority, authority_rank
from .closure_markers import detect_closure
from .diff_parser import build_section_paths
from .source_corpus import SourceCorpus
from .structural_validator import SEMANTIC_END, SEMANTIC_START
from .taxonomy import Claim, ClaimType, Comparison, Completeness, Risk, Verdict

_BACKTICK_LITERAL_RE = re.compile(r"`([^`]+)`")


@dataclass
class ExtractionContext:
    """Shared inputs for every extractor."""

    service_id: str
    verified_at_ref: str
    lines: list[str]
    paths: list[str]
    changed_lines: set[int]  # 1-based candidate line numbers that are new/modified
    semantic_line_mask: list[bool]  # True for lines inside a SEMANTIC block

    def is_eligible(self, line_index: int) -> bool:
        """A claim anchored at 0-based line_index is extractable iff it is new/modified
        and outside any curatorial SEMANTIC block."""
        if self.semantic_line_mask[line_index]:
            return False
        return (line_index + 1) in self.changed_lines


def _digest(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:16]


def _build_semantic_mask(lines: list[str]) -> list[bool]:
    mask: list[bool] = []
    inside = False
    for line in lines:
        if SEMANTIC_START in line:
            inside = True
            mask.append(True)
            continue
        if SEMANTIC_END in line:
            inside = False
            mask.append(True)
            continue
        mask.append(inside)
    return mask


def _finalize(claim: Claim, ctx: ExtractionContext, evidence: str) -> Claim:
    claim.verified_at_ref = ctx.verified_at_ref
    claim.evidence_digest = _digest(claim.claim_type.value, evidence, *claim.source_refs)
    if claim.authority_required and not any(
        authority_rank(ref) >= claim.authority_required for ref in claim.source_refs
    ):
        claim.advisories.append(
            f"no source_ref meets required authority {claim.authority_required}"
        )
    return claim


# --------------------------------------------------------------------------- #
# quoted_literal
# --------------------------------------------------------------------------- #

# "the <subject> is/are `L`"  |  "<subject>: `L`"  |  "<subject> = `L`"
_QUOTED_SUBJECT_RE = re.compile(
    r"(?:the\s+)?(?P<subject>[A-Za-z][\w ./-]{2,40}?)\s*(?:\bis\b|\bare\b|[:=])\s*`(?P<lit>[^`]+)`",
    re.IGNORECASE,
)
_LEADING_ARTICLE_RE = re.compile(r"^(?:the|a|an)\s+", re.IGNORECASE)


def _subject_assignment_pattern(subject: str) -> re.Pattern[str]:
    """Regex matching a source assignment whose LHS carries the subject's tokens in order."""
    tokens = re.findall(r"[a-z0-9]+", subject.lower())
    if not tokens:
        tokens = [re.escape(subject.lower())]
    core = r"[_\W]*".join(re.escape(tok) for tok in tokens)
    return re.compile(rf"[A-Za-z_]*{core}[A-Za-z0-9_]*\s*[:=]\s*[\"'](?P<val>[^\"']*)[\"']", re.IGNORECASE)


def _extract_quoted_literal(ctx: ExtractionContext, corpus: SourceCorpus) -> list[Claim]:
    claims: list[Claim] = []
    for idx, line in enumerate(ctx.lines):
        if not ctx.is_eligible(idx):
            continue
        # Closure-marked set claims belong to the set_claim extractor, not here.
        if detect_closure(line).completeness is Completeness.COMPLETE:
            continue
        for match in _QUOTED_SUBJECT_RE.finditer(line):
            subject = _LEADING_ARTICLE_RE.sub("", match.group("subject")).strip().rstrip(" .")
            claimed = match.group("lit").strip()
            # Skip prose subjects that are really set/list intros (handled elsewhere).
            if re.search(r"\b(?:following|are listed|below)\b", subject, re.IGNORECASE):
                continue
            pattern = _subject_assignment_pattern(subject)
            hits = corpus.search(pattern.pattern, pattern.flags)
            claim = Claim(
                service_id=ctx.service_id,
                section_path=ctx.paths[idx],
                claim_text=line.strip(),
                claim_type=ClaimType.QUOTED_LITERAL,
                subject=subject,
                predicate="equals",
                objects=[claimed],
                risk=Risk.HIGH,
                authority_required=int(Authority.EXECUTABLE_CODE),
            )
            if not hits:
                claim.verdict = Verdict.UNKNOWN
                claim.comparison = Comparison.UNRESOLVED
                claim.advisories.append("no source assignment found for subject")
                claims.append(_finalize(claim, ctx, claimed))
                continue
            actual = hits[0][1].group("val")
            claim.source_refs = sorted({rel for rel, _ in hits})
            claim.observed_count = len(hits)
            if actual == claimed:
                claim.verdict = Verdict.PASS
                claim.comparison = Comparison.EQUAL
            else:
                claim.verdict = Verdict.CONFLICT
                claim.comparison = Comparison.UNEQUAL
                claim.objects = [claimed]
                claim.advisories.append(f"source defines {subject} as {actual!r}, not {claimed!r}")
            claims.append(_finalize(claim, ctx, actual))
    return claims


# --------------------------------------------------------------------------- #
# set_claim
# --------------------------------------------------------------------------- #

def _resolve_sed_variables(corpus: SourceCorpus) -> set[str]:
    """Distinct ${VAR} names substituted inside sed commands across shell files."""
    variables: set[str] = set()
    var_re = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
    for rel, text in corpus.files.items():
        if not rel.endswith((".sh", ".bash")):
            continue
        for line in text.splitlines():
            if "sed" not in line:
                continue
            variables.update(var_re.findall(line))
    return variables


# Subject keyword -> resolver returning the observed member set from source.
_SET_RESOLVERS: list[tuple[re.Pattern[str], object]] = [
    (re.compile(r"\bsed\b", re.IGNORECASE), _resolve_sed_variables),
]


def _extract_set_claim(ctx: ExtractionContext, corpus: SourceCorpus) -> list[Claim]:
    claims: list[Claim] = []
    for idx, line in enumerate(ctx.lines):
        if not ctx.is_eligible(idx):
            continue
        closure = detect_closure(line)
        if closure.completeness is not Completeness.COMPLETE:
            continue
        members = [m.strip() for m in _BACKTICK_LITERAL_RE.findall(line) if m.strip()]
        if not members and closure.expected_count is None:
            continue
        claim = Claim(
            service_id=ctx.service_id,
            section_path=ctx.paths[idx],
            claim_text=line.strip(),
            claim_type=ClaimType.SET_CLAIM,
            subject=closure.marker,
            predicate="enumerates",
            objects=members,
            completeness=closure.completeness,
            expected_count=closure.expected_count,
            risk=Risk.HIGH,
            authority_required=int(Authority.EXECUTABLE_CODE),
        )
        resolver = next((fn for pat, fn in _SET_RESOLVERS if pat.search(line)), None)
        if resolver is None:
            claim.verdict = Verdict.UNKNOWN
            claim.comparison = Comparison.UNRESOLVED
            claim.advisories.append(
                "complete-set claim has no deterministic resolver; needs residual review"
            )
            claims.append(_finalize(claim, ctx, ",".join(members)))
            continue
        observed = resolver(corpus)
        claim.observed_count = len(observed)
        claimed_set = set(members)
        if observed:
            claim.source_refs = corpus.files_containing(next(iter(observed)))
        if claimed_set and claimed_set == observed and _count_ok(closure.expected_count, len(observed)):
            claim.verdict = Verdict.PASS
            claim.comparison = Comparison.EQUAL
        elif claimed_set <= observed:
            claim.verdict = Verdict.CONFLICT
            claim.comparison = Comparison.SUBSET
            claim.advisories.append(f"claimed set is a subset of source {sorted(observed)}")
        elif claimed_set >= observed and observed:
            claim.verdict = Verdict.CONFLICT
            claim.comparison = Comparison.SUPERSET
            claim.advisories.append(f"claimed set is a superset of source {sorted(observed)}")
        else:
            claim.verdict = Verdict.CONFLICT
            claim.comparison = Comparison.UNEQUAL
            claim.advisories.append(f"source set {sorted(observed)} != claimed {sorted(claimed_set)}")
        claims.append(_finalize(claim, ctx, ",".join(sorted(observed))))
    return claims


def _count_ok(expected: int | None, observed: int) -> bool:
    return expected is None or expected == observed


# --------------------------------------------------------------------------- #
# metric_label_set
# --------------------------------------------------------------------------- #

_METRIC_NAME_RE = re.compile(r"`([a-z_][a-z0-9_]*(?:_[a-z0-9]+)+)`")
_LABEL_INTRO_RE = re.compile(r"\blabel(?:name)?s?\b", re.IGNORECASE)


def _labels_after_intro(line: str, metric: str) -> list[str]:
    """All backticked label tokens appearing after the 'label(s)' keyword, minus the metric name."""
    intro = _LABEL_INTRO_RE.search(line)
    if not intro:
        return []
    tail = line[intro.end():]
    tokens = re.findall(r"`([a-z_][a-z0-9_]*)`", tail)
    seen: list[str] = []
    for tok in tokens:
        if tok != metric and tok not in seen:
            seen.append(tok)
    return seen


def _source_labels_for(corpus: SourceCorpus, metric: str) -> tuple[set[str], list[str]]:
    """Return (labelnames set, source_refs) for a metric defined in the corpus."""
    pattern = re.compile(
        rf"[\"']{re.escape(metric)}[\"'][\s\S]{{0,300}}?labelnames\s*=\s*[\(\[]([^)\]]*)[\)\]]"
    )
    labels: set[str] = set()
    refs: list[str] = []
    for rel, m in corpus.search(pattern.pattern):
        refs.append(rel)
        labels.update(re.findall(r"[\"']([a-z_][a-z0-9_]*)[\"']", m.group(1)))
    return labels, sorted(set(refs))


def _extract_metric_label_set(ctx: ExtractionContext, corpus: SourceCorpus) -> list[Claim]:
    claims: list[Claim] = []
    for idx, line in enumerate(ctx.lines):
        if not ctx.is_eligible(idx):
            continue
        if not re.search(r"\blabel", line, re.IGNORECASE):
            continue
        metric_match = _METRIC_NAME_RE.search(line)
        if not metric_match:
            continue
        metric = metric_match.group(1)
        claimed = _labels_after_intro(line, metric)
        if not claimed:
            continue
        observed, refs = _source_labels_for(corpus, metric)
        closure = detect_closure(line)
        claim = Claim(
            service_id=ctx.service_id,
            section_path=ctx.paths[idx],
            claim_text=line.strip(),
            claim_type=ClaimType.METRIC_LABEL_SET,
            subject=metric,
            predicate="has_labels",
            objects=claimed,
            completeness=closure.completeness,
            expected_count=len(claimed),
            observed_count=len(observed) if observed else None,
            risk=Risk.MEDIUM,
            authority_required=int(Authority.EXECUTABLE_CODE),
            source_refs=refs,
        )
        if not observed:
            claim.verdict = Verdict.UNKNOWN
            claim.comparison = Comparison.UNRESOLVED
            claim.advisories.append(f"metric {metric} not found in source")
        elif set(claimed) == observed:
            claim.verdict = Verdict.PASS
            claim.comparison = Comparison.EQUAL
        else:
            claim.verdict = Verdict.CONFLICT
            claim.comparison = Comparison.UNEQUAL
            claim.advisories.append(f"source labels {sorted(observed)} != claimed {sorted(set(claimed))}")
        claims.append(_finalize(claim, ctx, ",".join(sorted(observed))))
    return claims


# --------------------------------------------------------------------------- #
# environment_constant
# --------------------------------------------------------------------------- #

_ENV_NAME_RE = re.compile(r"`([A-Z][A-Z0-9_]*)`")
_ENV_VALUE_RE = re.compile(r"`([A-Z][A-Z0-9_]*)`[^`]*?(?:is\s+set\s+to|[:=])\s*`([^`]*)`", re.IGNORECASE)


def _extract_environment_constant(ctx: ExtractionContext, corpus: SourceCorpus) -> list[Claim]:
    claims: list[Claim] = []
    env_values = corpus.compose_env_values()
    for idx, line in enumerate(ctx.lines):
        if not ctx.is_eligible(idx):
            continue
        if not re.search(r"\benv(?:ironment)?\b", line, re.IGNORECASE):
            continue
        value_match = _ENV_VALUE_RE.search(line)
        if value_match:
            name, claimed_val = value_match.group(1), value_match.group(2)
            claim = Claim(
                service_id=ctx.service_id,
                section_path=ctx.paths[idx],
                claim_text=line.strip(),
                claim_type=ClaimType.ENVIRONMENT_CONSTANT,
                subject=name,
                predicate="equals",
                objects=[claimed_val],
                risk=Risk.HIGH,
                authority_required=int(Authority.READ_ONLY_PROBE),
                source_refs=list(corpus.compose_refs),
            )
            if name not in env_values:
                claim.verdict = Verdict.UNKNOWN if not corpus.compose_refs else Verdict.CONFLICT
                claim.comparison = Comparison.UNRESOLVED if not corpus.compose_refs else Comparison.UNEQUAL
                if corpus.compose_refs:
                    claim.advisories.append(f"{name} not declared in compose environment")
            elif env_values[name] == claimed_val:
                claim.verdict = Verdict.PASS
                claim.comparison = Comparison.EQUAL
            else:
                claim.verdict = Verdict.CONFLICT
                claim.comparison = Comparison.UNEQUAL
                claim.advisories.append(f"compose sets {name}={env_values[name]!r}, not {claimed_val!r}")
            claims.append(_finalize(claim, ctx, f"{name}={env_values.get(name, '')}"))
            continue
        names = _ENV_NAME_RE.findall(line)
        for name in names:
            claim = Claim(
                service_id=ctx.service_id,
                section_path=ctx.paths[idx],
                claim_text=line.strip(),
                claim_type=ClaimType.ENVIRONMENT_CONSTANT,
                subject=name,
                predicate="is_defined",
                objects=[],
                risk=Risk.MEDIUM,
                authority_required=int(Authority.READ_ONLY_PROBE),
                source_refs=list(corpus.compose_refs),
            )
            if not corpus.compose_refs:
                claim.verdict = Verdict.UNKNOWN
                claim.comparison = Comparison.UNRESOLVED
            elif name in env_values:
                claim.verdict = Verdict.PASS
                claim.comparison = Comparison.EQUAL
            else:
                claim.verdict = Verdict.CONFLICT
                claim.comparison = Comparison.UNEQUAL
                claim.advisories.append(f"{name} not declared in compose environment")
            claims.append(_finalize(claim, ctx, name))
    return claims


# --------------------------------------------------------------------------- #
# compose_resource
# --------------------------------------------------------------------------- #

_COMPOSE_RESOURCE_RE = re.compile(
    r"(?:the\s+)?`([a-z0-9][a-z0-9_.-]*)`\s*(?:compose\s+)?(service|container|volume|network)",
    re.IGNORECASE,
)


def _extract_compose_resource(ctx: ExtractionContext, corpus: SourceCorpus) -> list[Claim]:
    claims: list[Claim] = []
    services = corpus.compose_service_names()
    resources = set(corpus.compose.get("volumes", {})) | set(corpus.compose.get("networks", {}))
    for idx, line in enumerate(ctx.lines):
        if not ctx.is_eligible(idx):
            continue
        for match in _COMPOSE_RESOURCE_RE.finditer(line):
            name, kind = match.group(1), match.group(2).lower()
            claim = Claim(
                service_id=ctx.service_id,
                section_path=ctx.paths[idx],
                claim_text=line.strip(),
                claim_type=ClaimType.COMPOSE_RESOURCE,
                subject=name,
                predicate=f"is_compose_{kind}",
                objects=[kind],
                risk=Risk.MEDIUM,
                authority_required=int(Authority.READ_ONLY_PROBE),
                source_refs=list(corpus.compose_refs),
            )
            known = services if kind in ("service", "container") else resources
            if not corpus.compose_refs:
                claim.verdict = Verdict.UNKNOWN
                claim.comparison = Comparison.UNRESOLVED
                claim.advisories.append("no compose file found in territory")
            elif name in known:
                claim.verdict = Verdict.PASS
                claim.comparison = Comparison.EQUAL
            else:
                claim.verdict = Verdict.CONFLICT
                claim.comparison = Comparison.UNEQUAL
                claim.advisories.append(f"{kind} {name!r} not defined in compose")
            claims.append(_finalize(claim, ctx, f"{kind}:{name}"))
    return claims


_EXTRACTORS = (
    _extract_quoted_literal,
    _extract_set_claim,
    _extract_metric_label_set,
    _extract_environment_constant,
    _extract_compose_resource,
)


def extract_claims(
    candidate_text: str,
    changed_lines: set[int],
    corpus: SourceCorpus,
    service_id: str,
    verified_at_ref: str = "",
) -> list[Claim]:
    """Run every implemented extractor over the candidate's new/modified lines."""
    lines = candidate_text.splitlines()
    ctx = ExtractionContext(
        service_id=service_id,
        verified_at_ref=verified_at_ref,
        lines=lines,
        paths=build_section_paths(lines),
        changed_lines=changed_lines,
        semantic_line_mask=_build_semantic_mask(lines),
    )
    claims: list[Claim] = []
    for extractor in _EXTRACTORS:
        claims.extend(extractor(ctx, corpus))
    return claims
