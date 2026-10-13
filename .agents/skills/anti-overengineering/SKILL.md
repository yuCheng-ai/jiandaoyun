---
name: anti-overengineering
description: >-
  抗过度设计与极简工程规范。引导 AI（Codex/Claude/Antigravity）在编写或重构代码时，
  严守单一数据源、彻底拒绝双轨制胶水层、严禁压缩单行代码、消除微文件碎片化，保持直观易懂。
---

# 抗过度设计与极简工程规范（AI 编码必守准则）

本文档是针对 AI 编码助手（Codex / Cursor / Antigravity / Claude Code 等）制定的最高研发军规。
AI 在执行开发任务时，**必须严格遵守以下五大铁律与设计准则**，绝不允许凭空制造架构负担与理解成本。

---

## 一、 五大核心红线（Zero-Tolerance Rules）

### 1. 严禁制造“双轨制”与胶水兼容层（Single Source of Truth）
- **AI 通病**：在接入服务端 API 或新方案时，不敢推翻旧的原型代码，擅自保留本地 mock / localStorage / 草稿体系，并编写 `*DraftAdapters`、同步锁、版本冲突比对等大量胶水代码。
- **强制准则**：
  - **新方案上线之时，就是旧方案彻底删除之日**。
  - 永远保持**单一真实数据源**（Single Source of Truth）。如果要换成服务端数据库，必须直接把前端组件对接至服务端 API，并彻底删掉旧的本地缓存适配器，严禁保留两套模式平行运行。

### 2. 严禁书写“压缩饼干”式单行与高密代码（Readable Over Clever）
- **AI 通病**：为了节约输出 token 或炫技，把多个独立语句挤在一行、把长 SQL 查询与数据转换链式连结、使用多层嵌套三元表达式。
- **强制准则**：
  - **一行只写一个逻辑意图**。长 SQL 必须独立声明清晰的常量 SQL 字符串。
  - 解构数据库返回值时，先取 `const { rows } = await tx.query(...)`，再进行数据转换。
  - 禁止超过 2 层的三元表达式，改用语义明确的 `if / else` 或局部变量。
  - 核心业务函数、控制器路由、服务方法必须具备简明的**中文业务注释**，说明“为什么这样做”。

### 3. 严禁过度拆分与微文件碎片化（Cohesion Over Fragmentation）
- **AI 通病**：把原本 100 行的高内聚业务逻辑拆成 8 个 15 行的微文件（如 `*-rule.ts`、`*-impact.ts`、`*-dto.ts`），并在每个目录下建无实际价值的 `index.ts` 纯导出文件。
- **强制准则**：
  - **相关逻辑就近内聚**。如果一个辅助查询或转换函数只在一个 Service 内使用，直接内联声明为该文件内部函数，严禁无故新建独立文件。
  - 严禁为了“形式整齐”建立空转的 barrel `index.ts` 文件。导入时必须显式导入具体文件。
  - 评估改动时严格执行：**删除多余代码 > 复用已有能力 > 做出最小必要新增**。

### 4. 严禁脑补多重模式与多余抽象层（No Premature Abstraction）
- **AI 通病**：产品需求明确要求“权限组模式”，AI 却脑补出“直授模式”+“权限组模式”+“模式选择器”+“模式兼容层”。
- **强制准则**：
  - **不要做超出当前产品共识的过度设计**。需求要求什么就用最直接的方式实现什么。
  - 不做“可能未来会用到”的抽象（YAGNI - You Aren't Gonna Need It）。
  - 能用纯函数表达的业务计算（如公式、校验），统一收敛至跨端契约包（如 `@platform/contracts`），绝不引入多余的类继承层或中间层。

### 5. 一次性迁移与临时脚手架必须及时销毁（Clean Up Scaffolding）
- **AI 通病**：临时写的补丁脚本、数据迁移接口、历史版本对比弹窗长期留存并在后续需求中被不断打补丁。
- **强制准则**：
  - 一次性历史数据清洗或迁移完成后，必须立即清理相关路由、数据表兼容逻辑与前端历史弹窗，不给核心业务留下永久的技术债包袱。

---

## 二、 编码对比范本（Before vs After）

### 场景 1：数据查询与权限判断
❌ **错误做法（压缩单行、多层嵌套、隐晦难懂）：**
```typescript
// 错误：单行挤压、高密链式调用、无业务注释
const r=await tx.query("SELECT * FROM records WHERE def_id=$1",[id]);
return r.rows.map(x=>x.active?{id:x.id,name:x.name,role:x.role==='admin'?'A':x.role==='audit'?'B':'C'}:{id:x.id,name:x.name,disabled:true});
```

✅ **正确做法（平铺直叙、中文注释、易读易改）：**
```typescript
/** 查询指定定义下的所有记录，并按状态转换角色标签 */
const querySql = `
  SELECT id, name, role, active
  FROM records
  WHERE def_id = $1
  ORDER BY created_at DESC
`;
const { rows } = await tx.query(querySql, [id]);

return rows.map((record) => {
  // 停用记录直接标记为不可用
  if (!record.active) {
    return { id: record.id, name: record.name, disabled: true };
  }

  // 映射中文业务角色标识
  let roleLabel = "普通成员";
  if (record.role === "admin") {
    roleLabel = "管理员";
  } else if (record.role === "audit") {
    roleLabel = "复核员";
  }

  return {
    id: record.id,
    name: record.name,
    role: roleLabel,
    disabled: false,
  };
});
```

---

### 场景 2：功能升级时的架构决策
❌ **错误做法（双轨制与适配器胶水）：**
- 增加服务端保存接口后，保留前端 `localStorage` 保存逻辑。
- 引入 `useEditorDraft`、`editorDraftAdapters.ts`、`DraftRepository`，写了 1000 行来“把本地草稿转成服务端草稿并处理版本冲突”。
- 最终结果：两头都在改，状态永远同步不一致。

✅ **正确做法（单一权威服务端）：**
- 直接删除前端 `localStorage` 写入分支。
- 前端页面统一调用 `platformApi('/definitions/:id/records', 'POST', payload)`。
- 提交前校验由前端纯函数校验，持久化由 PostgreSQL 唯一保证，无任何胶水层。
