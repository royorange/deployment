# Deployment / project-setup

Cloudflare、Supabase、GitHub 的独立交互配置工具。命令保持为 `project-setup`，业务仓库只保留变量映射和自己的部署流程。

需要 Node >=22.18，建议 Node 24；开发使用固定 pnpm 10.34.7。当前代码保留 `UNLICENSED`，尚未指定开源许可证。

## 安装与启动

首次从源码安装一次：

```bash
git clone https://github.com/royorange/deployment.git
cd deployment
corepack pnpm install --frozen-lockfile
corepack pnpm pack:local
npm install -g .artifacts/royorange-project-setup-0.3.0.tgz
```

之后在项目目录或用户目录运行：

```bash
project-setup
project-setup --doctor
```

也可在本仓库运行 `corepack pnpm dev`。不需要 npm 发布；打包产物可离线分发，安装依赖仍需本机缓存或网络。本仓库 CI 会验证并保存 tarball，不自动发布 npm 或 GitHub Release。

## 选择项目与初始化

启动首屏可选当前项目、已记录项目或输入其他目录。首次没有映射时，可用内置 zoncord 模板、通用映射或导入已有 JSON。Fulcord 团队映射示例位于 `examples/fulcord.json`，zoncord 位于 `examples/zoncord.json`。

用户映射保存到 `~/.config/project-setup/projects/<路径标签>-<16位哈希>/project.json`，设置 `XDG_CONFIG_HOME` 时使用对应目录。路径标签把分隔符换成横杠，哈希避免名称碰撞，项目根先解析成真实路径。映射导入为快照，原文件移动不影响后续启动。

优先级：显式 `--config` → 项目根 `infra.setup.json` → 用户目录映射。指定配置损坏或缺失会停止，不会切换到其他配置。项目子目录可以识别 Git 根或已记录的父目录。

```bash
project-setup --init                          # 初始化用户目录映射
project-setup --init --config infra.setup.json # 创建可提交的团队映射
project-setup --root /absolute/project         # 可选，跳过项目选择
```

显式 `--config`、`--root` 会跳过项目选择；单用 `--config` 以启动目录为项目根与相对配置基准，同时指定 `--root` 时以该项目目录为准。已有映射不覆盖。方向键选择、空格勾选、回车确认、Ctrl+C 取消当前向导。结果页停留到你明确返回；已完成的外部写入不会因退出回滚。

## Supabase：默认 API 连接

日常配置无需 Supabase CLI。选择 Supabase → 连接账号后，默认使用 Management API / PAT，向导会显示固定官方地址：

<https://supabase.com/dashboard/account/tokens>

可选“打开官方 Token 页面”“已有 Token，继续隐藏输入”或返回。浏览器打开失败时保留链接，手动打开后继续输入。浏览器登录、PAT 授权、本机 CLI 登录是不同状态；本工具不会读取浏览器 Cookie 或抓取其他工具保存的 Token。

建议创建限定资源范围、有限有效期的 scoped PAT：

- 列表选择需要 Organizations (Read)、Projects (account-wide) (Read)。没有列表权限时，可输入 Project Ref，使用 Project Settings (Read) 验证目标项目。
- 读取 Publishable Key 需要 API Keys (Read)、API Key Secrets (Read)。只选择所需权限与项目，不需要全权限 Legacy PAT。
- 修改 Auth URL 另需相应 Auth Config 与 Project Settings 写权限；工具预览 Site URL 和追加回调后才更新，保留原有 Redirect URL。

权限与端点以 [Supabase 官方 PAT 文档](https://supabase.com/docs/guides/platform/personal-access-tokens) 为准。401 提示检查失效/格式；403 提示检查资源范围和权限，不会一律要求重新登录。

组织/项目限定 PAT 可能无法读取用户资料。工具会明确标记“用户身份不可读”，按真实组织与 Project Ref 绑定并重复核验资源，绝不伪造用户 ID。已有用户身份绑定切换为资源范围绑定需要确认。API 可用不表示项目 Auth 网关或数据库可用；暂停项目仍需先到控制台恢复。

PAT 默认只保存在本次内存，不会导出到应用变量、GitHub 或项目 JSON。需要长期保留手动输入的凭据时，可主动使用 `project-setup --vault`；保险库以 scrypt + AES-256-GCM 加密，口令至少 12 字符且不保存。忘记口令无法恢复。重新运行未解锁保险库时，要重新输入 PAT；不会承诺明文永久登录。

已有官方 Supabase CLI profile 仍可显式选用。状态页可以重新读取绑定项目的 Publishable Key，但不会显示 Key 的值，也不代表数据库迁移或业务功能已验收。

## CLI 检查与按需安装

`project-setup --doctor` 不要求交互终端，显示 API 与 CLI 的依赖区别，不登录或自动下载：

- Supabase API 配置：工具内置，请提供授权 PAT。
- GitHub：复用官方 `gh`，需预先安装。
- Cloudflare：Wrangler 按目标项目依赖 → 启动目录依赖 → 全局命令查找。独立工具从用户目录启动时，不能凭空找到其他业务仓库私有的 Wrangler；需要目标/启动目录可用或全局安装。
- Supabase CLI：仅数据库迁移或显式官方 CLI 登录需要，要求 >=2.120.0。

缺少兼容 Supabase CLI 时，相关操作会展示官方固定版本 `2.120.0`、平台、来源 URL 和缓存路径。确认后下载官方 Release 压缩包，按代码中固定的 SHA256 校验，同时安装 `supabase` 与其配套 `supabase-go`。不执行远端安装脚本、不修改系统 PATH、不向业务仓库安装依赖。取消后返回结果页，不继续询问数据库密码或链接项目。

默认缓存位于 `~/.cache/project-setup/tools/supabase/<version>/<platform-arch>`，支持 `XDG_CACHE_HOME`。缓存使用前检查完整性、文件类型、所有者及私有权限；符号链接、硬链接、损坏压缩包、路径穿越与并发安装会停止并给出处理线索。下载失败可重试同一固定版本，不自动使用 latest。当前本机验收为 macOS arm64；Linux/macOS 的 CI 矩阵覆盖 Node 22/24，其他平台的元数据与合成测试不代表真实机器验收。

数据库迁移使用冻结的 SQL 快照、显式 Ref、官方迁移历史与 `db push --dry-run`。应用前须审阅 SQL 并完整输入目标 Ref；API 资源范围或官方 profile 身份会在相关步骤重新核验。数据库密码仅通过子进程环境传递。scope PAT 权限不等于数据库密码权限，不能把它当成数据库操作的完整限制。工具不自动 reset/repair，不推送 seed/Vault 设置。

## 本地状态与安全边界

命令、包名和 `~/.config/project-setup` 命名均保持兼容。公开状态按真实项目根、仓库、项目与 staging/production 环境隔离；同仓库的不同 checkout 不共享绑定。旧共享状态可确认复制到新路径，原文件保留。

状态页区分本机已载入、GitHub Environment 已配置（Secret 只确认名称，值不可读取）、已确认缺失和云端未知。只有明确绑定 GitHub 仓库后，才只读检查所选环境的 Variable/Secret 名称；不会读取 Secret 值或把它写入本地状态。每次刷新清除旧快照，读取前后核验 GitHub 身份和仓库。查询失败不沿用旧的“已配置”结论；Environment 级缺失不代表仓库或组织级配置缺失。

默认只保存公开配置与账号/profile 绑定。`--memory` 不读项目注册记录/绑定、不自动保存；显式初始化配置文件或选择导出仍可写入目标。`--vault` 只加密主动输入的额外凭据，不复制官方 CLI 登录 Token。

本地 `.env` 导入/导出要求目标在项目内、Git 未跟踪且已忽略；不会自动修改 `.gitignore`。只解析单行 dotenv，不执行插值或 shell。不要将导出文件作为 shell 脚本执行。剪贴板是明文，请按需清理历史；GitHub Secrets 无法回读。GitHub 同步仅写明确选中的项，不自动触发业务部署，不替换环境保护规则。

新建资源、Auth 修改和 GitHub 写入均显示具体目标并确认；创建付费资源、升级套餐、AWS 资源与业务发布仍由用户或项目既有部署流程处理。

## 开发验证

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:coverage
corepack pnpm build
corepack pnpm format:check
corepack pnpm test:package
```

测试仅使用合成身份和模拟服务。测试启动器会规范化 macOS 临时目录，保留产品对符号链接的防护。安装包测试在仓库外安装 tarball，验证编译 JS 入口、模板、初始化和重开恢复。维护架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
