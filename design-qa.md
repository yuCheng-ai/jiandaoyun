# 富文本组件与默认值验收

更新：2026-10-11。保留当前编辑器，唯一实现位于`components/rich-text`，表单层仅负责策略和文件存储。封装、多实例、异步失效、图片编辑的既有证据见[组件批次](docs/qa-files/jdy-rich-reusable-verification.json)，[接口说明](frontend/src/components/rich-text/README.md)。

## 本批通过

- 自定义默认值复用通用富文本编辑器；无图片插入按钮，确认才进入草稿，取消明确放弃。外部默认值改变时拒绝覆盖并保留输入。
- 3万字符按HTML存储长度判断，含空白标签；默认值与提交错误不截断输入，修正后可继续。历史超限原值和不增大的编辑可保留，旧明细按行ID匹配基线。
- 单表10个富文本通过原字段数量检查统一覆盖点击、拖入、复制、恢复、整标签页复制和保存／发布。新限制不截断旧定义；旧超额可读且不能继续增加。
- 数据联动沿用原表单、字段、条件及成员上下文；来源／条件字段不可读时不取值。格式及图片ID保留，已有记录按原发布版本读取。
- 浏览器：原验收表单V2自定义默认值保存冷刷新；填写30001字符被拒且输入保留，修正后提交；另建1字段验收表单V1，联动原V1记录的标题／列表／删除线／背景色及原图片，提交冷刷新仍为同条记录。未重建来源记录。
- 390×844默认值弹窗边界left16/right374/bottom576，确定按钮right356/bottom562；工具栏换行，Escape关闭。临时视口已恢复，最近控制台warn/error为空。
- 全量前端1471项／148文件、完整构建、Sites4项通过。构建保留原大包提示；4份Sites保护文件校验未改，3项交付产物齐全。后端只有随构建进行的类型检查，本批没有后端运行修改或测试。

## 来源与边界

[官方富文本说明](https://hc.jiandaoyun.com/doc/23030)确认自定义／联动默认值、自定义默认值禁图、单表10个与3万HTML字符。参考图片此前加载失败，因此不声称精确视觉通过。当前导入超长截断行为尚未对齐；未把上述提交校验宣称为所有草稿、流程或服务端写入入口的完整覆盖。

FD28仍部分完成：图片拖拽缩放、完整PDF图片输出、最终权限组合、全部写入边界／原生存储、其他浏览器及精确视觉保留原R1/R4/R5/R6/R7归属。当前唯一计划见[执行计划](docs/jiandaoyun-form-designer-plan.md)。

桌面：[默认值设置](docs/screenshots/jdy-rich-default-editor.png)；窄屏：[390×844](docs/screenshots/jdy-rich-default-mobile.png)；保存结果：[联动记录](docs/screenshots/jdy-rich-default-linked.png)。联动截图中的噪点图是已有合成测试文件。结构化证据见[本批记录](docs/qa-files/jdy-rich-defaults-verification.json)。

final result: passed for this bounded defaults and constraints batch; FD28 remains partial
