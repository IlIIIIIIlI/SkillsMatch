# Skill Map

Skill Map is a VS Code sidebar extension that discovers local, workspace, and online agent skills, classifies them from their descriptions, indexes them into LightRAG, and recommends the right skills for the current project.

## What It Does

- Scans global skill roots for Claude, Copilot, Cursor, Gemini, OpenCode, and Codex.
- Scans workspace-local skill roots such as `.claude/skills`, `.github/skills`, `.agent/skills`, and `.codex/skills`.
- Fetches online skills from user-configured GitHub repository, folder, or direct `SKILL.md` links.
- Groups skills by `workspace`, `global`, and `online`.
- Classifies skills from their descriptions and displays category filters.
- Supports OpenRouter-based enrichment for 20 tags per skill.
- Syncs the current catalog into a dedicated LightRAG workspace.
- Provides a question box that retrieves candidates from LightRAG, ranks them with the configured OpenRouter model, and lets you apply the selected skills into the current workspace.
- Renders a tag overlap graph in a dedicated Webview view.

## Views

- `Skill Map / Explorer`
  - Tree view for `All Skills`, `Categories`, `Workspace`, `Global`, and `Online`.
- `Skill Map / Overview`
  - Prominent OpenRouter configuration card
  - LightRAG sync status and manual sync controls
  - GitHub link configuration for online skills
  - Question-driven skill recommendation
  - Project workspace selector and apply-to-project flow
  - Searchable skill cards
  - 2D / 3D tag overlap visualization

## OpenRouter

The extension stores the OpenRouter API key in VS Code SecretStorage.

Settings:

- `skillMap.openRouter.baseUrl`
- `skillMap.openRouter.model`
- `skillMap.openRouter.autoGenerateTagsOnRefresh`
- `skillMap.openRouter.batchSize`
- `skillMap.lightRag.baseUrl`
- `skillMap.lightRag.autoSyncOnRefresh`
- `skillMap.lightRag.syncTimeoutMs`
- `skillMap.onlineSources.githubUrls`
- `skillMap.project.applyRelativePath`

Commands:

- `Skill Map: Configure OpenRouter API Key`
- `Skill Map: Open OpenRouter Settings`
- `Skill Map: Clear OpenRouter API Key`
- `Skill Map: Generate AI Tags`
- `Skill Map: Configure LightRAG Base URL`
- `Skill Map: Configure GitHub Skill Sources`
- `Skill Map: Sync LightRAG Knowledge Base`
- `Skill Map: Apply Recommended Skills To Project`

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

- Online skills are discovered only from the GitHub links configured by the user.
- LightRAG sync uses a dedicated workspace namespace derived from the current VS Code workspace set.
- AI tag generation is cached by skill name + description hash to avoid repeated OpenRouter calls.
- This extension targets desktop VS Code because local filesystem scanning and project skill materialization depend on Node APIs.
