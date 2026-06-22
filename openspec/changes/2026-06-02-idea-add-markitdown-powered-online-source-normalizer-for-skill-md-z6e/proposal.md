# Add markitdown-powered online source normalizer for SKILL.md ingestion

## Why

SkillMatch already pulls online skills from GitHub repos, folders, and direct URLs, but real-world sources (PDFs, DOCX, HTML pages, even YouTube) aren't SKILL.md-shaped. Spawn microsoft/markitdown as a sidecar (via child_process to a `pip install markitdown` venv, or its CLI) to normalize any fetched artifact into token-efficient Markdown before tagging, then route the structured output into the existing OpenRouter enrichment + LightRAG sync pipeline. This turns 'any document' into a catalogable skill with almost no new UI.

## Inspired by

- https://github.com/microsoft/markitdown


## Decision

- [ ] **Adopt** — proceed with `tasks.md`
- [ ] **Defer** / **Reject**

_novelty 3/5 · effort 2/5 · promoted from a Project Steward idea you approved._
