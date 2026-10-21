"""Redaction configuration for api-gateway request/response logging.

Source of truth for the claim verifier fixtures. Synthetic literals only.
"""

# Header/field keys whose values are redacted before logging.
REDACTION_KEYS = {"authorization", "cookie", "x-api-key"}

# Literal substituted in place of a redacted value.
REDACTION_PLACEHOLDER = "***"
