# This evaluation task

## raw_task

{raw_task}

## User clarification history

{clarify_history}

## Evaluation context

- phase: {phase}
- round: {round}
- subject: {subject}

## Files you can read

cwd: `{task_root}` — the task root and its subdirectories are all readable.

Subpaths Meta flagged as the focus of this review (suggested to inspect first):

{additional_dirs}

Use your built-in tools to inspect the relevant files yourself.

## Harness file language directives

(For harness consistency self-audit.) When reviewing harness files (`workspace/harness/`), the expected content language for each file is determined by its primary consumer agent:

- `workspace/harness/worker_prompt_taskpart.md` → {worker_lang} (Worker is primary consumer)
- `workspace/harness/watcher_taskpart.md` → {watcher_lang} (Watcher is primary consumer)
- `workspace/harness/methodology.md` / `sop/*.md` / `done_criteria.yaml` configurations → {worker_lang} (Worker is primary consumer)

Tool names, file paths, YAML keys, code identifiers remain in English regardless of the directive above.

---

Output per the verdict protocol.
