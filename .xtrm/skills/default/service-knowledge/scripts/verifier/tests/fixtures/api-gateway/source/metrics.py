"""Prometheus metric definitions for api-gateway. Source of truth for fixtures."""

from prometheus_client import Histogram

REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency in seconds.",
    labelnames=("method", "status", "route"),
)
