# Architecture

Deployment maintains the standalone `@royorange/project-setup` Node CLI. Consumer repositories retain their `infra.setup.json` mappings, deployment workflows and application code.

- `src/cli.ts` owns arguments, local storage modes and startup.
- `src/startup.ts` and `src/projects.ts` identify projects and store public mapping snapshots in the user's configuration directory.
- `src/wizard.ts` orchestrates provider actions and concrete previews; `providers.ts` talks to fixed official API hosts.
- Supabase configuration defaults to the Management API with a user-supplied scoped PAT. Official CLI authentication remains an explicit alternative. Database migrations use the official CLI and its migration history.
- `src/state.ts` scopes public bindings by canonical root, repository, project and environment. `src/vault.ts` preserves optional encrypted manual credentials. Existing `project-setup` storage names remain compatible.
- Official CLI dependencies are checked when needed; managed downloads use a pinned official release, integrity verification and private user cache. The tool does not rewrite global PATH or consumer dependencies.
- Tokens are never project defaults or public state. Hidden inputs, redacted errors and stdin/environment-only secret transfer are required. API authentication does not establish database, gateway or application health.
- Project operations do not publish business code or upgrade plans. Consumer deployment scripts remain responsible for validation and release.

The package compiles TypeScript to `dist` and distributes through a local tarball or reviewed GitHub release asset. No npm publication is required for local use. CI tests and packs without real provider credentials.
