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

/** 仅收集真实的附件字段，不能通过其他字段中伪造同名 ID 获得下载权限。 */
export function recordFileValues(
  schema: FormSchema,
  values: FormValues,
): FileValue[] {
  return recordFileEntries(schema, values).map((entry) => entry.file);
}

function recordFileEntries(schema: FormSchema, values: FormValues) {
  const files: { key: string; file: FileValue }[] = [];
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
    if (field.type !== "file" && field.type !== "image") return;
    const value = input[field.id];
    if (Array.isArray(value)) {
      for (const file of value as FileValue[]) {
        files.push({ key: `${prefix}${field.id}`, file });
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
    const { rows } = await tx.query<
      StoredFile & { linked: boolean; bound: boolean }
    >(
      `SELECT f.id, f.name, f.size, f.media_type, f.uploaded_by,
         EXISTS (SELECT 1 FROM record_files r WHERE r.file_id = f.id AND r.record_id = $3) AS linked,
         EXISTS (SELECT 1 FROM record_files r WHERE r.file_id = f.id) AS bound
       FROM uploaded_files f
       WHERE f.workspace_id = $1 AND f.id = ANY($2::text[])
       ORDER BY f.id FOR SHARE OF f`,
      [actor.workspaceId, ids, recordId],
    );
    const stored = new Map(rows.map((file) => [file.id, file]));
    for (const { key, file } of entries) {
      const source = stored.get(file.id!);
      // 已绑定的文件只能留在原单元格，不能挪到可见字段来绕过隐藏权限。
      if (
        !source ||
        (source.linked && !previous.has(`${key}:${file.id}`)) ||
        (!source.linked && (source.bound || source.uploaded_by !== actor.id))
      ) {
        throw new BadRequestException("附件不存在或不可使用，请重新上传");
      }
      if (
        source.name !== file.name ||
        source.size !== file.size ||
        source.media_type !== file.type
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
