# Render an agent-team overlap graph from ECC/harness orchestration configs

## Why

ECC and revfactory/harness express multi-agent teams as YAML/TOML configs (agent profiles, orchestration templates with steps, agents referencing shared skills). Parse those configs and reuse the existing d3-force/three.js 2D/3D overlap renderer to plot agents-as-nodes with edges weighted by shared-skill overlap and orchestration step dependencies, surfacing duplicate or redundant agents at a glance. This is a high-leverage reuse of the most distinctive part of SkillMatch's codebase (the skill graph) applied to a freshly trending data shape.

## Inspired by

- https://github.com/affaan-m/ECC
- https://github.com/revfactory/harness


## Decision

- [ ] **Adopt** — proceed with `tasks.md`
- [ ] **Defer** / **Reject**

_novelty 4/5 · effort 2/5 · promoted from a Project Steward idea you approved._
