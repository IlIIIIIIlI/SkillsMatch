# Tasks

- [ ] Scope the feature against this repo's architecture (add `AgentProfileConfig`, `HarnessToolRisk`, and `SkillRiskScore` types to `src/shared/types.ts`; extend `ViewState` with an optional `harnessProfile` field)
- [ ] Implement risk-based node coloring in `graphNodeColor` (`src/webview/main.ts:2203`) — add a `'risk'` color mode that maps an aggregated risk score (Bash/Edit/Write presence × ECC-style thresholds) to a cool→hot gradient, alongside the existing `'category'` and `'overlap'` modes
- [ ] Implement tool-surface edge weighting in `buildSkillOverlapGraph` (`src/webview/main.ts:598`) — compute shared allowed/disallowed tool surface between skill pairs and blend it into the `weight` field used by the D3 force link strength (`src/webview/main.ts:801`) and the 3D layout attraction (`src/webview/main.ts:705`)
- [ ] Extend the graph UI controls (rendered near `src/webview/main.ts:483`) to expose a `'risk'` option in the `#graph-color-mode` select and update `graphColorLegend` accordingly
- [ ] Add unit tests for the risk-score aggregation and the tool-surface overlap computation
- [ ] Update documentation (README `## Changelog` and any relevant inline JSDoc)
