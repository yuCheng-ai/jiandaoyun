import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  FileValue,
  FormField,
  FormSchema,
  FormValues,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import { Database, type Transaction } from "../../core/database/database";

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

interface StoredFile {
  id: string;
  name: string;
  size: number;
  media_type: string;
  uploaded_by: string;
}

type RecordFileEntry = { key: string } & (
  | { kind: "attachment"; file: FileValue }
  | { kind: "richtext"; file: Pick<FileValue, "id"> }
);

/** 仅收集附件字段和富文本图片，普通字段中伪造的同名 ID 不授予下载权限。 */
export function recordFileValues(
  schema: FormSchema,
  values: FormValues,
): Pick<FileValue, "id">[] {
  return recordFileEntries(schema, values).map((entry) => entry.file);
}

function recordFileEntries(schema: FormSchema, values: FormValues) {
  const files: RecordFileEntry[] = [];
  function collect(field: FormField, input: FormValues, prefix = "") {
    if (field.type === "subform") {
      const rows = input[field.id];
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        for (const child of field.children) {
          collect(child, row as FormValues, `${field.id}/${(row as FormValues)._rowId}/`);
        }
      }
      return;
    }
    const value = input[field.id];
    if (field.type === "richtext" && typeof value === "string") {
      // 编辑器只持久化 img 的 data-file-id；逐项读取属性，避免把 alt 中的文字误当引用。
      const tags = value.matchAll(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi);
      for (const [tag] of tags) {
        const attributes = tag.matchAll(
          /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
        );
        for (const attribute of attributes) {
          if (attribute[1].toLowerCase() !== "data-file-id") continue;
          const id = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
          files.push({
            key: `${prefix}${field.id}`,
            kind: "richtext",
            file: { id },
          });
          break;
        }
      }
      return;
    }
    if (field.type !== "file" && field.type !== "image") return;
    if (Array.isArray(value)) {
      for (const file of value as FileValue[]) {
        files.push({ key: `${prefix}${field.id}`, kind: "attachment", file });
      }
    }
  }
  for (const field of schema.fields) collect(field, values);
  return files;
}

/** 图片以实际文件头为准，不能仅改扩展名或声明 MIME 类型冒充图片。 */
function mediaType(file: UploadedFile): string {
  const bytes = file.buffer;
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  const header = bytes.toString("ascii", 0, 12);
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
    return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP")
    return "image/webp";
  if (file.mimetype.startsWith("image/")) return "application/octet-stream";
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mimetype))
    return file.mimetype.toLowerCase();
  return "application/octet-stream";
}

@Injectable()
export class FileService {
  constructor(private readonly db: Database) {}

  async upload(actor: Actor, file?: UploadedFile): Promise<FileValue> {
    if (!file || !Buffer.isBuffer(file.buffer)) {
      throw new BadRequestException("请选择上传文件");
    }
    const name = file.originalname.trim();
    if (!name || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
      throw new BadRequestException("文件名称无效或过长");
    }
    const value: FileValue = {
      id: `file_${randomUUID()}`,
      name,
      size: file.buffer.length,
      type: mediaType(file),
    };
    await this.db.query(
      `INSERT INTO uploaded_files (id, workspace_id, uploaded_by, name, size, media_type, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        value.id,
        actor.workspaceId,
        actor.id,
        value.name,
        value.size,
        value.type,
        file.buffer,
      ],
    );
    return value;
  }

  /** 附件绑定和记录写入共用事务；伪造文件、跨成员引用会使整次保存回滚。 */
  async bind(
    tx: Transaction,
    actor: Actor,
    recordId: string,
    schema: FormSchema,
    values: FormValues,
    previousValues: FormValues = {},
  ) {
    const entries = recordFileEntries(schema, values);
    if (!entries.length) return;
    const previous = new Set(
      recordFileEntries(schema, previousValues).map(({ key, file }) => `${key}:${file.id}`),
    );
    const ids = [...new Set(entries.map(({ file }) => file.id))];
    if (ids.some((id) => !id || !/^file_[a-f0-9-]{36}$/.test(id))) {
      throw new BadRequestException("附件尚未上传，请重新选择文件");
    }
    // 统一按文件 ID 加排他锁，避免不同记录同时首次绑定或多文件反序加锁。
    const { rows } = await tx.query<StoredFile>(
      `SELECT f.id, f.name, f.size, f.media_type, f.uploaded_by
       FROM uploaded_files f
       WHERE f.workspace_id = $1 AND f.id = ANY($2::text[])
       ORDER BY f.id FOR UPDATE OF f`,
      [actor.workspaceId, ids],
    );
    // 必须锁后另起查询；等待其他事务时，同一条语句的绑定快照不会自动更新。
    const { rows: bindings } = await tx.query<{
      file_id: string;
      record_id: string;
    }>(
      "SELECT file_id, record_id FROM record_files WHERE file_id = ANY($1::text[])",
      [ids],
    );
    const stored = new Map(rows.map((file) => [file.id, file]));
    const bound = new Set<string>();
    const linked = new Set<string>();
    for (const binding of bindings) {
      bound.add(binding.file_id);
      if (binding.record_id === recordId) linked.add(binding.file_id);
    }
    for (const entry of entries) {
      const { key, file } = entry;
      const source = stored.get(file.id!);
      const linkedHere = linked.has(file.id!);
      // 已绑定的文件只能留在原单元格，不能挪到可见字段来绕过隐藏权限。
      if (
        !source ||
        (linkedHere && !previous.has(`${key}:${file.id}`)) ||
        (!linkedHere && (bound.has(file.id!) || source.uploaded_by !== actor.id))
      ) {
        throw new BadRequestException("附件不存在或不可使用，请重新上传");
      }
      if (entry.kind === "richtext") {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(source.media_type)) {
          throw new BadRequestException("富文本图片格式无效，请重新上传");
        }
      } else if (
        source.name !== entry.file.name ||
        source.size !== entry.file.size ||
        source.media_type !== entry.file.type
      ) {
        throw new BadRequestException(
          "附件信息与上传内容不一致，请重新选择文件",
        );
      }
    }
    await tx.query(
      `INSERT INTO record_files (file_id, record_id)
       SELECT unnest($1::text[]), $2::uuid ON CONFLICT DO NOTHING`,
      [ids, recordId],
    );
  }

  async metadata(tx: Transaction, actor: Actor, id: string) {
    if (!/^file_[a-f0-9-]{36}$/.test(id))
      throw new NotFoundException("文件不存在或不可访问");
    const { rows } = await tx.query<StoredFile>(
      `SELECT id, name, size, media_type, uploaded_by FROM uploaded_files
       WHERE id = $1 AND workspace_id = $2 FOR SHARE`,
      [id, actor.workspaceId],
    );
    if (!rows[0]) throw new NotFoundException("文件不存在或不可访问");
    return rows[0];
  }

  /** 只取消尚未写入记录的本人上传，不删除业务记录或历史附件。 */
  async discard(actor: Actor, id: string) {
    await this.db.query(
      `DELETE FROM uploaded_files f
       WHERE f.id = $1 AND f.workspace_id = $2 AND f.uploaded_by = $3
         AND NOT EXISTS (SELECT 1 FROM record_files r WHERE r.file_id = f.id)`,
      [id, actor.workspaceId, actor.id],
    );
  }
}
