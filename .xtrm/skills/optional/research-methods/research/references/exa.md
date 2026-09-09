# Exa research routing

Use Exa for semantic web discovery, source retrieval, filtered search, and genuinely
multi-step external research. Exa is a retrieval substrate, not an authority: important
claims still require source inspection and validation.

Current managed Exa tools:

| Need | Tool |
|---|---|
| Targeted semantic web discovery | `web_search_exa` |
| Read/fetch a known or discovered URL | `web_fetch_exa` |
| Precise domain/date/filter-driven retrieval | `web_search_advanced_exa` |
| Broad, multi-hop, structured investigation | `agent_run` |

## Selection

Use the narrowest route that answers the question:

1. Known URL or primary page already identified -> `web_fetch_exa`.
2. One or a few focused external questions -> `web_search_exa`.
3. Date/domain/filter constraints materially affect precision -> `web_search_advanced_exa`.
4. Multi-hop, exhaustive, list-building, enrichment, or broad multi-source work where
   intermediate retrieval would pollute the main context -> `agent_run`.

Do not use `agent_run` merely because it exists. Simple questions should stay simple.

## Evidence discipline

- Query by distinct angle, not by synonym spam.
- Treat search results as candidates, not validated facts.
- Prefer original repositories, specifications, papers, official documentation, filings,
  and first-party statements for factual claims.
- Fetch the strongest candidate sources before relying on snippets.
- Deduplicate repeated URLs/entities before synthesis.
- Look for disconfirming evidence on consequential claims.
- Separate authoritative evidence from practitioner/community experience.
- State unresolved contradictions and evidence gaps explicitly.
- Include source dates/versions when freshness changes the conclusion.

## Tool boundaries

Exa complements rather than replaces specialized sources:

- current repository structure/impact -> GitNexus;
- exact library/API documentation -> official docs or a trusted documentation index;
- literal public implementation evidence -> public-code/GitHub search when more precise;
- broad semantic/current web discovery -> Exa.

## Authentication

XTRM manages the Exa MCP server. OAuth is preferred when the harness supports it.
Anonymous search/fetch may be rate-limited. Authenticated capabilities such as
`agent_run` may require OAuth or an API key supplied through the operator's environment
or secret store.

Never commit `EXA_API_KEY`, put it in MCP URLs, print it in output, or send unrelated
secrets/proprietary payloads in external queries. On authentication or rate-limit errors,
report the capability gap and the required operator action rather than silently pretending
an equivalent search was performed.

## Compatibility

Use the current tool names above. Do not teach or depend on retired Exa MCP tool names
such as `deep_researcher_start`, `crawling_exa`, or `get_code_context_exa`.
