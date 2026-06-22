# Skill overlap graph → harness/profile risk heatmap with allowed/disallowed tools

## Why

ECC's `AgentProfileConfig` encodes allowed_tools, disallowed_tools, permission_mode, token_budget and risk_thresholds per skill/profile. Extend the existing d3-force/three overlap graph in src/webview to color nodes by an aggregated risk score (Bash/Edit/Write presence × ECC-style review/confirm/block thresholds) and add edges weighted by shared tool surface, not just shared tags. This turns the current pretty graph into an actionable 'which skills will my agent actually be allowed to run, and which ones are dangerous together' view — a weekend-sized superpower for the Apply Recommended Skills flow.

## Inspired by

- https://github.com/affaan-m/ECC


## Decision

- [ ] **Adopt** — proceed with `tasks.md`
- [ ] **Defer** / **Reject**

_novelty 4/5 · effort 2/5 · promoted from a Project Steward idea you approved._
