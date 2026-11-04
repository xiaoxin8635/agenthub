// 与后端 agenthub/schemas 对齐的类型定义（as-built）

export interface Asset {
  id: string
  type: 'dialog' | 'trace' | 'tool_log' | 'doc' | 'custom'
  source: 'manual' | 'trace_import' | 'badcase_feedback'
  content: Record<string, unknown>
  tags: string[]
  meta: Record<string, unknown>
  created_at: string
}

export interface AssetList {
  total: number
  items: Asset[]
}

/** POST /assets/import 结果；errors 为解析失败行（可选） */
export interface ImportResult {
  total: number
  created: number
  skipped: number
  errors?: string[]
}

export interface RunSummary {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  dataset: string | null
  dataset_version_id: string
  target: string | null
  metric_config: string | null
  agent_version: string | null
  total: number | null
  passed: number | null
  pass_rate: number | null
  weighted_total: number | null
  progress?: { done: number; total: number } | null
  created_at: string
  finished_at: string | null
}

export interface RunList {
  total: number
  items: RunSummary[]
}

/** GET /stats（UI-100 仪表盘专用） */
export interface Stats {
  counts: {
    assets: number
    datasets: number
    dataset_versions: number
    runs: number
  }
  trend_30d: { date: string; pass_rate: number; runs: number }[]
  draft_datasets: number
  unfeedback_runs: number
}

/** GET /datasets 返回的数据集概要 */
export interface DatasetBrief {
  id: string
  name: string
  scene: string
  description: string
  draft_count: number
  total_items: number
  latest_version: number | null
  created_at: string
}

/** POST /datasets/{id}/items/from-assets 结果 */
export interface FromAssetsResult {
  added: number
  skipped_invalid: number
  skipped_dup: number
  errors: string[]
  selected: number
}

/** GET /datasets/{id}/items 返回的数据集 item（草稿 version_id 为 null） */
export interface DatasetItem {
  id: string
  input: Record<string, unknown>
  expected: Record<string, unknown>
  context: Record<string, unknown>
  tags: string[]
  source_asset_id: string | null
  version_id: string | null
  created_at: string
}

export interface DatasetItemList {
  total: number
  items: DatasetItem[]
}

/** 新增草稿 item 请求体（POST /datasets/{id}/items） */
export interface NewDatasetItem {
  input: Record<string, unknown>
  expected?: Record<string, unknown>
  context?: Record<string, unknown>
  tags?: string[]
  source_asset_id?: string | null
}

export interface AddItemsResult {
  added: number
  skipped_invalid: number
  skipped_dup: number
  errors: string[]
}

/** GET /datasets/{id}/versions 中的版本（含发布统计） */
export interface DatasetVersion {
  id: string
  dataset_id: string
  version: number
  item_count: number
  stats: { total: number; carried: number; new: number; tags?: Record<string, number> }
  changelog: string
  snapshot_path: string
  created_at: string
}

export interface DatasetVersionList {
  total: number
  items: DatasetVersion[]
}

// ---------- 评测中心（UI-M3） ----------

/** Run 详情（RunOut）：summary 为 finalize 后的聚合结果（见 eval_service.compute_summary） */
export interface RunDetail {
  id: string
  dataset_version_id: string
  target_id: string
  metric_config_id: string
  agent_version: string
  status: RunSummary['status']
  summary: RunSummaryData
  progress?: { done: number; total: number } | null
  error: string
  created_at: string
  // 服务端内联引用（GET /runs/{id}），避免前端遍历解析；数据集/版本已删时为 null
  dataset?: { id: string; name: string; scene: string } | null
  dataset_version?: number | null
  target_name?: string | null
  metric_config_name?: string | null
}

/** compute_summary 聚合结构 */
export interface RunSummaryData {
  total: number
  passed: number
  pass_rate: number | null
  weighted_total: number | null
  /** 逐指标聚合：avg（0~1，N/A 为 null）、pass_rate、n、weight */
  metrics: Record<string, { weight: number; avg: number | null; pass_rate?: number | null; n: number }>
  /** 失败项 tag 分布（降序前 20，全过 run 无此键） */
  failed_tags?: Record<string, number>
}

/** 单条评测结果（EvalResult）。scores 键为指标类型 */
export interface EvalResultItem {
  id: string
  run_id: string
  item_id: string
  output: Record<string, unknown>
  trajectory: Record<string, unknown>
  /** { "<type>": { score, detail, passed } }；score/passed 可为 null（N/A） */
  scores: Record<string, { score: number | null; detail: string; passed: boolean | null }>
  passed: boolean | null
  error: string
}

export interface EvalResultList {
  total: number
  items: EvalResultItem[]
}

/** GET /runs/{id}/compare/{other} 结果 */
export interface CompareResult {
  base_run: string
  compare_run: string
  common_items: number
  metric_diff: Record<string, { base: number | null; compare: number | null; delta: number | null }>
  weighted_total: { base: number | null; compare: number | null; delta: number | null }
  regressions: {
    item_id: string
    base_scores: EvalResultItem['scores']
    compare_scores: EvalResultItem['scores']
    compare_output: Record<string, unknown>
  }[]
  fixed: { item_id: string }[]
  both_failed: number
  both_passed: number
}

/** POST /runs/{id}/feedback 结果 */
export interface FeedbackResult {
  failed_cases: number
  created_assets: number
  skipped_dup: number
  added_items: number
}

/** GET /metrics 指标目录项 */
export interface MetricInfo {
  type: string
  kind: string
  description: string
  builtin?: boolean
}

/** 被测目标（EvalTarget） */
export interface EvalTarget {
  id: string
  name: string
  kind: 'http' | 'external'
  endpoint_config: Record<string, unknown>
  created_at: string
}

/** MetricConfig 中的单个指标声明 */
export interface MetricSpec {
  type: string
  weight?: number
  threshold?: number | null
  [key: string]: unknown
}

/** 指标组合（MetricConfig） */
export interface MetricConfig {
  id: string
  name: string
  scene: string
  metrics: MetricSpec[]
  created_at: string
}

// ---------- 设置（UI-M4） ----------

/** GET /settings 服务端配置只读视图；llm 密钥永远打码，api_key 明文仅供控制台「打码显示+复制」 */
export interface ServerSettings {
  auth_enabled: boolean
  api_key: string
  llm_judge: {
    configured: boolean
    base_url: string
    model: string
    api_key_masked: string
  }
  data_dir: string
  db: string
  cors_origins: string
  run_concurrency?: number
}

export interface GenerateJob {
  id: string
  filename: string
  status: 'running' | 'done' | 'error'
  done: number
  total: number
  generated: number
  inserted?: number
  stats?: { generated: number; kept: number; dropped_exact: number; dropped_fuzzy: number }
  error?: string
}
