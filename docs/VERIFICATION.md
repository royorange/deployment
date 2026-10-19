# 2026-10-19 本地验收

验证对象：`@royorange/project-setup` 0.3.0，独立维护于 `royorange/deployment`。

- `corepack pnpm lint`、`typecheck`、`test:coverage`、`build`、`format:check`、`test:package` 均成功。
- 默认加密存储变更后，本机 Node 26.7.0 执行 134 项合成测试通过；导入的工具模块行覆盖率 95.82%，分支覆盖率 83.61%。CLI 入口由安装包烟测与实际 PTY 单独验证。
- 先前版本在 Node 24.16.0 和本机默认 Node 26.7.0 各执行 118 项测试通过。CI 配置覆盖 Linux/macOS × Node 22/24；本次远端结果以对应提交的 Actions 为准。
- 在仓库外安装实际 tarball，验证编译后的 JS、帮助、内置模板、首次初始化、记录恢复及默认加密凭据重开，不依赖 Fulcord 源码。
- 统一存储覆盖 Cloudflare/Supabase/GitHub 合成凭据与敏感字段；验证公开状态不含凭据、错误口令/取消不覆盖或降级、路径/仓库/环境隔离、旧保险库导入、并发拒绝与连接回滚后的引用替换。`--no-vault` 和 `--memory` 不读取保险库。
- 在独立临时项目实走无 `--vault` 的 PTY 向导：首次两次隐藏输入主口令、隐藏输入合成 Publishable Key、自动加密保存、退出重开只解锁一次，核验 Key 正确恢复；临时项目与保险库已清理，未访问真实账号。
- 本机已安装到 `~/.local`；从用户目录执行 `project-setup` 能选择已有 Fulcord/zoncord，进入 API 默认连接，发出打开官方 Token 页请求后直接等待隐藏输入。测试未输入真实 PAT，没有创建或修改 Supabase 项目。
- `project-setup --doctor` 明确区分 API 与可选 CLI，验证本机 gh、目标/启动目录内 Wrangler 的可执行性。Fulcord 的 `corepack pnpm infra:setup --help` 经薄入口成功透传。
- 使用独立临时缓存下载官方 macOS arm64 CLI 2.120.0，SHA256、双可执行文件解包和 `--version` 实跑成功。首次下载网络超时，重试成功；临时缓存已清理。没有修改全局 Supabase CLI 或执行迁移。
- 安全回归包含：401/403 区分、scoped PAT 的资源绑定与显式降级确认、Key 按需重读、迁移前组织/Ref 复验、PAT 不导出、下载校验、恶意归档、缓存权限、安装并发与磁盘错误恢复。

配套 Fulcord 验证：lint、typecheck、format、构建成功；92 项应用测试和 11 项部署/入口测试通过。迁出后只保留项目映射与独立命令入口。

真实 scoped PAT 的账号权限、暂停项目恢复、托管网关和业务迁移仍需使用者明确提供授权后验证；合成测试和管理 API 可达不替代这些验收。

迁出后与 Fulcord 最新 main 对齐，保留 #12 的本机/云端 Secret 名称状态修复及五项回归测试；不因为源码迁移而回退该行为。
