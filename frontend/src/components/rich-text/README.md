# 富文本组件

项目内共用的 Vue 编辑器。组件不依赖表单字段结构、Pinia、路由或文件数据库；HTML 清理共用 `domain/richText.ts`，颜色和弹窗复用公共组件。样式随组件加载。

```vue
<script setup lang="ts">
import { ref } from 'vue';
import RichTextEditor from './components/rich-text/RichTextEditor.vue';
const content = ref('<p>正文</p>');
</script>
<template>
  <RichTextEditor v-model="content" label="说明" />
</template>
```

| 接口 | 作用 |
| --- | --- |
| `modelValue` / `update:modelValue` | 清理后的 HTML；自身输入回传不会重建 DOM，外部切换内容会更新编辑区并关闭旧弹窗 |
| `label` | 编辑区的可访问名称 |
| `readonly` | 隐藏编辑工具，禁止写回；允许查看图片 |
| `toolbar` | `full`（默认）或 `compact` |
| `maxImageSizeMb` | 单图上限，默认 5 MB |
| `maxImages` | 内容中的图片总数上限，默认 10；设为 0 隐藏插入图片；每次最多选择 10 张 |
| `allowPastedImages` | 默认 false；关闭时保留粘贴文字和格式，但去掉图片 |
| `imageStorage` | 可选上传和加载接口，见 `types.ts`；不传时图片内嵌在 HTML 中 |

`imageStorage.upload(files)` 返回 `{ id?, src?, alt? }[]`。上传到服务端可返回图片 URL，也可返回稳定 ID；后者通过 `resolve(id)` 返回图片 Blob。授权、文件持久化和服务调用由接入层负责，编辑器只负责呈现和错误重试。带 ID 的图片持久化为 `data-file-id`，运行时创建的 blob URL 不会写入内容，移除图片或卸载组件后释放。

上传失败保留已选文件；切换内容、只读或卸载后，迟到结果不再插入。删除内容中的图片不会删除存储里的原文件，避免破坏撤销、其他记录或历史版本引用。已有 http(s)、内嵌图片和本地文件 ID 均可继续展示。

表单接入在 `features/forms/components/RichTextEditor.vue`：该薄封装保留原调用接口，负责字段／描述的不同限制与本地文件读写。字段正文使用现有文件库，描述继续保留原内嵌格式。这里没有第二套编辑实现。默认值编辑复用同一封装，以 `images=false` 关闭插入／粘贴图片；已有图片保留。业务的 3 万 HTML 字符与单表 10 个富文本限制由表单 domain 负责，不写死在通用编辑器里。

图片缩放由内部 `RichTextImageResize.vue` 负责手柄、临时预览与尺寸测量，松开后交给同一个编辑器的原生命令保存，保留一次撤销／重做。方向键微调 5px，Shift + 方向键微调 20px；宽度受当前内容区约束且保持比例。Escape、指针取消、只读、外部内容替换和卸载会取消尚未完成的拖动。该组件无表单业务依赖。

独立组件验证见 `tests/rich-text-component.test.ts`；原字段、颜色和表单调用回归仍保留。当前编辑命令继续使用浏览器原生实现，其他浏览器内核、完整富文本 PDF 输出和源产品的全部图片操作不在本次通过结论中。
