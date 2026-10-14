-- 发布编号只增不减；启用版本单独记录，切换版本不改已有流程实例。
ALTER TABLE process_templates ADD COLUMN active_version integer;
UPDATE process_templates SET active_version = latest_version WHERE latest_version > 0;
ALTER TABLE process_templates
  ADD CONSTRAINT process_active_version_ref
  FOREIGN KEY (id, active_version) REFERENCES process_template_versions(template_id, version);

-- 历史内容仍不可修改；仅允许删除未启用且没有实例引用的版本。
-- 启用版本及实例引用分别由外键保护，服务端同时给出可读的拒绝原因。
DROP TRIGGER immutable_process_template_version ON process_template_versions;
CREATE TRIGGER immutable_process_template_version
BEFORE UPDATE ON process_template_versions
FOR EACH ROW EXECUTE FUNCTION immutable_definition_version();
