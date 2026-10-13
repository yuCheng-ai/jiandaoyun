-- 一个表单只有一条提交入口，草稿保存不影响已启用的发布版本。
ALTER TABLE process_templates
  ADD COLUMN start_page_id uuid REFERENCES pages(id),
  ADD COLUMN enabled boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX process_templates_start_page ON process_templates(start_page_id)
  WHERE start_page_id IS NOT NULL;

-- 同一条表单提交只启动一次流程，重试不会生成重复待办。
ALTER TABLE processes ADD COLUMN submission_record_id uuid REFERENCES records(id);
CREATE UNIQUE INDEX processes_submission_record ON processes(submission_record_id)
  WHERE submission_record_id IS NOT NULL;
