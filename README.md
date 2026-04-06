# Skill Map

Skill Map is a VS Code sidebar extension that discovers local, workspace, and online agent skills, classifies them from their descriptions, and visualizes overlapping tags as circles.

## What It Does

- Scans global skill roots for Claude, Copilot, Cursor, Gemini, OpenCode, and Codex.
- Scans workspace-local skill roots such as `.claude/skills`, `.github/skills`, `.agent/skills`, and `.codex/skills`.
- Fetches online skill catalogs from:
  - `anthropics/skills`
  - `github/awesome-copilot`
  - `pytorch/pytorch`
  - `openai/skills`
  - `formulahendry/agent-skill-code-runner`
- Groups skills by `workspace`, `global`, and `online`.
- Classifies skills from their descriptions and displays category filters.
- Supports OpenRouter-based enrichment for 20 tags per skill.
- Renders a tag overlap graph in a dedicated Webview view.

## Views

- `Skill Map / Explorer`
  - Tree view for `All Skills`, `Categories`, `Workspace`, `Global`, and `Online`.
- `Skill Map / Overview`
  - Summary metrics
  - Category and source filters
  - Searchable skill cards
  - Detail panel
  - Circle-based tag overlap visualization

## OpenRouter

The extension stores the OpenRouter API key in VS Code SecretStorage.

Settings:

- `skillMap.openRouter.baseUrl`
- `skillMap.openRouter.model`
- `skillMap.openRouter.autoGenerateTagsOnRefresh`
- `skillMap.openRouter.batchSize`

Commands:

- `Skill Map: Configure OpenRouter API Key`
- `Skill Map: Clear OpenRouter API Key`
- `Skill Map: Generate AI Tags`

## Development

```bash
npm install
npm run compile
npm test
```

Security automation included in the repository:

- `Dependabot` for `npm` and `github-actions`
- `Trivy` filesystem scan on push, PR, and weekly schedule
- `ClamAV` malware scan on push, PR, and weekly schedule

For interactive development:

```bash
npm run watch
```

Then launch `Run Skill Map` from the VS Code debugger.

To force a clean Visual Studio Code development host from the terminal:

```bash
npm run dev:vscode
```

## Project Structure

- `src/core`
  - discovery, parsing, classification, OpenRouter integration, graph building
- `src/views`
  - tree provider and webview provider
- `src/webview`
  - browser-side UI and circle visualization
- `test`
  - unit tests and extension smoke tests

## Notes

- Online skill refresh happens on extension activation, with cached fallback if GitHub is unavailable.
- AI tag generation is cached by skill name + description hash to avoid repeated OpenRouter calls.
- This extension targets desktop VS Code because local filesystem scanning depends on Node APIs.
