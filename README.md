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
npm install -g .artifacts/royorange-project-setup-0.9.2.tgz
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

## 简单菜单与项目向导（0.7.0）

外层固定六个入口：引导配置、账号/项目/服务、查看状态、导入与导出、部署与发布、保存并退出。项目/环境/高级设置收在账号页。服务操作完成后停留在当前流程；返回上一级不会退出。项目在启动时选择，切换项目可保存退出后重开，无需输入长路径。

配置了发布适配器的环境，首次选择“开始 / 继续部署（自动引导）”。同一入口依次处理可选统一配置导入、Cloudflare、设备、部署参数、Tunnel、Supabase、Auth、CI/迁移/应用发布、Pages 与业务验收；仅显示项目适用的阶段。显示当前阶段、配置就绪数量、本次核验数量、待补字段与下一步，已有配置直接复用。只读检查可以自动进行；资源修改、迁移和发布保留预览与确认。取消或失败停在当前阶段，已保存的配置继续复用，无需逐个寻找服务子菜单。没有发布声明的环境沿用配置向导。

进度按项目路径、仓库、环境保存在 `~/.config/project-setup/guides/`（支持 `XDG_CONFIG_HOME`），目录 700、文件 600；只保存公开目标绑定、设备 ID、导航和历史摘要，不保存 Token、Key、口令或原始日志。重新进入会区分“本地已配置”“本次已核验”“上次结果，待复查”和“需人工验收”；历史成功不会自动当作当前远端成功，也不会自动重放发布。目标、提交或配置变化会使相关旧核验失效。同次会话使用阶段依赖保留无关核验；例如写入 Tunnel ID 不会清掉 Cloudflare 账号核验或要求重新选择设备。动作部分保存后失败也会记录新目标绑定和当前阶段，重开可从失败阶段继续。内存模式不读写进度。保存退出直接结束工具，返回主菜单则保留当前位置。

应用发布仍由既有引擎核对干净 HEAD、精确 CI、迁移预演与确认、目标设备和健康结果；数据库已应用但应用失败时明确停下，不自动回滚。应用失败不会继续 Pages。发布与基础健康通过后，业务验收仍按项目清单进行。

项目映射可选 `setup` 声明：

- `auth`：`supabase`、`firebase`、`external` 或 `none`。Firebase 项目不会被引导去修改 Supabase Auth。
- `components`：分别声明前台、后台、API 和任务服务，关联公开的 Origin、托管项目、分支字段；同一字段通过环境默认值或当前环境配置隔离。后台须单独验证鉴权与默认托管地址绕过风险。
- `requirements`：声明项目需要的 Storage、受限数据库角色、任务、可选支付/AI/推送、日志、备份恢复等配置和检查说明。只有项目声明的可选能力才展开；没有自动验证器的项目明确显示人工验证，不支持任意命令钩子。

使用内置 AWS 整站 Tunnel 或独立前台/后台/API 模板可快速初始化；AWS 自动路由模板使用 `http://${project}-${environment}:3000`（例如 `http://fulcord-staging:3000`）；应用容器须在项目私有网络声明同名网络别名，并监听 3000 端口，连接器须加入该网络。其他端口沿用项目流程。`examples/shimau.json` 提供按 shimau 拓扑整理的无凭据示例。模板是配置起点，实际镜像构建、迁移、发布、回滚和业务检查仍由项目已有流程负责。

Pages 操作支持分别选择前台/后台组件，明确输入真实分支，只读读取部署列表。空项目、所选分支无记录、构建中、失败、已发布和查询未知分别报告；只展示 API 返回并校验过的实际部署 URL。保存为入口需要确认，不自动覆盖自定义域名，不拼接 `staging.<项目>.pages.dev`。状态页保留本次会话的组件检查时间与 API 发布记录；换绑定后失效，重新查询失败不沿用旧成功。API 报告发布成功仍需单独验证域名、Access 和业务功能。

## 部署与 SSH 主机（0.7.0）

“部署与发布”统一提供 Tunnel 创建/配置、可选统一配置导入导出、目标主机管理、精确 CI 核验、手动镜像构建和组件发布。Pages 可单独发布；选择全部时先发布应用，失败即停止后续组件，不自动撤销已成功的数据库或其他组件。

设备档案只保存名称、IP/DNS/SSH 别名、用户名和端口，位于 `~/.config/project-setup/devices/devices.json`（支持 `XDG_CONFIG_HOME`），目录 700、文件 600，跨项目复用。认证沿用本机 SSH agent、默认密钥或 SSH 配置，不存密码、私钥内容或常驻网络会话。首次主机指纹必须自行核对，工具不自动接受未知主机；检查与部署关闭 agent/端口转发。内存模式不读取或保存设备档案。项目发布目录由项目配置管理。

项目可声明严格的 `release` 映射，示例见 `examples/fulcord.json`：

- `adapter`：项目内已跟踪的 `deploy/*.mts` 或 `.mjs`，不是任意 shell 字符串。首次调用计划前明确确认信任该提交的代码及其将读取的运行字段。
- `ciWorkflow`：同仓库 CI 的文件名。部署仅支持干净本地 HEAD，核验对应完整 SHA 的最新 CI 成功；新失败、重跑中、fork 或身份未知均阻止。核验源码与迁移时忽略本地 Git 替换对象。
- `buildWorkflow` / `buildWorkflowRef`：可选镜像构建工作流及其受信运行分支（默认 main）。工作流运行分支与待构建提交分开，完整提交通过 `commit` input 传入。构建只生成镜像/digest，不自动部署应用；将 digest 录入当前环境配置后直接发布，无需导出运行文件。
- `environments`、`components`：明确哪些环境可发布，以及 Pages/应用是否需要 SSH 主机和哪种迁移策略。
- `publicFields`：显式允许传给适配器的公开字段，不允许凭据。Pages 部署 Token 仅单次注入子进程环境。
- 组件 `runtimeFields`：显式声明该组件需要的项目敏感字段，禁止账号管理 Token、凭据别名和特权清理 Key。声明后使用协议 v2（空数组也采用 v2）；只从当前项目/环境提取。Fulcord 应用仅接收 Publishable Key 与 Tunnel 连接 Token，Pages 为 `[]`。

适配器协议：固定 Node 参数 `--phase plan|deploy|verify`，标准输入为 JSON `{version:1,project,environment,component,commit,ci:{runId},device?,publicValues}`。组件声明 `runtimeFields` 时输入改为 `{version:2,...,runtimeValues}`；没有声明的旧适配器继续收到 v1。只有确认信任已提交代码后才按需读取 Key 并构造运行配置；冻结后所有阶段使用同一份数据。敏感值仅经 stdin，完整保险库和账号管理凭据不会传入项目适配器。输出单个 JSON `{ready,summary,missing,effects}`，不打印 Secret 或原始进程输出。适配器是受信项目代码，负责项目的发布、恢复和专门验收；通用工具不猜测容器布局，也不执行远端返回的命令。

发布顺序：CI/提交检查 → 受信适配器计划 → 用户确认 → 官方迁移预演/应用/再次核验 → 再核对 CI/源码 → 项目部署 → 基础健康验证。迁移是发布阶段，只执行待应用版本，不由每个应用实例启动执行。SQL 从已通过 CI 的提交构造冻结快照；未知 CLI 输出、取消或未确认迁移都会停止应用发布。bootstrap、专用账号和业务验收按项目声明完成，不自动生成默认登录或 seed 数据。项目自管迁移暂明确阻塞自动应用发布，避免混用其账本。

发布回执只含项目、环境、组件、SHA、设备标识、CI run 和阶段状态，默认保存在用户配置目录的 `releases` 下；内存模式仅在本次显示。迁移已完成但应用失败会保留数据库状态，不执行 down/reset/repair。项目适配器另行记录自己的发布与恢复证据。

Fulcord 初始适配器只开放 staging，采用固定 digest 的 amd64 镜像、OCI revision 核验和独立候选目录；需主机具备 sudo -n、Docker Compose、严格 SSH 指纹、至少 768 MiB 可用内存与 4 GiB 可用磁盘，以及镜像仓库拉取权限。同一 SHA 的运行配置改变会拒绝复用该版本。合成文件/cleanup 暂不由此新发布适配器开放。以上是具体消费项目边界，不代表任意新项目已具备同样的发布脚本。

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

数据库迁移使用冻结的 SQL 快照、显式 Ref、官方迁移历史与 `db push --dry-run`。发布计划已确认时直接进行只读账本检查；手动迁移入口仍先确认预演。预演后展示项目、环境、目标 Ref 和待执行文件；审阅 SQL 后，非生产环境用一次默认 No 的确认实际应用，生产环境需输入可读的 `项目名/production`，不再手抄 Ref。确认期间目标或账号绑定变化会拒绝继续；API 资源范围或官方 profile 身份仍会在相关步骤重新核验。取消、确认不匹配或错误会阻止后续应用发布。数据库密码通过子进程环境传递，只有预演明确确认待执行文件或 up-to-date 后才在当前进程复用；切换目标或身份、迁移核验失败会清除缓存。每次重试仍重新核对官方账本，后续应用发布失败不清除此已验证密码。密码不会进入保险库、公开状态、应用配置或发布适配器，退出进程后失效。scope PAT 权限不等于数据库密码权限，不能把它当成数据库操作的完整限制。工具不自动 reset/repair，不推送 seed/Vault 设置。

## AWS 与 Cloudflare Tunnel 部署准备

0.4 增加「AWS / Zero Trust Tunnel 部署准备」模块。当前自动配置仅支持 manifest 明确声明 `deploymentTopology: "aws-tunnel"` 的整应用同源拓扑；Fulcord 示例已声明。Zoncord 的 Worker + Access + 私有 API 拓扑不能直接套用，未声明或不同拓扑会拒绝修改入口。工具准备配置与检查，业务容器构建、传输、发布与回滚仍由消费项目的部署脚本负责。

- 录入 SSH 别名/`user@host`、项目与环境独立目录、应用与官方 cloudflared 的固定镜像 digest，以及 HTTPS 自定义应用域名。合成文件与清理调度分别配置；开启合成文件必须同时启用独立清理及其凭据。
- 复用当前 Cloudflare 账号验证活动 Zone；只复用 `${project}-${environment}` 的专用远程 Tunnel。从已校验的 Tunnel 名称派生容器网络入口 `http://${project}-${environment}:3000`，预览并确认后配置，保留无关 ingress 和末尾 404；DNS 仅在无记录时新增，冲突不覆盖。列表或权限失败不当作“资源不存在”。
- 旧项目重新配置前，先部署并验证 `${project}-${environment}` 网络别名，同时保留原服务入口，避免运行中断。工具不会自动改写已有线上 Tunnel；旧 `http://app:3000` 路由会显示旧、新地址并要求明确确认。启动或仅预览不会更新路由。
- 连接 Token 存入通用保险库；更换 Tunnel 或 Cloudflare 账号会清除旧的项目连接 Token。切换 Supabase 项目同样清除旧清理 Key，并关闭合成文件/清理开关，避免跨项目复用。
- 未绑定专用 Tunnel 管理 Token 时，配置入口先明确选择“配置专用 Token（推荐）/复用当前登录/返回”，不会直接调用 Wrangler。账号登录、CI 部署 Token 与 Tunnel 管理 Token 是独立绑定；更换通用账号或 CI Token 不表示已配置 Tunnel 管理权限。专用凭据验证失败会恢复原绑定，不自动回退到其他 Token。
- Wrangler 的 OAuth 不保证具有 DNS 权限。可另配目标账号 Tunnel Edit、目标 Zone Read/DNS Edit 的管理 Token；它保存在独立别名中，保留原 Wrangler 与 CI Token 绑定，不作为容器连接 Token 导出。读取权限通过后仍需在具体写入时核验写权限。
- SSH 预检只读检查 Docker/Compose、CPU 架构、内存、磁盘和监听端口，严格校验现有主机密钥，不安装软件或绕过 SSH 认证。使用现有 SSH 配置，不将私钥导入工具。
- 部署计划只返回公开配置，凭据只判断是否已载入；字段完整不代表 Tunnel、数据库迁移或业务应用已验收。Secret 在 GitHub 的名称存在也不代表其值已与当前项目核对。

Token 只粘贴到明确标注“隐藏输入”的输入框。权限说明、浏览器确认、菜单及 Shell 提示符都不是 Token 输入框。明确复用官方登录后，工具保留原身份与 Account ID 校验；失败会给出“部署与发布 → 创建或配置 Tunnel → 配置专用 Tunnel 管理 Token”入口，子进程 stderr 仍不显示。如果 Token 已出现在 Shell 或截图中，应先在服务商撤销并重新生成，不再使用该 Token。

部署默认从当前环境配置与保险库按组件提供运行参数，不要求导出 Token 或多个运行文件。底层旧 Token 导出 API 兼容保留；Tunnel Token 不能用作应用前端 Key。明确新建 Tunnel 后仍无法读取初始配置时，保留并报告新建 ID，不猜测空配置或自动删除资源。

项目映射与工具版本应一同更新；旧工具遇到新字段会停止，需要更新已安装的 `project-setup`，不会忽略未知字段继续运行。macOS/Windows 上的 SSH 检查不证明目标平台 Docker 镜像架构兼容，发布前仍须核对主机架构。

目前仍待通用化的能力：原生隔离 `--env-file`、按环境精确 Auth callbacks、远端迁移账本探测与项目 bootstrap、自动脱敏审计、Worker/Access/私有 API 全链路检查。现有 Auth 网关检查不验证 executor 或业务数据库；官方 CLI 迁移入口不能用于另有迁移账本的项目。Zoncord 的 `public.schema_migrations` bundle 与 Supabase 官方 CLI 历史不可混用。

## 本地状态与安全边界

命令、包名和 `~/.config/project-setup` 命名均保持兼容。公开状态按真实项目根、仓库、项目与 staging/production 环境隔离；同仓库的不同 checkout 不共享绑定。旧共享状态可确认复制到新路径，原文件保留。

状态页区分本机已载入、GitHub Environment 已配置（Secret 只确认名称，值不可读取）、已确认缺失和云端未知。只有明确绑定 GitHub 仓库后，才只读检查所选环境的 Variable/Secret 名称；不会读取 Secret 值或把它写入本地状态。每次刷新清除旧快照，读取前后核验 GitHub 身份和仓库。查询失败不沿用旧的“已配置”结论；Environment 级缺失不代表仓库或组织级配置缺失。

直接运行 `project-setup` 默认启用统一加密保险库，存取 Cloudflare、Supabase 等服务的手动 Token、项目 Key 和映射中标记为敏感的字段。账号凭据按别名跨项目复用；项目配置按真实路径、仓库与环境隔离。增加服务不需要另写一套磁盘存储。

首次隐藏输入并确认至少 6 字符的主口令；以后只需解锁。保险库位于 `~/.config/project-setup/vault.json`（支持 `XDG_CONFIG_HOME`），使用 scrypt 派生密钥与 AES-256-GCM 加密，文件权限 600。主口令不保存，忘记无法恢复；解锁失败或取消会停止，不覆盖旧文件或自动降级。原有 `--vault` 数据与命令继续兼容。macOS 钥匙串自动解锁尚未实现。6 字符仅为最低要求；较长的随机口令能更好地防止保险库文件被复制后的离线破解。

`--no-vault` 仅保存公开配置与账号绑定，本次凭据退出后丢弃，不读写保险库。`--memory` 连项目注册记录/绑定也不读取或自动保存；显式初始化配置文件或选择导出仍可写入目标。两者与 `--vault` 互斥。官方 CLI 登录凭据仍由官方工具管理，不复制到保险库；明确标注为临时的 Auth PAT 仅供对应操作使用，迁移数据库密码验证后仅在同进程、同目标及身份下复用，均不持久化。

用户维护入口统一为可选 `.project-setup/{environment}/.env`，导入与导出使用同一默认路径，不再选择 app/deploy/pages 等用途。变量仍可自选，管理 Token 与特权清理 Key 默认不选。导入管理 Token 不能替代对应服务的账号连接。文件是明文且权限为 600；与当前值冲突时仅展示变量名，明确选择保留或替换。旧 `envExports` 声明与旧文件可兼容读取，但不再引导维护多个文件，也不会自动删除。部署由项目适配器内部生成权限隔离的临时/远端运行文件，用户不维护它们。工具不会自动读取或写入这个 `.env`，包括 `--memory` 和 `--no-vault` 模式；只有显式选择导入或导出才访问。

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

### Tunnel 初始化与失败恢复（0.8.1）

新建或已记录但未初始化的远程 Tunnel，只有 API 明确成功返回 `config: null` 且没有正版本，并再次核验账号、ID、远程管理与未删除状态后，才提供初始化路由的预览和确认。写入前重新比较配置快照与版本；已有配置保留原规则。HTTP 403/404、缺失字段或无法识别的响应不会被当作空配置。Cloudflare 公开 API 没有原子条件写入机制，写前核对不能消除全部并发窗口；操作期间避免在控制台同时编辑同一个 Tunnel。

配置读取失败会显示静态 HTTP 状态和对应修复建议，不显示响应正文或凭据。已保存的 Tunnel ID 不会被删除或重复新建；失败留在 Tunnel 阶段，可直接选择“修复 Tunnel 管理 Token / 权限”，无需再寻找服务子菜单。

### 只读核验与默认字段回读（0.8.2）

账号、Tunnel、Auth 这些远端阶段提供“重新只读核验（不修改配置）”，失败后可先重试原绑定，无需进入重连流程。Cloudflare 诊断区分凭据/身份读取与 Pages HTTP 请求；本地配置尚缺时保留具体下一步提示。错误不输出原始服务响应或凭据。

Tunnel 写后回读仅归一化服务端可补充的空 `originRequest`（全局/规则）和明确关闭且没有其他选项的 `warp-routing`。目标服务、其他路由、TLS/安全选项、规则顺序和其余配置仍完整比较；不会因字段少或出错就跳过核验。通过此检查只代表路由/DNS 配置一致，连接器与应用健康仍须发布后验证。

### 运行状态、停止、恢复与回退（0.9.0）

进入“部署与发布 → 运行状态 / 停止 / 恢复 / 回退”。项目声明独立的 `release.lifecycle` 适配器和适用环境后才显示此入口；只使用已登记的 SSH 设备。首次执行前核对受信仓库适配器，控制代码须来自干净、匹配来源的已跟踪提交。

状态页按需刷新当前版本、容器状态、资源用量、健康与近期操作历史；不创建后台监控或告警。停止、恢复和回退均先只读预览，再确认；执行前重新核验精确提交的 CI 和远端状态，目标变化或并发操作会阻止继续。生命周期请求只传公开绑定，不传管理 Token、数据库密码或应用 Key；适配器使用主机已有运行文件。

```json
{
  "release": {
    "lifecycle": {
      "adapter": "deploy/lifecycle.mts",
      "environments": ["staging"]
    }
  }
}
```

具体容器隔离、恢复核验和兼容规则由项目适配器实现。Fulcord 的停止保留数据库、云资源和磁盘文件；恢复只启动已存在版本；回退只允许迁移集及资源绑定匹配的已成功版本，不回滚数据库。共享主机仍共享 CPU、内存与磁盘，资源限制不能替代独立主机隔离。
