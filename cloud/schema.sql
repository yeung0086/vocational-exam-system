-- 培训考试系统 · 云端数据库结构（灾难重建用）
-- 应用 ID: wbapp_NXmA1pQRCxl5DCuoiSvr2h
-- 说明：服务端无用户会话，以 anon 身份读写，故两表均需授权 anon + 全表 RLS 策略。
-- 执行方式：在平台数据库管理工具中【逐条语句执行】（该工具一次只接受一条 SQL），
--          按本文件从上到下顺序执行即可；重复执行安全（IF NOT EXISTS / DROP POLICY IF EXISTS）。

-- 1. 学员答卷状态表
CREATE TABLE IF NOT EXISTS exam_results (
  name          TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'idle',
  progress      INTEGER DEFAULT 0,
  total         INTEGER DEFAULT 0,
  current       INTEGER DEFAULT 0,
  score         INTEGER,
  correct       INTEGER,
  duration_sec  INTEGER,
  attempts      INTEGER DEFAULT 0,
  answers       JSONB DEFAULT '[]',
  picks         JSONB DEFAULT '[]',
  q_times       JSONB DEFAULT '[]',
  started_at    BIGINT,
  finished_at   BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 应用级配置表（目前唯一键 studentOpen）
CREATE TABLE IF NOT EXISTS exam_config (
  key         TEXT PRIMARY KEY,
  value_json  JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. 行级安全
ALTER TABLE exam_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_config  ENABLE ROW LEVEL SECURITY;

-- 4. 授权（服务端匿名访问必需）
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exam_results TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exam_config  TO authenticated, anon;

-- 5. 全表策略
DROP POLICY IF EXISTS exam_results_all ON exam_results;
CREATE POLICY exam_results_all ON exam_results FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS exam_config_all ON exam_config;
CREATE POLICY exam_config_all ON exam_config FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

-- 6. 初始开关：开放（仅在不存在时插入，不覆盖已有值）
INSERT INTO exam_config (key, value_json) VALUES ('studentOpen', 'true'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- 7. 清空考试数据（开考前重置用；谨慎执行，会删除全部成绩）
-- DELETE FROM exam_results;
-- DELETE FROM exam_config;
