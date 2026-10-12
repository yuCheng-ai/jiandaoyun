# 平台架构

## 当前业务链路

Vue 3 + TypeScript + Vite 提供中文工作台、表单设计器、记录管理和组织管理；NestJS + PostgreSQL 负责真实会话、业务持久化、授权、版本与事务。`@platform/contracts` 承载共享类型及纯业务规则，不能依赖 DOM 或浏览器存储。

```mermaid
flowchart LR
  UI[工作台 / 表单 / 记录 / 待办] --> API[platformApi]
  API --> Server[NestJS：会话、授权、校验与事务]
  Server --> DB[(PostgreSQL)]
  Rules[contracts：类型、公式、校验、显隐规则] --> UI
  Rules --> Server
```

工作台与应用首页统一读取服务端应用。`/collaboration` 跳转到 `/applications`；旧 `/apps/*` 和支付管理地址返回工作台并说明入口已停用。旧本地标识没有隐式的服务端对应关系，不能拼接为服务端应用或表单 ID。

## 前端职责

- `App.vue` 只承载路由、账号范围的颜色偏好和全局提示；`stores/notices.ts` 管理短暂通知，不初始化本地业务仓库。
- `stores/platformSession.ts` 与路由守卫处理真实登录态。头像菜单只展示当前账号、组织管理入口与退出登录。
- `features/workspace/` 提供工作台和服务端应用首页；`features/data/` 提供服务端表单设计与版本发布；`features/collaboration/` 和 `features/processes/` 承载记录及流程协作。
- `features/forms/` 中的字段画布、属性检查器与运行态控件继续复用。服务端设计器和预览通过 `runtimeDataKey` 注入上下文，字段组件优先读取该上下文；组织信息通过 API 获取。
- `features/organization/` 保留部门树、成员列表、角色分组与权限查询。`stores/organization.ts` 独立读取和保存服务端目录。读取空目录不创建示例数据，第一次主动保存才初始化；页面内存状态随真实登录账号切换清空，旧请求结果不能写入新账号状态。
- `assets/styles/base.css` 只维护设计变量、基础 Reset 与页面尺寸；共享控件样式在 `components/shared/`；业务样式与对应 feature 放在一起。旧流程画布自行导入 Vue Flow 和画布样式。

## 服务端边界

表单草稿与已发布版本分离，记录保留对应版本。保存与权限更新携带当前修订号，冲突时保留输入，不能静默覆盖其他人的修改。`formModel: null` 表示没有独立字段模型，与省略该字段一致；已有字段修改仍须遵守草稿版本及共用字段约束。

所有记录读写、字段隐藏与只读、子表权限、组织身份和流程操作都由服务端验证；前端隐藏控件不能替代授权。账号与组织成员使用明确的身份映射，不按姓名猜测。

请求日志记录 requestId、路由模板、actorId、状态和耗时，避免输出凭据、Cookie 和敏感业务值。事务测试覆盖权限拒绝、版本冲突以及失败回滚。具体接口见 [backend-contracts.md](backend-contracts.md)。

## 组织目录与编辑

组织管理不再读写本地业务快照，也不使用浏览器保存的迁移命名空间。目录身份由 API 返回；账号关联前重新读取成员，并由服务端在事务中再次核对身份和修订号。没有明确关联时，不把任意成员当作当前登录账号。

组织保存复用服务端的差异合并和幂等命令。同一对象冲突时读取最新已提交数据，并保留弹窗中的修改；未确认成功的命令按原 requestId 重试。角色授权应用列表只来自服务端，已有迁移来源标识仅用于对应服务端已知的历史授权。

字段级编辑上下文比较位于 `@platform/contracts`；组织草稿校验只处理未保存输入，不再接收整个 WorkspaceData。暂存键同时包含真实账号和目录身份，不跨账号恢复。浏览器业务存储不可用不影响目录读取与显式保存。

## 尚存的旧实现

`stores/workspace.ts`、`LocalWorkspaceRepository`、部分本地执行器与旧配置组件仍在代码库内。旧的 `serverOrganization` 桥接层已删除；`useRuntimeData` 仍保留供旧组件使用的本地后备数据。因此本地业务存储尚未彻底退役，不能把入口收敛等同于架构迁移完成。

下一步应按依赖关系删除无人使用的本地业务动作和旧原型组件，再清除共享运行态中的本地后备数据。迁移旧资料应使用明确的导入流程，不能将本地示例自动视为当前账号的服务端数据。

旧流程画布、支付、推送等原型实现的历史说明保存在 [原型架构归档](archive/frontend-prototype-architecture.md)，不作为当前功能承诺。

## 验证

- `npm run build`：Contracts、前端、静态托管输出与后端构建。
- `npm test`：前端业务测试与真实 PostgreSQL 集成测试；后端测试使用隔离 schema。
- `npm run test:sites`：静态资源打包及路由检查。

核心保障集中在共享规则计算、服务端权限及回滚、表单保存发布与记录操作。浏览器验收补充检查真实布局和交互，不以历史截图代替当前结果。
