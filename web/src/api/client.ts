// 统一 API 客户端：解包 {code, data}、错误 toast、401 引导
import type {
  AddItemsResult,
  Asset,
  AssetList,
  CompareResult,
  DatasetBrief,
  DatasetItemList,
  DatasetVersion,
  DatasetVersionList,
  EvalResultList,
  EvalTarget,
  FeedbackResult,
  FromAssetsResult,
  GenerateJob,
  ImportResult,
  MetricConfig,
  MetricInfo,
  MetricSpec,
  NewDatasetItem,
  RunDetail,
  RunList,
  ServerSettings,
  Stats,
} from './types'

const BASE = '/api/v1'

type NoticeType = 'success' | 'error' | 'warning'
type Notifier = (content: string, type: NoticeType) => void

// 由 <Bridge/> 在应用挂载时注入 antd message；请求层不依赖 React
let notifier: Notifier = () => {}
export function setNotifier(fn: Notifier) {
  notifier = fn
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, init)
  } catch {
    notifier('无法连接服务，请确认后端 (127.0.0.1:8300) 已启动', 'error')
    throw new ApiError(0, 'network error')
  }

  let body: { code: number; data?: T; error?: { message: string } } | null = null
  try {
    body = await res.json()
  } catch {
    // 非 JSON 响应按失败处理
  }

  if (!res.ok || !body || body.code !== 0) {
    const msg = body?.error?.message ?? `请求失败（HTTP ${res.status}）`
    if (res.status === 401) notifier('未认证：请在设置页配置 API Key', 'error')
    else notifier(msg, 'error')
    throw new ApiError(res.status, msg)
  }
  return body.data as T
}

function jsonInit(method: string, data: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v))
  }
  return sp.toString()
}

export const api = {
  // 统计
  stats: () => request<Stats>('/stats'),

  // 资产
  assets: (params: {
    type?: string
    source?: string
    tag?: string
    q?: string
    offset?: number
    limit?: number
  }) => request<AssetList>(`/assets?${qs(params)}`),
  asset: (id: string) => request<Asset>(`/assets/${id}`),
  patchAsset: (id: string, body: { tags?: string[] }) =>
    request<Asset>(`/assets/${id}`, jsonInit('PATCH', body)),
  deleteAsset: (id: string) =>
    request<{ deleted: string }>(`/assets/${id}`, { method: 'DELETE' }),
  deleteAssetsBatch: (ids: string[]) =>
    request<{ deleted: string[] }>('/assets/batch-delete', jsonInit('POST', { ids })),
  deleteTarget: (id: string) =>
    request<{ deleted: string }>(`/targets/${id}`, { method: 'DELETE' }),
  deleteMetricConfig: (id: string) =>
    request<{ deleted: string }>(`/metric-configs/${id}`, { method: 'DELETE' }),
  updateMetricConfig: (id: string, body: { name?: string; metrics?: MetricSpec[] }) =>
    request<MetricConfig>(`/metric-configs/${id}`, jsonInit('PUT', body)),
  importAssets: (file: File, source: string, tags: string[]) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('source', source)
    fd.append('tags', tags.join(','))
    return request<ImportResult>('/assets/import', { method: 'POST', body: fd })
  },
  generateEvalset: (file: File, perChunk: number) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('per_chunk', String(perChunk))
    return request<{ job_id: string }>('/assets/generate', { method: 'POST', body: fd })
  },
  generateJob: (id: string) => request<GenerateJob>(`/assets/generate/${id}`),

  // Run（列表与下拉）
  runs: (params: {
    status?: string
    dataset?: string
    target?: string
    limit?: number
    offset?: number
  }) => request<RunList>(`/runs?${qs(params)}`),

  // 评测中心（UI-M3）
  runDetail: (runId: string) => request<RunDetail>(`/runs/${runId}`),
  createRun: (body: {
    dataset_version_id: string
    target_id: string
    metric_config_id: string
    agent_version?: string
  }) => request<RunDetail>('/runs', jsonInit('POST', body)),
  startRun: (runId: string) => request<{ started: string }>(`/runs/${runId}/start`, { method: 'POST' }),
  runResults: (
    runId: string,
    params: { passed?: boolean; offset?: number; limit?: number },
  ) => request<EvalResultList>(`/runs/${runId}/results?${qs(params)}`),
  feedback: (runId: string, body: { dataset?: string; tags?: string[] }) =>
    request<FeedbackResult>(`/runs/${runId}/feedback`, jsonInit('POST', body)),
  compareRuns: (runId: string, otherRunId: string) =>
    request<CompareResult>(`/runs/${runId}/compare/${otherRunId}`),
  deleteRun: (runId: string) =>
    request<{ deleted: string[]; results_removed: number; skipped_running: string[] }>(`/runs/${runId}`, { method: 'DELETE' }),
  cancelRun: (runId: string) =>
    request<{ canceled: string }>(`/runs/${runId}/cancel`, { method: 'POST' }),
  deleteRunsBatch: (ids: string[]) =>
    request<{ deleted: string[]; results_removed: number; skipped_running: string[] }>(
      '/runs/batch-delete',
      jsonInit('POST', { ids }),
    ),

  // 指标与目标管理（UI-407）
  metrics: () => request<MetricInfo[]>('/metrics'),
  targets: () => request<EvalTarget[]>('/targets'),
  createTarget: (body: { name: string; kind: string; endpoint_config: Record<string, unknown> }) =>
    request<EvalTarget>('/targets', jsonInit('POST', body)),
  metricConfigs: () => request<MetricConfig[]>('/metric-configs'),
  createMetricConfig: (body: { name: string; scene: string; metrics: MetricSpec[] }) =>
    request<MetricConfig>('/metric-configs', jsonInit('POST', body)),

  // 数据集（UI-M2）
  datasets: () => request<DatasetBrief[]>('/datasets'),
  dataset: (idOrName: string) => request<DatasetBrief>(`/datasets/${idOrName}`),
  createDataset: (body: { name: string; scene: string; description: string }) =>
    request<DatasetBrief>('/datasets', jsonInit('POST', body)),
  deleteDataset: (id: string) =>
    request<{ deleted: string; items_removed: number }>(`/datasets/${id}`, { method: 'DELETE' }),
  datasetItems: (
    idOrName: string,
    params: { draft?: boolean; version?: number; offset?: number; limit?: number },
  ) => request<DatasetItemList>(`/datasets/${idOrName}/items?${qs(params)}`),
  addDatasetItems: (idOrName: string, body: { items: NewDatasetItem[]; skip_invalid?: boolean }) =>
    request<AddItemsResult>(`/datasets/${idOrName}/items`, jsonInit('POST', body)),
  deleteDatasetItem: (idOrName: string, itemId: string) =>
    request<{ deleted: string }>(`/datasets/${idOrName}/items/${itemId}`, { method: 'DELETE' }),
  datasetVersions: (idOrName: string) => request<DatasetVersionList>(`/datasets/${idOrName}/versions`),
  publishVersion: (idOrName: string, body: { changelog: string; skip_invalid?: boolean }) =>
    request<DatasetVersion>(`/datasets/${idOrName}/versions`, jsonInit('POST', body)),
  addFromAssets: (
    datasetId: string,
    body: { asset_ids?: string[]; filters?: Record<string, unknown>; tags?: string[] },
  ) => request<FromAssetsResult>(`/datasets/${datasetId}/items/from-assets`, jsonInit('POST', body)),

  // 设置（UI-M4）
  settings: () => request<ServerSettings>('/settings'),
}
