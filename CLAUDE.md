# Session Replay

@AGENTS.md

<!--
The shared agent context lives in AGENTS.md and is imported above, so Claude Code always sees the
same rules as every other agent. Don't copy its content here. Edit AGENTS.md, then run
`bun run sync:agents` to regenerate .github/copilot-instructions.md.
Only Claude Code-specific notes belong below.
-->

## Claude Code specifics

- **The main session is the leader** and the only writer of `plan/`. Sub-agents return reports, and
  the leader merges them into the plan files. Drafts may be written to the scratchpad and copied in
  by the leader after review.
- **All coding goes to the `coder` agent on the `sonnet` model:** one plan task (slice) per run, with
  the task's `owns:` list as its file boundary. reviewer, qa and debugger runs are batched per batch
  (see plan 01 → Sub-plans and parallel execution).
- **Planning phase:** start no coder runs or spikes until the user explicitly approves the plan.
- Before the first B1 handoff, run the `auditor` agent on the plan set.
