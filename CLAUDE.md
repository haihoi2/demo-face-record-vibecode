# SmartFace Gate Watch

@AGENTS.md

Claude Code must follow the shared project context in `AGENTS.md` and the scoped rules under `.claude/rules/`.

## Required task declaration

Before editing, state:

- task and acceptance criteria
- owned and forbidden files
- API/schema/environment changes
- `server.ts touched: yes/no`
- tests that will be run

Use the project subagents in `.claude/agents/` for specialized work. Hermes remains the integration owner unless the task explicitly assigns that role elsewhere.

Do not edit, restart, deploy, or mutate live data when the requested task is review-only. Do not include secrets in prompts, logs, commits, handoffs, or responses.
