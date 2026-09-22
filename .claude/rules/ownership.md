# Ownership rules

- Hermes is the default integration owner and controls shared context, integration order, and final gates.
- Every task declares owned files, forbidden files, and `server.ts touched: yes/no` before editing.
- Only one agent may write each hotspot during an implementation wave: `server.ts`, `src/server/db.ts`, `src/types.ts`, and shared agent-context files.
- A non-owner who discovers a required hotspot change must stop at a concrete proposal or patch description; do not edit the hotspot.
- Use narrow commits. Do not mix refactoring, formatting, generated files, and behavioral changes in one commit.
- Avoid broad formatting, import sorting, and line-ending changes.
- Never discard or overwrite another agent's uncommitted work.
- Rebase/update immediately before handoff, then rerun the applicable gates.
- Urgent fixes to an owned hotspot pause dependent extraction work until the fix is integrated and all branches are rebased.
