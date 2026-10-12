# 流程引擎

以表单为业务入口的中文工作台：Vue 3 + TypeScript 前端，NestJS + PostgreSQL 服务端。应用、表单、记录和待办通过真实登录账号访问服务端 API；共享公式、校验与显隐规则由 `@platform/contracts` 承载。

## 本地开发

需要 Node.js 22 与 Docker Compose。

```bash
npm install
npm run setup:local
npm run db:up
npm run dev
```

前端地址为 <http://127.0.0.1:5198/#/>，API 使用 3001 端口，数据库使用 55432 端口。`setup:local` 生成被忽略的 `.env`，不会覆盖已有配置；开发账号 `admin`、`editor`、`reviewer` 的随机密码分别保存在 `PLATFORM_ADMIN_PASSWORD`、`PLATFORM_EDITOR_PASSWORD`、`PLATFORM_REVIEWER_PASSWORD`。不要将 `.env` 提交到版本库。

## 使用入口

- `/#/`：登录、我的应用，以及待办、我发起的、我处理的、抄送我的、发起流程、待办委托。
- `/#/applications`：服务端应用与表单入口；从列表打开应用后直接填写或管理数据。
- `/#/applications/:applicationId/pages/:pageId/design`：表单设计器；使用列表返回的真实 ID。
- `/#/admin/organization`、`/#/admin/roles`、`/#/admin/permissions`：组织、角色与权限管理。

`/#/collaboration` 归入应用入口。旧 `/#/apps/*` 和支付管理链接返回工作台并提示重新选择应用，不再把本地 ID 当成服务端 ID。旧浏览器数据不会因打开工作台被覆盖。

## 工程结构

```text
frontend/             页面、交互、API 调用与前端测试
backend/              NestJS 服务、数据库迁移与集成测试
packages/contracts/   共享类型和纯业务规则
scripts/              开发启动、本地配置和静态托管构建
```

表单设计保留字段库、画布、属性检查器三栏；应用首页保留表单树与填写/记录管理布局。保存草稿与发布版本分离，权限和并发校验由服务端执行。

## 当前边界

主入口和组织管理均已使用独立的服务端状态。组织目录、成员账号关联与角色应用列表不再读取本地业务快照；服务端没有目录时显示空目录，首次主动保存才创建。未保存的编辑内容仍可按登录账号和目录隔离暂存。旧本地仓库和部分原型组件仍有残留，需要继续按依赖关系清理。旧支付、扩展配置和流程画布的历史能力不代表当前入口已经接通。详细边界见 [架构说明](docs/architecture.md) 和 [服务端契约](docs/backend-contracts.md)。

## 验证与部署

```bash
npm run build
npm test
npm run test:sites
```

后端测试需要已启动的 PostgreSQL，使用独立测试 schema。前端测试并发可用 `npm run test --workspace @platform/frontend -- --maxWorkers=4 --minWorkers=1` 控制。

Sites 静态构建产物位于 `dist/client`、`dist/server/index.js` 与 `dist/.openai/hosting.json`，只负责前端托管。部署静态资源后仍须提供可访问的 NestJS API。
