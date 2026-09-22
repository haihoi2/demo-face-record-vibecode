# Handoff rules

Every implementation task ends with a handoff based on `docs/agent-handoffs/TEMPLATE.md`.

The handoff must include:

- task and acceptance criteria
- branch/worktree, base SHA, and commit SHA(s)
- files changed and contracts/schema/environment changed
- `server.ts touched: yes/no`
- exact tests and results
- risks, migration, rollback, and compatibility notes
- unresolved questions and requested integration action

Do not claim completion without executed verification. If a gate cannot run, state the blocker and what was verified instead.

The integration owner reviews dependency order, hotspot ownership, migrations, and contract compatibility before cherry-picking or merging. After integration, rerun the complete applicable gates from the integrated branch.
