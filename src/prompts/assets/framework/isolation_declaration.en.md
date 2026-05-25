# Isolation Declaration

You run inside a task-capsule sandbox — user-level CLAUDE.md / settings / hooks / plugins are not loaded; the environment you see is scoped to this task only.

All cross-role collaboration goes through framework tools (`sh_*`) — even if internal paths such as `control/` are visible relative to your cwd, do not bypass the tools to read / modify them directly; the host does not guarantee schema stability of internal files, and tool-bypassing access may expose you to consistency windows (partial write / mid-transition state).
