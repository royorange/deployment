# Development instructions

- 总是用中文回复用户。
- Use TypeScript and pnpm. Keep changes focused and maintainable.
- Read README.md and docs/ARCHITECTURE.md before architecture changes.
- Write regression tests before behavioral changes; use only synthetic credentials.
- Run lint, typecheck, test, coverage, build and package checks before committing.
- Delegate independent complex work and integrate reviews before finishing.
- Never print or commit tokens, keys, passwords, local project state or real account logs.
- Preserve original project files and existing provider identities. Preview external writes and require explicit confirmation in the tool.
- Do not deploy business applications, change billing, apply destructive database changes or merge pull requests without approval.
- Source maintenance belongs here; consumer repositories own their mappings and deployment workflows.
