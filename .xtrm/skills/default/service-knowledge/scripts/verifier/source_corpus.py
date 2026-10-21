#!/usr/bin/env python3
"""Source corpus: load the territory files a claim is verified against.

The verifier never trusts the SKILL prose alone — every claim is checked against
the source of truth in the service territory (executable code, compose files,
config). This module loads those files (via territory globs, drift_detector.py
idiom) into an in-memory corpus and pre-parses any compose YAML so extractors can
query structured truth deterministically.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

_COMPOSE_NAMES = ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml")


@dataclass
class SourceCorpus:
    """Loaded territory files plus parsed compose structure."""

    base_dir: Path
    files: dict[str, str] = field(default_factory=dict)  # rel path -> text
    compose: dict = field(default_factory=dict)  # merged compose mapping
    compose_refs: list[str] = field(default_factory=list)  # rel paths that parsed as compose

    @classmethod
    def from_globs(cls, base_dir: Path, globs: list[str]) -> "SourceCorpus":
        corpus = cls(base_dir=base_dir)
        seen: set[Path] = set()
        for pattern in globs:
            for path in sorted(base_dir.glob(pattern)):
                if not path.is_file() or path in seen:
                    continue
                seen.add(path)
                rel = path.relative_to(base_dir).as_posix()
                try:
                    text = path.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                corpus.files[rel] = text
                if path.name.lower() in _COMPOSE_NAMES:
                    corpus._absorb_compose(rel, text)
        return corpus

    def _absorb_compose(self, rel: str, text: str) -> None:
        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError:
            return
        if not isinstance(data, dict):
            return
        self.compose_refs.append(rel)
        services = data.get("services")
        if isinstance(services, dict):
            merged = self.compose.setdefault("services", {})
            merged.update(services)
        for key in ("volumes", "networks", "configs", "secrets"):
            if isinstance(data.get(key), dict):
                self.compose.setdefault(key, {}).update(data[key])

    def all_text(self) -> str:
        return "\n".join(self.files.values())

    def files_containing(self, needle: str) -> list[str]:
        return [rel for rel, text in self.files.items() if needle in text]

    def search(self, pattern: str, flags: int = 0) -> list[tuple[str, re.Match[str]]]:
        """All (rel_path, match) pairs for a regex across the corpus."""
        compiled = re.compile(pattern, flags)
        out: list[tuple[str, re.Match[str]]] = []
        for rel, text in self.files.items():
            out.extend((rel, m) for m in compiled.finditer(text))
        return out

    def compose_services(self) -> dict:
        services = self.compose.get("services")
        return services if isinstance(services, dict) else {}

    def compose_service_names(self) -> set[str]:
        return set(self.compose_services().keys())

    def compose_env_vars(self) -> set[str]:
        """Env var names declared anywhere in compose services."""
        return set(self.compose_env_values().keys())

    def compose_env_values(self) -> dict[str, str]:
        """Env var name -> value across compose services (last write wins)."""
        values: dict[str, str] = {}
        for service in self.compose_services().values():
            if not isinstance(service, dict):
                continue
            env = service.get("environment")
            if isinstance(env, dict):
                for key, val in env.items():
                    values[key] = "" if val is None else str(val)
            elif isinstance(env, list):
                for item in env:
                    if isinstance(item, str) and "=" in item:
                        key, val = item.split("=", 1)
                        values[key.strip()] = val.strip()
        return values
