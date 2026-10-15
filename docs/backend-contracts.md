# 服务端契约与实现边界

更新：2026-10-14。本文记录当前服务端接口与运行边界；测试依据在 `backend/tests/`，架构入口见 [architecture.md](architecture.md)。

## 工程与选型

frontend/ 保留 Vue 3 + TypeScript、Pinia、领域与 Repository 分层。backend/ 使用 NestJS + PostgreSQL。packages/contracts/ 是双方共享的表单和接口类型；服务端不导入前端运行代码。

本阶段选择 TypeScript 贯穿前后端，以复用稳定 ID 和定义契约；选择 PostgreSQL 承担事务、版本外键、并发锁、唯一约束与审计写入。可变字段值暂存在 JSONB；任务、记录、版本和成员关系是独立实体。这些能力来自权限和执行模型，不以更换数据库本身作为产品差异。

后端模块文件分别负责认证、数据库、Schema 校验、表单/记录服务和任务服务；尚未拆为分布式服务。工作台、表单和流程入口统一经过 platformApi 读取服务端；库内尚存的本地原型依赖见 architecture.md，不作为当前业务的数据来源。

## 数据模型

| 实体 | 职责与不变量 |
| --- | --- |
| users / sessions | 服务端识别真实开发账号；Cookie 只保存随机会话令牌，数据库保存令牌摘要，8 小时过期 |
| definitions | 可修改的表单定义草稿，revision 检测并发修改 |
| definition_versions | 只追加发布快照；数据库触发器拒绝更新或删除 |
| record_permission_groups / record_permission_group_events | 成员、部门或角色的权限组配置及修订审计；每组规定操作、记录范围、字段和关系权限 |
| workspace_organizations / organization_events | 工作空间内部门、真实成员归属、角色组和角色的版本化配置及组织变更审计 |
| records | 固定绑定 definition_id + definition_version；记录值和字段版本一起修改 |
| commands | 记录新增/修改幂等键；同一成员的同一键不能用于不同内容 |
| record_events | 与记录事务一起写入的审计；本阶段仅管理员可读，没有成员导出或历史接口 |
| processes / tasks | 流程实例独立于表单；实例绑定多张表的记录，任务持有负责人、记录、依赖和等待条件 |
| applications / data_object_versions | 应用级资源及独立数据模型版本 |
| pages / page_versions | 页面草稿及不可变版本；页面新增字段与绑定原子发布 |
| relations / relation_versions / record_links | 关系配置、版本和记录或来源明细行关联，统一授权与引用保护 |
| process_templates / process_template_versions | 独立任务模板草稿及不可变版本，固定数据、页面、处理人与依赖 |
| process_events | 与任务变更一起保存的轨迹，按递增 sequence 排序；成员读取自己任务及流程级事件 |

JSONB 子表行具有服务器分配的 `_rowId`；客户端更新路径为 `subformId / rowId / fieldId`。明细可以新增、删除和从删除轨迹恢复。结构命令检查结构版本及被删除行的全部字段版本，关系和任务引用阻止破坏性删除。恢复保留行身份并增加字段版本，拒绝删除前的陈旧写入。重排尚未持久化。

## 权限与并发

读取返回按当前授权裁剪后的 Schema、值和字段版本。父级子表的隐藏或只读限制会约束子列。记录范围支持全部、本人创建、记录创建部门和自定义条件；每次请求都重新检查当前账号、工作空间和授权。客户端不能通过传入 actorId 或 role 改变身份。

记录更新采用局部字段命令，每个字段附带 expectedRevision。不同字段可以在旧的整体快照上修改；相同字段版本不一致返回 409。事务锁顺序为定义 → 记录；任务处理进一步锁定流程。批量字段修改中的任意一项失败会回滚整个命令和审计。

记录创建和修改通过 UUID requestId 去重；重试读取当前授权下的最新记录，不回放旧权限的缓存响应。流程发起具有独立的工作空间幂等键；任务完成天然幂等。定义创建尚无请求幂等键，界面防重复点击；发布使用定义 revision，重复旧发布命令返回冲突。

## 基础接口

所有写接口要求 Origin 与 APP_ORIGIN 一致；配置为本地回环地址时，同时接受相同协议和端口的 localhost / 127.0.0.1，其他来源仍拒绝。所有业务接口都要求已登录。默认监听 127.0.0.1:3001，经前端 5198 的 /api 代理访问。

| 接口 | 功能 |
| --- | --- |
| POST /api/auth/login，GET /api/auth/me，POST /api/auth/logout | 登录、恢复会话、退出 |
| GET /api/definitions，GET /api/definitions/:id | 列出授权表单、读取当前可见定义与填写权限 |
| POST /api/pages/new-business | 在应用内新建表单及其字段数据，使用 requestId 防止重试重复创建 |
| GET /api/pages/:id/editor，PUT /api/pages/:id | 读取完整设计上下文、按 expectedRevision 保存表单草稿 |
| POST /api/pages/:id/publish-preview | 管理员按 expectedRevision 检查已保存草稿，返回字段/控件变化、页面/关系/流程使用情况、记录/任务版本计数和 token；不读取业务值 |
| POST /api/pages/:id/publish | 新页面 UI 提交 expectedRevision 与 impactToken；事务内重算预览，变化返回 409，字段与页面一起提交。响应为已发布页面并附带 editor（PageEditorData），与发布处于同一事务；前端无需再读取草稿。旧接口调用保留不带 token 的兼容路径及原版本校验 |
| GET /api/users | 管理员读取当前工作空间账号 |
| GET/PUT /api/definitions/:id/permission-groups | 管理员读取、按 expectedRevision 保存完整权限组配置 |
| GET /api/definitions/:id/permission-groups/options | 读取当前成员可用权限组及操作摘要 |
| GET/POST /api/definitions/:id/records | 最近 100 条记录元信息、新增记录 |
| GET /api/pages/:id/record-list | 按 version、state、page 读取记录；keyword 最多 200 字符，按授权可见字段搜索后统计、分页，不包含隐藏字段和 HTML 属性 |
| GET/PATCH /api/records/:id | 按固定版本查看、按字段版本修改 |
| GET /api/records/:id/events | 管理员查看变更审计 |
| GET/POST /api/processes，GET /api/processes/:id | 创建、列出、查询任务实例 |
| POST /api/processes/:id/tasks/:taskId/complete | 指定处理人完成任务，重新检查依赖和条件 |

创建记录示例结构：

```json
{
  "requestId": "一次用户提交使用一个 UUID，网络重试保持不变",
  "version": 1,
  "values": { "事项字段ID": "示例", "子表ID": [{ "数量字段ID": 10 }] }
}
```

字段修改示例结构：

```json
{
  "requestId": "本次修改的 UUID",
  "changes": [
    { "subformId": "子表ID", "rowId": "服务端返回的行ID", "fieldId": "数量字段ID", "expectedRevision": 1, "value": 12 }
  ]
}
```

这些是结构说明，文字占位符不是可直接调用的合法 ID。完整可执行实例见 backend/tests/platform.test.ts。

## 数据模型发布与草稿恢复

| 接口 | 功能 |
| --- | --- |
| POST /api/data-objects/:id/publish-preview | 管理员按 expectedRevision 检查已保存模型草稿，返回规则变化、引用、记录符合情况、历史版本及 token |
| POST /api/data-objects/:id/publish | 发布不可变数据版本；移除字段或调整已有约束必须提供 impactToken，事务内重算，不匹配或有阻断引用时返回 409 |
| GET /api/data-objects/:id/pending-page-fields | 管理员查看本对象各页面已保存的新增字段名称、类型、明细归属和来源；同名及模型变化给出提示，不返回字段默认值或业务数据 |
| POST /api/pages/:id/discard-draft | 按 expectedRevision 恢复最近发布的页面名称、布局与数据版本绑定，取消本页待发布字段；返回完整 PageEditorData，不修改共享模型与记录 |
| GET /api/pages/:id/versions | 管理员读取本工作空间的页面发布历史，返回降序版本号、发布名称、含子控件的控件总数及真实发布时间；未发布返回空列表 |
| POST /api/data-objects/:id/discard-draft | 按 expectedRevision 恢复最近已发布名称和模型，增加 revision；不改页面草稿、业务记录或发布历史 |

旧 `POST /definitions`、`PUT /definitions/:id` 及其发布预览、发布接口已删除。表单设计通过页面生命周期保存与发布；模型服务不再隐式生成或更新默认页面。定义读取、记录、组织候选、权限组和收集规则接口继续承载实际业务。

页面历史摘要直接读取不可变的 `page_versions`，后续草稿编辑不会改变历史计数或时间。单版预览复用 `GET /pages/:id?version=...`，不替换当前草稿。归档后管理员仍可读取历史；填写入口继续拒绝归档页面。

模型草稿保存允许待处理的页面或关系引用；实际发布始终检查依赖。页面、关系、流程草稿和已发布配置分别列出，权限按成员/部门/角色列出。检查只返回配置及计数，记录值仅在服务端校验；按数据对象独占锁保持批量统计一致，相关写入待检查结束后继续。历史记录和已发任务不自动迁移，已有页面也不自动采用新模型。

DataObjectDraft.hasDraftChanges 表示已保存模型或名称是否不同于最新发布版本。放弃尚未发布过的对象草稿返回 400；无权或其他工作空间不可操作。模型发布和草稿恢复在同一事务追加 configuration_events，事件不可更改或删除，审计失败导致整个操作回滚。引用检查只覆盖服务端已接通的配置，不包含旧本地扩展执行器。

页面草稿恢复按定义、页面顺序加锁，并与 configuration_events 审计在同一事务内完成。没有已发布页面时返回 400；过期 revision 返回 409，重复旧请求不得丢弃后续新草稿。待发布字段汇总在数据对象共享锁内读取，字段身份始终独立，不因同名自动归并。

definitionVersion=0 的页面使用 pages.initial_model 与 initial_model_revision 保存服务端初始基线；它不是已发布版本，不接受客户端覆盖。数据管理或另一页首次发布后仍可读取并保存原页面草稿，发布则要求先显式采用已发布模型。GET /pages/:id/editor 在数据对象共享锁内一致读取页面、对象与基线。首次联合发布包括“只复用初始字段、没有 additions”的情况，数据和页面版本、审计全部提交或回滚；采用正式版本后清除初始快照。迁移 011 只回填已知的未发布模型，不用后续版本推测缺失历史。

## 页面生命周期

GET /api/pages 默认只列使用中页面；管理员可传 state=archived 查看已归档页面。PageSummary/PageDraft 的 archivedAt 表示归档时间。

POST /api/pages/:id/lifecycle-preview 接收 action（archive 或 restore）和 expectedRevision，返回当前修订、不可变发布版本、待发布字段数、模板草稿与发布引用、按页面版本汇总的任务计数、恢复差异提示及 token。POST /api/pages/:id/archive 或 /restore 必须携带 expectedRevision 与 impactToken。事务内重新检查，过期返回 409；成功增加修订并追加不可变 configuration_events，返回 PageDraft。

普通页面读写及配置操作拒绝已归档页面。已发任务通过服务端加载的任务范围继续使用原版本，不能凭客户端 taskId 绕过归档检查。新流程发布、启用、预览和发起检查活动状态，已成功发起请求的相同幂等重试仍返回原实例。关系写入在加锁后重新检查归档状态。恢复保留原草稿及版本，不自动升级数据。

## 通用任务模型

流程配置为 ProcessSpec + bindings。bindings 将业务名绑定到记录 ID；任务通过 recordBinding 选择自己处理的记录，而不是强制复制到同一张表。dependsOn 可表达并行后的汇合；waitFor 可等待另一张表某个普通字段等于指定值。依赖图不允许环，引用必须有效，负责人必须已有记录访问权限。

测试覆盖「协作核对」的两张表、两个并行任务、汇合及跨表等待，以及「资料交接」的串行交接与接收。业务名称仅出现在配置中，执行器没有按业务名分支。

等待条件在查询、任务写入、完成任务时重新检查，并有每 5 秒一轮、每轮最多 20 个流程的后台检查。任务及检查失败状态在服务重启后继续；没有外部消息推送。任务完成是确认动作，不包含原子修改多记录、自动库存操作或 ERP 集成。可视化流程设计器直接编辑服务端模板任务和依赖，画布不另存一份执行图。起止连线由 startTaskIds/endTaskIds 明确记录，缺省或空数组表示未连线，不按任务依赖自动补齐。断线草稿可以保存；发布接口检查所有节点从发起可达且能够到达结束，断线不能启用。已发布版本继续按发布时的任务依赖执行。任务 `position` 与模板 `layout.start/end` 只记录展示位置，由同一保存接口校验并持久化；不参与任务依赖或权限判断。

## 任务配置与处理接口

模板发布固定数据版本及处理页面版本。发起时绑定兼容记录，按现有明细行展开；依赖等待前置节点展开出的全部任务。预览携带记录整体 revision，发起时原子重检，并写入流程、任务、轨迹和幂等回执。

按行任务只返回绑定行、授权字段及对应修改版本，服务端拒绝其他行、主字段和结构动作。页面与行范围只能收紧成员权限。任务可以暂存未完成字段，完成前重新校验页面及任务必填；模型永久约束始终执行。等待中和完成后的任务不接受新修改，已成功命令的重试返回当前授权结果，不重复轨迹。

| 接口 | 功能 |
| --- | --- |
| GET/POST /api/process-templates，PUT /api/process-templates/:id | 应用内列出、新建、CAS 保存模板草稿 |
| POST /api/process-templates/:id/publish | 检查成员、版本、必填范围和依赖图后发布 |
| GET /api/process-templates/:id/versions | 管理员读取历史版本、启用状态、实例数量及能否删除 |
| GET /api/process-templates/:id/versions/:version | 管理员可查看历史快照；普通成员只读取已启用且有权发起的版本 |
| PUT /api/process-templates/:id/state | 按 expectedRevision 停用或指定 version 启用；返回更新后的草稿元数据 |
| DELETE /api/process-templates/:id/versions/:version | 按 expectedRevision 删除未启用且无流程引用的版本；返回更新后的草稿元数据 |
| GET /api/process-templates/:id/versions/:version/records?bindingId=... | 该绑定最近 100 条中的兼容记录 |
| POST /api/process-templates/:id/versions/:version/preview | 校验绑定与权限，返回展开任务、记录版本及 participantsToken |
| POST /api/process-templates/:id/versions/:version/start | 使用 bindings、recordRevisions、participantsToken、requestId 原子发起；组取人必须匹配成员预览 |
| GET /api/processes/:id/record | 按当前身份直接读取流程正文，返回既有 RecordDetail |
| GET/PATCH /api/processes/:id/tasks/:taskId/record | 在处理页面与记录/行范围内读取、保存；曾委托人仅可 GET |

模板配置与发布限管理员。成员列表只返回有新增权限的已启用发布模板；读取、预览和发起也执行相同授权。已有独立模板的候选记录限本人创建且当前可读，发起时重新校验归属与权限。

表单流程的 `startPageId` 唯一指定自动发起入口。`POST /api/pages/:id/records` 与 `POST /api/pages/:id/records/:recordId/submit` 在同一事务中保存记录并发起，返回 `RecordDetail.processId`；草稿不发起。已绑定表单的模板不能再通过独立模板接口手动重复发起。

`ProcessTemplateDraft.activeVersion` 为启用指针，`latestVersion` 为已分配版本号上限。发布分配下一个版本并启用；删除历史后不复用其编号。`PUT /api/process-templates/:id/state` 接收 expectedRevision、enabled，启用时提供 version；重新启用旧版会重验成员、表单版本、连通性及发起表单兼容性。停用保留版本指针，删除未使用的停用版本时可清除指针。所有新发起请求（包括管理员）必须使用当前启用版本，已发实例保留原版本和节点内容。

历史快照不可原地修改。基于旧版新建时，将旧 spec 通过现有草稿 PUT 接口保存，发布后产生新编号。版本列表返回 version、createdAt、active、processCount、canDelete；管理员才能管理历史。启用与删除持有模板排他锁，发起持有共享锁，防止并发引用已删除或已切换的版本；数据库外键保护已被实例引用的快照。

流程草稿中的办理页必须属于当前工作空间和应用，且指定页面版本存在。保存草稿允许保留已归档办理页，便于复制历史后修正；发布和启用仍拒绝归档办理页，不把不可执行的草稿用于新流程。

任务可配置 kind（approval/copy）、fieldPermissions（edit/read/hidden）及画布 position；节点权限和父子限制在服务端收紧基础授权。流程运行中的自动提交记录，普通成员只能通过任务接口修改。

`GET /api/processes` 的 scope 支持 todo、started、handled、copied、delegation。 列表返回 `ProcessSummary`，包含发起人、发起时间和当前可见的办理人；按现有流程及任务可见范围用一次聚合查询补齐元数据，不读取记录正文。详情返回 canOpen、canHandle，用于准确显示动作；后端仍逐请求鉴权。发起人可看完整进度，其他成员查看自己负责、已收抄送或曾委托的任务轨迹。

`GET /api/processes/:id/record` 优先返回本人的可办理节点；无本人待办时，发起人/管理员读取只读原申请，其他参与人读取本人已办、已抄送或曾委托节点。返回仍为 `RecordDetail`，包含 `task` 时保存继续调用原任务接口，不新增正文写接口。新自动流程在 `spec.origin` 保存提交时 pageId/pageVersion；旧实例只有原页面版本唯一对应时恢复，否则沿用记录结构。普通表单权限、节点字段限制、明细行范围仍在服务端执行；正文无权读取返回 403，进度查询独立授权。

`GET /api/processes/:id/tasks/:taskId/delegate-options` 只返回可接手本任务的成员 ID 和名称。`POST /api/processes/:id/tasks/:taskId/delegate` 接收 assigneeId，锁定任务与流程后重验授权，更新实际处理人和运行定义并写入 delegated 轨迹。原处理人不再有办理权限。抄送送达时写 copied 轨迹，不允许保存或完成抄送任务。

## 组织与授权接口

| 接口 | 功能 |
| --- | --- |
| GET /api/organization | 管理员读取工作空间的组织版本、部门、成员归属、角色组、角色及真实成员目录 |
| PUT /api/organization | 使用 expectedRevision 与完整 spec 原子保存并记录审计；旧版本返回 409 |
| GET/PUT /api/definitions/:id/permission-groups | 管理员读取和保存权限组；提供 expectedRevision 与完整 groups |

权限组的 subjects 使用 `{kind: "member" | "department" | "role", id, includeChildren?}`；部门受众的 includeChildren 控制下级部门成员是否被纳入。actions 包含 view、create、edit、delete、export、print；已有记录的修改或输出操作同时要求 view。scope 支持 all、self、department、custom；department 按记录保存的创建部门快照匹配成员当前部门，不因创建人后续调动改写记录归属。

配置读写统一返回 `mode: "groups"`、`allowMerged: true`。旧参数可省略，但不影响校验；引用当前版本已移除的筛选字段时不能启用权限组。options 返回 `administrator`、`revision`、`allowMerged` 和 `groups`，不再返回 `direct` 模式；`administrator: true` 只用于界面免组选取，服务端管理权限始终来自真实登录身份，不能通过客户端参数取得。普通成员的权限组选取头由低代码接口守卫解析，并重新检查所选组当前是否属于该成员。

成员可选择单组，也可使用全部有权限的数据。每组先独立计算操作、记录范围和父子字段限制，再合并有效结果；新增权限不能借用仅修改组的可编辑字段。hidden 表示该组不授予，不否定其他有效组。普通成员的新字段默认隐藏；权限查询、候选筛选和任务写入使用同一套服务端规则。旧 grants 与 subject-grants 接口已退役，不再提供直授模式切换。

管理员通过 `GET /organization/permissions?memberId=...` 或 `?roleId=...` 查询目录身份的表单权限；两个参数只能选一个。接口批量读取未归档表单和真实权限组，并返回可直接导航的页面 ID。成员查询按明确账号关联及当前组织关系匹配权限组；未关联或停用账号不返回授权组，平台管理员由账号状态明确标识。角色查询展示直接引用该角色的启用权限组，归档角色同时返回归档状态，不能当作成员有效权限。汇总只说明授权配置，具体记录仍受字段、范围、发布和收集规则约束。旧目录 `role.grants` 仅允许原样保留，新写入或修改返回 400；`/organization/role-applications` 已删除。

模板任务可以使用 assigneeId，或 assigneeSelector 指定部门/角色，不可同时指定两者。组内每位当前在用成员生成独立任务，明细范围再逐行展开。participantsToken 固定预览时组织版本与实际处理人；组取人的发起必须匹配此标识。已发出的任务保存实际成员 ID，不因后续组织变化自动改派，办理仍检查当前权限。

组织更新使用工作空间独占事务锁；授权读取和业务写入在事务中持有共享锁。记录新增/修改及关系建立/解除的授权、写入、审计和响应投影在同一事务完成，避免已保存却因随后的调动报失败。重试仍按当前权限生成响应。

## 当前可用范围与后续工作

- 服务端支持的字段以 `@platform/contracts` 的 `serverFieldTypes` 为准，已覆盖文本、数字、日期、选项、组织身份、附件、地址、富文本、计算和单层子表等。默认公式、页面条件显隐与校验按各自发布契约执行；模型服务承载字段规则，页面服务承载布局与条件规则。未接通的唯一性、动态来源和外部扩展配置仍由服务端拒绝，不能仅凭控件存在判断已可执行。
- 当前权限支持指定成员、部门和角色，处理页面与任务行范围进一步收紧。任务可按部门/角色当前在用成员逐人展开；复杂汇报线和任一人领取未接入；当前可办理任务可委托给已有权限的成员。管理员可管理当前工作空间全部记录。
- 定义、页面和记录采用版本绑定，不自动升级历史记录；管理员可以预览并显式执行兼容新增升级。已发布字段 ID 不能变更类型或所属子表。
- 迁移版本台账、校验和与重复/并发启动验证已实现。当前提供本地账号开通、停用、恢复和密码重置；企业 SSO、多实例限流及生产部署运维未在当前开发环境验收。开发服务仅监听回环地址，账号凭据由 .env 随机生成。
- 已接关系与引用检查、明细操作、任务配置、等待条件、版本管理和页面归档恢复；退回、撤回、按日期代办、超时及外部执行重试未接入。
