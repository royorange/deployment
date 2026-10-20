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
npm install -g .artifacts/royorange-project-setup-0.5.0.tgz
```

之后在项目目录或用户目录运行：

```bash
project-setup
project-setup --doctor
```

也可在本仓库运行 `corepack pnpm dev`。不需要 npm 发布；打包产物可离线分发，安装依赖仍需本机缓存或网络。本仓库 CI 会验证并保存 tarball，不自动发布 npm 或 GitHub Release。

## 选择项目与初始化

启动首屏可选当前项目、已记录项目或输入其他目录。首次没有映射时，可选择 AWS 整站、独立前后台/API、zoncord 模板、通用映射或导入已有 JSON。Fulcord 团队映射示例位于 `examples/fulcord.json`，zoncord 位于 `examples/zoncord.json`。

用户映射保存到 `~/.config/project-setup/projects/<路径标签>-<16位哈希>/project.json`，设置 `XDG_CONFIG_HOME` 时使用对应目录。路径标签把分隔符换成横杠，哈希避免名称碰撞，项目根先解析成真实路径。映射导入为快照，原文件移动不影响后续启动。

优先级：显式 `--config` → 项目根 `infra.setup.json` → 用户目录映射。指定配置损坏或缺失会停止，不会切换到其他配置。项目子目录可以识别 Git 根或已记录的父目录。

```bash
project-setup --init                          # 初始化用户目录映射
project-setup --init --config infra.setup.json # 创建可提交的团队映射
project-setup --root /absolute/project         # 可选，跳过项目选择
```

显式 `--config`、`--root` 会跳过项目选择；单用 `--config` 以启动目录为项目根与相对配置基准，同时指定 `--root` 时以该项目目录为准。已有映射不覆盖。方向键选择、空格勾选、回车确认、Ctrl+C 取消当前向导。结果页停留到你明确返回；已完成的外部写入不会因退出回滚。

## 简单菜单与项目向导（0.5.0）

外层固定六个入口：引导配置、账号与服务、查看状态、导入与导出、项目/环境/高级设置、保存并退出。服务操作完成后停留在当前流程；返回上一级不会退出。项目在启动时选择，切换项目可保存退出后重开，无需输入长路径。

建议首次选择“引导配置”，以后用“查看状态 / 补齐缺项”。每项说明用途、当前状态、配置位置和验证方法，可以直接进入对应操作。向导根据当前项目和环境重新计算，不保存虚假的“已完成”游标；取消、失败或手动跳过不会标记成功。状态页默认只读本地配置，联网检查需明确选择；本地配置不等于账号已验证、资源已部署或业务可运行。

项目映射可选 `setup` 声明：

- `auth`：`supabase`、`firebase`、`external` 或 `none`。Firebase 项目不会被引导去修改 Supabase Auth。
- `components`：分别声明前台、后台、API 和任务服务，关联公开的 Origin、托管项目、分支字段；同一字段通过环境默认值或当前环境配置隔离。后台须单独验证鉴权与默认托管地址绕过风险。
- `requirements`：声明项目需要的 Storage、受限数据库角色、任务、可选支付/AI/推送、日志、备份恢复等配置和检查说明。只有项目声明的可选能力才展开；没有自动验证器的项目明确显示人工验证，不支持任意命令钩子。

使用内置 AWS 整站 Tunnel 或独立前台/后台/API 模板可快速初始化；AWS 自动路由模板约定容器服务为 `app:3000`，其他服务名或端口应沿用项目流程。`examples/shimau.json` 提供按 shimau 拓扑整理的无凭据示例。模板是配置起点，实际镜像构建、迁移、发布、回滚和业务检查仍由项目已有流程负责。

Pages 操作支持分别选择前台/后台组件，明确输入真实分支，只读读取部署列表。空项目、所选分支无记录、构建中、失败、已发布和查询未知分别报告；只展示 API 返回并校验过的实际部署 URL。保存为入口需要确认，不自动覆盖自定义域名，不拼接 `staging.<项目>.pages.dev`。状态页保留本次会话的组件检查时间与 API 发布记录；换绑定后失效，重新查询失败不沿用旧成功。API 报告发布成功仍需单独验证域名、Access 和业务功能。

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

PAT 与其他服务手动输入的 Token、项目 Key 共用本机加密保险库，连接验证成功后保存；不会导出管理 PAT 到应用变量、GitHub 或项目 JSON。下次直接运行 `project-setup`，解锁后即可复用已保存凭据，无需重新生成 Token。

已有官方 Supabase CLI profile 仍可显式选用。状态页可以重新读取绑定项目的 Publishable Key，但不会显示 Key 的值，也不代表数据库迁移或业务功能已验收。

## CLI 检查与按需安装

`project-setup --doctor` 不要求交互终端，显示 API 与 CLI 的依赖区别，不登录或自动下载：

- Supabase API 配置：工具内置，请提供授权 PAT。
- GitHub：复用官方 `gh`，需预先安装。
- Cloudflare：Wrangler 按目标项目依赖 → 启动目录依赖 → 全局命令查找。独立工具从用户目录启动时，不能凭空找到其他业务仓库私有的 Wrangler；需要目标/启动目录可用或全局安装。
- Supabase CLI：仅数据库迁移或显式官方 CLI 登录需要，要求 >=2.120.0。

缺少兼容 Supabase CLI 时，相关操作会展示官方固定版本 `2.120.0`、平台、来源 URL 和缓存路径。确认后下载官方 Release 压缩包，按代码中固定的 SHA256 校验，同时安装 `supabase` 与其配套 `supabase-go`。不执行远端安装脚本、不修改系统 PATH、不向业务仓库安装依赖。取消后返回结果页，不继续询问数据库密码或链接项目。

默认缓存位于 `~/.cache/project-setup/tools/supabase/<version>/<platform-arch>`，支持 `XDG_CACHE_HOME`。缓存使用前检查完整性、文件类型、所有者及私有权限；符号链接、硬链接、损坏压缩包、路径穿越与并发安装会停止并给出处理线索。下载失败可重试同一固定版本，不自动使用 latest。当前本机验收为 macOS arm64；Linux/macOS 的 CI 矩阵覆盖 Node 22/24，其他平台的元数据与合成测试不代表真实机器验收。

只有 manifest 明确声明 `migrationStrategy: "supabase-cli"` 才能使用官方迁移入口；`project-managed` 或未声明时，在安装 CLI、读取密码与连接数据库前拒绝。Fulcord 示例声明官方 CLI，Zoncord 示例声明项目自管。此门禁不代表已探测远端历史，不能自动证明账本兼容。

数据库迁移使用冻结的 SQL 快照、显式 Ref、官方迁移历史与 `db push --dry-run`。应用前须审阅 SQL 并完整输入目标 Ref；API 资源范围或官方 profile 身份会在相关步骤重新核验。数据库密码仅通过子进程环境传递。scope PAT 权限不等于数据库密码权限，不能把它当成数据库操作的完整限制。工具不自动 reset/repair，不推送 seed/Vault 设置。

## AWS 与 Cloudflare Tunnel 部署准备

0.4 增加「AWS / Zero Trust Tunnel 部署准备」模块。当前自动配置仅支持 manifest 明确声明 `deploymentTopology: "aws-tunnel"` 的整应用同源拓扑；Fulcord 示例已声明。Zoncord 的 Worker + Access + 私有 API 拓扑不能直接套用，未声明或不同拓扑会拒绝修改入口。工具准备配置与检查，业务容器构建、传输、发布与回滚仍由消费项目的部署脚本负责。

- 录入 SSH 别名/`user@host`、项目与环境独立目录、应用与官方 cloudflared 的固定镜像 digest，以及 HTTPS 自定义应用域名。合成文件与清理调度分别配置；开启合成文件必须同时启用独立清理及其凭据。
- 复用当前 Cloudflare 账号验证活动 Zone；只复用 `${project}-${environment}` 的专用远程 Tunnel。预览并确认后配置到容器网络 `http://app:3000`，保留无关 ingress 和末尾 404；DNS 仅在无记录时新增，冲突不覆盖。列表或权限失败不当作“资源不存在”。
- 连接 Token 存入通用保险库；更换 Tunnel 或 Cloudflare 账号会清除旧的项目连接 Token。切换 Supabase 项目同样清除旧清理 Key，并关闭合成文件/清理开关，避免跨项目复用。
- Wrangler 的 OAuth 不保证具有 DNS 权限。可另配目标账号 Tunnel Edit、目标 Zone Read/DNS Edit 的管理 Token；它保存在独立别名中，保留原 Wrangler 与 CI Token 绑定，不作为容器连接 Token 导出。读取权限通过后仍需在具体写入时核验写权限。
- SSH 预检只读检查 Docker/Compose、CPU 架构、内存、磁盘和监听端口，严格校验现有主机密钥，不安装软件或绕过 SSH 认证。使用现有 SSH 配置，不将私钥导入工具。
- 部署计划只返回公开配置，凭据只判断是否已载入；字段完整不代表 Tunnel、数据库迁移或业务应用已验收。Secret 在 GitHub 的名称存在也不代表其值已与当前项目核对。

Tunnel Token 可单独导出为项目内、Git 已忽略的原始私密文件，权限 600；其他运行文件使用项目 manifest 声明的分离 `.env` 预设。导出会显示目标并确认，不能把 Token 当成应用前端 Key。明确新建 Tunnel 后仍无法读取初始配置时，保留并报告新建 ID，不猜测空配置或自动删除资源。

项目映射与工具版本应一同更新；旧工具遇到新字段会停止，需要更新已安装的 `project-setup`，不会忽略未知字段继续运行。macOS/Windows 上的 SSH 检查不证明目标平台 Docker 镜像架构兼容，发布前仍须核对主机架构。

目前仍待通用化的能力：原生隔离 `--env-file`、按环境精确 Auth callbacks、远端迁移账本探测与项目 bootstrap、自动脱敏审计、Worker/Access/私有 API 全链路检查。现有 Auth 网关检查不验证 executor 或业务数据库；官方 CLI 迁移入口不能用于另有迁移账本的项目。Zoncord 的 `public.schema_migrations` bundle 与 Supabase 官方 CLI 历史不可混用。

## 本地状态与安全边界

命令、包名和 `~/.config/project-setup` 命名均保持兼容。公开状态按真实项目根、仓库、项目与 staging/production 环境隔离；同仓库的不同 checkout 不共享绑定。旧共享状态可确认复制到新路径，原文件保留。

状态页区分本机已载入、GitHub Environment 已配置（Secret 只确认名称，值不可读取）、已确认缺失和云端未知。只有明确绑定 GitHub 仓库后，才只读检查所选环境的 Variable/Secret 名称；不会读取 Secret 值或把它写入本地状态。每次刷新清除旧快照，读取前后核验 GitHub 身份和仓库。查询失败不沿用旧的“已配置”结论；Environment 级缺失不代表仓库或组织级配置缺失。

直接运行 `project-setup` 默认启用统一加密保险库，存取 Cloudflare、Supabase 等服务的手动 Token、项目 Key 和映射中标记为敏感的字段。账号凭据按别名跨项目复用；项目配置按真实路径、仓库与环境隔离。增加服务不需要另写一套磁盘存储。

首次隐藏输入并确认至少 12 字符的主口令；以后只需解锁。保险库位于 `~/.config/project-setup/vault.json`（支持 `XDG_CONFIG_HOME`），使用 scrypt 派生密钥与 AES-256-GCM 加密，文件权限 600。主口令不保存，忘记无法恢复；解锁失败或取消会停止，不覆盖旧文件或自动降级。原有 `--vault` 数据与命令继续兼容。macOS 钥匙串自动解锁尚未实现。

`--no-vault` 仅保存公开配置与账号绑定，本次凭据退出后丢弃，不读写保险库。`--memory` 连项目注册记录/绑定也不读取或自动保存；显式初始化配置文件或选择导出仍可写入目标。两者与 `--vault` 互斥。官方 CLI 登录凭据仍由官方工具管理，不复制到保险库；明确标注为临时的 Auth PAT、迁移数据库密码仍仅供对应操作使用。

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
