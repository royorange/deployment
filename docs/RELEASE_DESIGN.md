# 通用构建、发布与恢复设计

2026-10-28。本文区分本轮实现与后续协议，不把配置模板、构建成功或模拟测试当作业务已上线。

## 目标与边界

`project-setup` 管理账号/目标绑定、源码信任、验证证据、用户确认、设备、公开回执和流程恢复。项目适配器管理实际构建、迁移账本、部署顺序、运行状态与安全回退。工具不写死 Fulcord 容器、端口、主机或数据库，不以 shell 字符串作为可执行配置。

主流程为：检查实际状态 → 补齐配置 → 验证源码 → 准备产物 → 预览发布 → 数据库步骤 → 部署 → 核验 → 业务验收。查看状态、构建产物、发布、停止/恢复是不同操作。只发布 Pages 不要求数据库密码；已有应用健康时可明确保留当前版本继续其他组件。

## 构建位置

| 内容                  | 常用路径                          | 备用路径                       | 不能省略的核验                                                       |
| --------------------- | --------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| Pages 官网/静态 Admin | 本地直接构建，或 Actions 复现构建 | 切换构建位置                   | source SHA、公开构建配置、真实 deployment URL                        |
| Worker bundle         | 项目本地构建/预演，Actions 验证   | 本地构建                       | API/静态版本兼容、入口与权限、产物指纹                               |
| AWS amd64 镜像        | Actions Linux builder             | 本地 buildx 明确 linux/amd64   | OCI revision、架构、不可变 digest、registry 拉取能力                 |
| Zoncord 完整发布包    | 现有 web/API/edge bundle 构建入口 | 同一入口在本地或 Actions 执行  | 固定 Pages receipt、API digest/role/contract、edge hash 的完整 tuple |
| 数据库                | 发布前独立迁移步骤                | 重查已有账本，只执行待应用版本 | 目标身份、SQL 快照、实际账本与写入确认                               |

共享轻型主机只拉取和运行产物，不承担常规构建。限流时切换构建位置不能跳过 CI、安全检查或镜像身份校验。构建可向 registry 推送产物，但不代表部署业务，需在计划中明确。

## 本轮协议

- 原 release v1/v2 保持兼容；CI runId 必须是真实 GitHub 成功记录，不能用本地构建伪造。
- `release.localBuild` 是可选受信 Node 适配器，声明 adapter、可用 environments、公开 outputFields。工具固定调用 plan/build；冻结完整 SHA 和白名单公开字段，不传保险库或运行凭据。完成后复核源码，确认采用产物才更新配置。构建记录使用 provider=local，不标记 CI 通过。
- `release.buildWorkflow` 保留 Actions 路径。workflow ref 与待构建 source SHA 分开。dispatch 成功只表示请求已提交；本轮不把它当作产物已完成，不自动下载未知 artifact 或采用手写 digest 的来源声明。
- `release.order` 可明确全部组件顺序；未声明时兼容旧应用→Pages顺序。它只是执行顺序，不是依赖/原子事务保证。耦合组件应由一个复合项目适配器维护完整发布/回退集合。
- 重开向导不信任磁盘历史成功；通过受信生命周期 inspect 读取当前运行版本。当前控制器 SHA、计划发布 SHA、实际运行 SHA 分开显示。保留旧运行版本需明确选择，不能记为新 SHA 已发布。
- 无法核验、停止、busy、待恢复状态不视为成功；逐组件失败保留已完成组件。Pages API 的发布状态不等于公网或业务验收。

## CI 临时故障降级

默认严格要求最新精确提交 CI 成功。限流429、带明确限流证据的403、5xx和受控超时可有限退避；认证401/普通403、404、格式异常、身份不符不按限流处理。禁止无限重试和重复派发构建。

显式 `ciTransientFallback: {environments:["staging"], maxAgeSeconds:300}` 只允许同次发布中已经实时核验过的成功记录短时复用：

1. 首次查询必须在线通过，并固定 repo/workflow/SHA/runId/runAttempt。
2. 后续重查仅因确认的临时故障不可用，且证据未过期时，提示证据年龄和原因，由操作者确认降级。
3. 已看到失败、重跑中、缺失或身份异常即失效；不能重新使用更老的成功结果。
4. 每个外部变更前仍重新检查；runId或attempt变化需要重新审阅，不沿用原计划。
5. 默认不允许 production/prod/live；证据只在当前进程保存，回执记录降级事实。不能保证降级期间GitHub未产生新结果，因此不是“最新CI通过”。

GitHub 从头不可用、Runner额度耗尽或没有成功记录时，本轮仍阻止发布。完整本地等价CI需后续v3 validation协议，不能靠一个 --skip-ci 开关解决。

## Zoncord 接入设计

当前拓扑是 Pages静态Web + Worker同源网关 + Access Service Auth/Tunnel + AWS API-only。现有rollout要求固定Pages版本→镜像/API→contract核验→edge→公网核验。把它套入Fulcord应用→Pages顺序会破坏版本一致性。

接入应使用 `deploy/setup-release.mts` 薄适配器复用已有 scripts/deploy；由它保留完整回退tuple。Zoncord本轮现有配置与未提交文件不修改，也不假称已可一键部署。

数据库使用 public.schema_migrations bundle，且受限executor登录角色还需初始化与独立权限验证。当前 project-managed 自动发布明确阻塞，不能改成 none 或改用 Supabase CLI 混账本。后续需要受信的 inspect/plan/apply/verify 数据库步骤，或者人工完成后可信只读核验接口。

## 后续里程碑与验收

1. **构建产物自动接入**：本地与Actions产出统一manifest；验证受信workflow、run attempt、source SHA、环境/公开配置摘要和artifact摘要后自动采用。远端超时先查询既有run，不能盲目重复dispatch。
2. **验证协议v3**：GitHub和本地等价验证是互斥来源。项目声明完整检查集，setup执行已提交入口、冻结源码/工具链和结果；不接受手填通过，不用本地结果覆盖已知CI失败。生产默认仍需远端CI。
3. **项目数据库步骤**：支持Zoncord自管账本及executor bootstrap，保留逐步预览、身份重核、最小权限、失败状态，不自动降级数据库。
4. **组件依赖与组合发布**：逐组件证据、可选DAG、原子release-set的兼容tuple；清楚区分暂停、失败、待人工恢复。
5. **项目级Auth/业务验收**：精确callbacks（Zoncord /auth/confirm）、双身份隔离、Admin普通用户拒绝、默认域名绕过检查，按启用能力展开。
6. **运维**：现有手动状态/停启/回退继续复用；后台告警、备份与恢复演练单独配置，不默默启用计划任务。

本轮必验：重开后只读检查无迁移/秘密，保留旧运行版本不冒充新版本；部分成功只重试剩余组件；CI成功后临时错误可明确降级、过期/真实失败/跨身份拒绝；本地构建不接收运行秘密、不自动发布、不采用错误SHA；显式组件顺序与旧manifest兼容；Zoncord账本门禁保持阻塞。全部测试使用合成凭据，真实发布与业务验收分别记录。
