-- 文件内容和业务记录均由 PostgreSQL 持久化，不依赖上传者的浏览器。
CREATE TABLE uploaded_files (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  size integer NOT NULL CHECK (size >= 0 AND size <= 524288000),
  media_type text NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) = size)
);

-- 保留历史引用，便于恢复已移除的明细；下载仍须检查记录当前值与当前权限。
CREATE TABLE record_files (
  file_id text NOT NULL REFERENCES uploaded_files(id),
  record_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, record_id)
);
CREATE INDEX record_files_record ON record_files(record_id);
