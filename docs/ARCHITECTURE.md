# Architecture

Deployment maintains the standalone `@royorange/project-setup` Node CLI. Consumer repositories retain their `infra.setup.json` mappings, deployment workflows and application code.

- `src/cli.ts` wires startup, with `src/arguments.ts` selecting encrypted storage by default and explicit metadata-only or memory modes.
- `src/startup.ts` and `src/projects.ts` identify projects and store public mapping snapshots in the user's configuration directory.
- `src/guided-menu.ts` is the CLI navigation entrypoint, with six outer choices and persistent nested flows. It reuses provider actions and operations from `src/wizard.ts`; the latter's exported legacy router remains an integration harness, not a second CLI mode. Resource failures do not invalidate account evidence in the guided router.
- `src/setup-config.ts` validates optional component/auth/manual requirement declarations; `src/setup-model.ts` recomputes local requirements per project/environment without network access or a persisted completion cursor. Local configuration, remote resource evidence and application acceptance remain separate. Partial component declarations route to field editing rather than unrelated defaults. Project mapping snapshots preserve this metadata.
- `src/wizard.ts` orchestrates provider actions and concrete previews; `providers.ts` talks to fixed official API hosts. `src/pages-status.ts` classifies exact-branch Pages deployment evidence from the read-only API. `src/setup-evidence.ts` overlays timestamped session-only resource evidence, bound to environment/account/project/declared branch; a failed refresh invalidates only the selected component. Deployment data is projected onto public-only fields; URL adoption is explicit and cannot establish business availability. Multi-component Pages defaults and account invalidation honor component identities.
- Startup offers bounded AWS whole-app and separate frontend/admin/API templates. Separate API deployments, Firebase credentials, project-managed ledgers, optional integrations, backups and business tests remain consumer-owned workflows with explicit instructions; manifests cannot execute arbitrary shell hooks.
- `src/tunnels.ts` handles account-scoped remote Tunnel, zone and DNS APIs; its low-level default remains compatible with app:3000. The configuration wizard explicitly derives http://project-environment:3000 from the validated Tunnel name, previews it and requires confirmation before any route write; consumer containers must declare this private-network alias before migrating an existing app:3000 route. `src/deployment-wizard.ts` previews and confirms changes, stores connector tokens through the common vault and exports explicitly selected private files. `src/deployment-plan.ts` returns public-only configuration checks and performs optional read-only SSH preflight with strict existing host keys. Project build, deployment and rollback implementations remain in consumer repositories; the release menu invokes their declared adapter after CI and source validation.
- Supabase configuration defaults to the Management API with a user-supplied scoped PAT. Official CLI authentication remains an explicit alternative. Database migrations use the official CLI and its migration history.
- `src/storage.ts` provides the shared load/save/close lifecycle for all manually supplied provider credentials and secret fields; `src/state.ts` scopes public bindings by canonical root, repository, project and environment. `src/vault.ts` encrypts credentials using the existing scrypt/AES-256-GCM format. First use sets a passphrase; subsequent default runs unlock the same vault. Failed unlocks stop without fallback. Existing `--vault` data and `project-setup` storage names remain compatible; `--no-vault` retains public bindings only and `--memory` skips both stores.
- Official CLI dependencies are checked when needed; managed downloads use a pinned official release, integrity verification and private user cache. The tool does not rewrite global PATH or consumer dependencies.
- Tokens are never project defaults or public state. Hidden inputs, redacted errors and stdin/environment-only secret transfer are required. API authentication does not establish database, gateway or application health.
- `src/devices.ts` / `device-menu.ts` manage cross-project SSH connection profiles without storing credentials or persistent network sessions. Strict host keys, no agent forwarding and no port forwards apply to checks and deployment.
- `src/release-config.ts` validates bounded declarative release metadata; `release-ci.ts` checks the latest exact-SHA same-repository CI. `release-preflight.ts` verifies a clean, matching-origin checkout ignoring Git replacement refs, and limits adapter output/environment. `release-engine.ts` locks the project environment, confirms trusted repository code, declared per-component runtime fields and effects, runs official commit-frozen migrations before project deployment and writes redacted stage receipts. `release-menu.ts` composes these operations while retaining six home entries.
- Project release adapters are an explicit trusted-code boundary. Only tracked Node files and fixed plan/deploy/verify phases are invoked; no arbitrary shell strings or remote command responses are executed. Consumers implement build, publication and recovery, while setup orchestrates user-selected releases. No billing upgrades or unconfirmed business deployment occur. Project-managed migrations remain blocked until their controlled orchestration is implemented; no ledger guessing occurs.

The package compiles TypeScript to `dist` and distributes through a local tarball or reviewed GitHub release asset. No npm publication is required for local use. CI tests and packs without real provider credentials.

The optional human configuration entrypoint is `.project-setup/{environment}/.env`; explicit import/export keeps private file checks, Git ignore enforcement, variable selection and conflict decisions. Legacy `envExports` remains schema-compatible without a multiple-purpose menu. No mode automatically loads or writes this file. `release-runtime.ts` selects only declared secret project fields after adapter trust, and freezes them for protocol-v2 stdin across all phases. Management credentials and cleanup privileges are excluded. Absent `runtimeFields` preserves v1; an empty array opts in to v2 with no runtime secrets. Adapters own isolated runtime materialization and cleanup; human exports are unnecessary for deployment.

## 可恢复部署向导

`deployment-guide.ts` 串联项目适用阶段，`deployment-guide-actions.ts` 复用现有服务操作；`deployment-guide-model.ts` 从字段、设备、会话只读证据及历史摘要计算状态，`deployment-guide-store.ts` 以目标作用域和 CAS 保存导航。公开目标绑定变化清除旧核验，历史记录只展示为待复查。取消、void 返回、缺失连接 Token 或单纯本地字段齐全都不构成发布成功。

`release-flow.ts` 是菜单与向导共用的组件发布入口；`release.ts` 保留 CI、冻结迁移、发布确认及健康检查权责。向导不自行执行迁移或适配器，不从历史摘要跳过这些门禁。`@releaseDeviceId` 是公开导航绑定；显式选中设备已删除时要求重新选择，不回退其他旧设备。只读 provider probes 不提示输入凭据或修改资源，失败时回到对应修复步骤。

阶段依赖摘要由 `deployment-guide-bindings.ts` 在内存计算，只包含公开字段和凭据存在性，不保存 secret 内容或其摘要。整体目标绑定仍作用于磁盘历史；同次会话仅失效依赖变化的阶段。失败路径先同步目标绑定再保存 cursor，避免部分远端创建成功后重开丢失位置。

Tunnel 初始化采用显式空配置快照；HTTP 错误、缺失 `config` 或已有正版本但无配置均拒绝初始化。写前核验远程 Tunnel 归属、Zone、完整快照与版本；此检查不是服务端原子 CAS。原严格配置读取用于现有路由，初始化须单独确认，错误只输出受控状态和操作建议。

`tunnel-readback.ts` 仅对空 originRequest 和精确的 disabled warp-routing 做等价归一化后深比较；其余全部配置保留在比较范围。写后与只读核验使用相同语义，受控诊断保留失败阶段与 HTTP 状态，不附带原始异常。远端阶段可只读重试现有绑定；明确修改配置才进入原账号/资源操作，不自动重连或改用其他 Token。

## 运行生命周期

`lifecycle-protocol.ts` 验证独立的 inspect/apply 协议；`lifecycle-engine.ts` 冻结受信适配器、公开目标、设备和控制提交。状态检查不要求 CI、不写远端资源；变更在 CI 通过后使用与发布共享的作用域锁，预览、确认并以远端快照令牌调用 apply，随后重新检查目标状态。`lifecycle-menu.ts` 在部署菜单内提供按需刷新、停止、恢复和兼容版本回退，外层仍为六项。

`lifecycle-audit.ts` 只记录公开的操作、版本、设备和结果。请求不接收 runtimeValues 或管理凭据，不调用迁移。状态为 unknown/busy 时阻止变更；读取错误不能被当作未部署。项目适配器负责远端锁、容器归属、资源约束、兼容性及恢复日志；工具不会猜测旧版本安全性，也不自动降级数据库。

## 0.10 构建、CI证据与只读恢复

`release-build.ts` 通过受信项目适配器执行plan/build，绑定完整源码和公开配置；产物采用与业务发布分开。`release-ci-policy.ts` 以单次gate实例维护已核验CI记录，临时故障的显式非生产降级最多300秒，回执记录真实run attempt与降级事实。`github-read.ts` 只解析固定只读CI请求的白名单HTTP元数据，不保留响应正文或凭据。默认严格模式保留。

`deployment-guide-inspection.ts` 复用lifecycle inspect重新读取实际运行版本，显式保留旧版本只代表该版本当前健康。向导逐组件记录本次证据，配置变化和新发布尝试使旧证据失效。Pages API观测不自动通过HTTP/业务验收。完整设计、构建位置选择和Zoncord复合适配器/迁移账本门禁见 [RELEASE_DESIGN.md](RELEASE_DESIGN.md)。
