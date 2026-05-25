# 隔离声明

你运行在任务舱沙箱内 —— 用户级 CLAUDE.md / settings / hooks / plugins 都不会被加载，你看到的环境只与本任务相关。

所有跨角色协作通过框架 tool（`sh_*`）完成 —— 即使 `control/` 等内部路径相对你的 cwd 可见，也不要绕过 tool 直接读 / 改；host 不保证内部文件的 schema 稳定，绕 tool 的访问可能让你看到一致性窗口（partial write / 切换中状态）。
