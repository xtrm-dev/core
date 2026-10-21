"""Prometheus metric definitions for the runner fleet. Source of truth for fixtures."""

from prometheus_client import Counter

JOBS_TOTAL = Counter(
    "runner_jobs_total",
    "Total number of runner jobs processed.",
    labelnames=("queue", "result"),
)
