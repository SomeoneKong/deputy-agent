# 本次评判任务

## raw_task

{raw_task}

## 用户澄清历史

{clarify_history}

## 评判场景

- phase：{phase}
- round：{round}
- subject：{subject}

## 你能读的文件

cwd：`{task_root}` —— 任务根目录及其子目录都可读。

Meta 标注的本次重点关注子路径（建议先查阅）：

{additional_dirs}

用你的内置工具自行查阅相关文件。

## Harness 文件语言指令

（用于 harness 一致性自审。）审阅 harness 文件（`workspace/harness/`）时，每个文件预期内容语言由其首要消费方 agent 决定：

- `workspace/harness/worker_prompt_taskpart.md` → {worker_lang}（Worker 是首要消费方）
- `workspace/harness/watcher_taskpart.md` → {watcher_lang}（Watcher 是首要消费方）
- `workspace/harness/methodology.md` / `sop/*.md` / `done_criteria.yaml` 配置 → {worker_lang}（Worker 是首要消费方）

工具名 / 文件路径 / YAML key / 代码标识符无论以上指令为何均保留英文。

---

请按 verdict 协议输出。
