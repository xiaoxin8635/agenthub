// 评测 Run 列表（UI-401）：状态/数据集/Target 筛选 + 通过率色条 + running 行 3s 轮询（页面不可见暂停）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Key } from 'react'
import { Button, Card, Empty, Popconfirm, Progress, Select, Space, Table, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { DeleteOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import type { DatasetBrief, EvalTarget, RunSummary } from '../api/types'
import PassRate from '../components/PassRate'
import StatusBadge from '../components/StatusBadge'
import StartRunWizard from '../components/StartRunWizard'
import { fmtPct, fmtTime, scoreTone, TONE_COLOR } from '../utils/format'

const STATUS_OPTIONS = [
  { value: 'pending', label: '待执行' },
  { value: 'running', label: '运行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
]

/** 执行中行内进度条（后端 run.progress 每 case 实时更新） */
function RunProgress({ progress, status }: { progress: NonNullable<RunSummary['progress']>; status: string }) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Progress percent={pct} size="small" style={{ flex: 1, marginBottom: 0 }} status={status === 'pending' ? 'normal' : 'active'} />
      <span className="num" style={{ fontSize: 12, color: '#8c8c8c', whiteSpace: 'nowrap' }}>
        {progress.done}/{progress.total}
      </span>
    </div>
  )
}

export default function Runs() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<string>()
  const [dataset, setDataset] = useState<string>()
  const [target, setTarget] = useState<string>()
  const [datasets, setDatasets] = useState<DatasetBrief[]>([])
  const [targets, setTargets] = useState<EvalTarget[]>([])
  const [wizardOpen, setWizardOpen] = useState(false)
  const [selected, setSelected] = useState<Key[]>([])
  const [deleting, setDeleting] = useState(false)
  const nav = useNavigate()

  // 「用此版本发起评测」入口：/runs?dataset=<name>&vid=<versionId> → 自动打开向导并预选
  const [searchParams, setSearchParams] = useSearchParams()
  const preselect = {
    datasetName: searchParams.get('dataset') ?? undefined,
    versionId: searchParams.get('vid') ?? undefined,
  }
  const [wizardInitial] = useState(preselect)
  useEffect(() => {
    if (preselect.datasetName) {
      setWizardOpen(true)
      setSearchParams({}, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filters = useRef({ status, dataset, target })
  filters.current = { status, dataset, target }

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const f = filters.current
      const r = await api.runs({ status: f.status, dataset: f.dataset, target: f.target, limit: 100 })
      setRuns(r.items)
      setTotal(r.total)
      // 清掉已不在列表中的选中项（被删/被筛掉）
      const alive = new Set(r.items.map((i) => i.id))
      setSelected((prev) => prev.filter((k) => alive.has(String(k))))
    } catch {
      // 错误已统一 toast；保留旧数据供重试
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // 首次加载 + 筛选变化重载；同时拉取筛选下拉数据
  useEffect(() => {
    void load()
    api.datasets().then(setDatasets).catch(() => {})
    api.targets().then(setTargets).catch(() => {})
  }, [load, status, dataset, target])

  // 存在未完成 Run 时 3s 静默轮询；页面不可见暂停，恢复可见立即刷新
  const hasActive = runs.some((r) => r.status === 'running' || r.status === 'pending')
  useEffect(() => {
    if (!hasActive) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true)
    }, 3000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [hasActive, load])

  const columns: ColumnsType<RunSummary> = [
    { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => <StatusBadge status={s} /> },
    { title: '数据集@版本', dataIndex: 'dataset', render: (v: string | null) => v ?? '—' },
    { title: 'Target', dataIndex: 'target', width: 150, render: (v: string | null) => v ?? '—' },
    { title: '指标组合', dataIndex: 'metric_config', width: 170, render: (v: string | null) => v ?? '—' },
    { title: 'Agent 版本', dataIndex: 'agent_version', width: 110, render: (v: string | null) => v || '—' },
    {
      title: '通过率 / 进度',
      dataIndex: 'pass_rate',
      width: 180,
      render: (v: number | null, row) =>
        (row.status === 'running' || row.status === 'pending') && row.progress ? (
          <RunProgress progress={row.progress} status={row.status} />
        ) : (
          <PassRate value={v} />
        ),
    },
    {
      title: '加权总分',
      dataIndex: 'weighted_total',
      width: 100,
      render: (v: number | null) => (
        <span className="num" style={{ color: v == null ? undefined : TONE_COLOR[scoreTone(v)] }}>
          {fmtPct(v)}
        </span>
      ),
    },
    {
      title: '发起时间',
      dataIndex: 'created_at',
      width: 150,
      render: (v: string) => <span className="num">{fmtTime(v)}</span>,
    },
    {
      title: '操作',
      key: 'op',
      width: 130,
      render: (_, r) => {
        if (r.status === 'running' || r.status === 'pending') {
          return (
            <Space size={0}>
              <Popconfirm
                title="取消该评测？"
                description="停止等待执行/回传，状态置为「已取消」；已收到的结果保留但不再聚合。"
                okText="取消评测"
                cancelText="不取消"
                onConfirm={(e) => {
                  e?.stopPropagation()
                  void doCancel(r.id)
                }}
                onCancel={(e) => e?.stopPropagation()}
              >
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  取消
                </Button>
              </Popconfirm>
              <span style={{ color: '#d9d9d9' }}>|</span>
              <span style={{ color: '#bfbfbf', fontSize: 12, padding: '0 8px' }}>执行中</span>
            </Space>
          )
        }
        return (
          <Popconfirm
            title="删除该评测？"
            description="将同时删除其全部逐 case 结果，不可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={(e) => {
              e?.stopPropagation()
              void doDelete([r.id])
            }}
            onCancel={(e) => e?.stopPropagation()}
          >
            <Button
              type="link"
              danger
              size="small"
              icon={<DeleteOutlined />}
              style={{ padding: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              删除
            </Button>
          </Popconfirm>
        )
      },
    },
  ]

  const hasFilter = !!(status || dataset || target)

  // ---------- 取消（pending/running → canceled 终态） ----------
  const doCancel = async (runId: string) => {
    try {
      await api.cancelRun(runId)
      message.success('评测已取消')
      void load(true)
    } catch {
      // 错误已 toast
    }
  }

  // ---------- 删除（单个 / 批量；running 由后端拒绝并跳过） ----------
  const selectedRunning = selected.filter((k) => runs.find((r) => r.id === String(k))?.status === 'running').length

  const doDelete = async (ids: string[]) => {
    setDeleting(true)
    try {
      const r = ids.length === 1
        ? await api.deleteRun(ids[0])
        : await api.deleteRunsBatch(ids)
      const n = r.deleted.length
      const skip = r.skipped_running.length
      if (n) message.success(`已删除 ${n} 个评测${skip ? `，跳过执行中 ${skip} 个` : ''}`)
      else if (skip) message.warning('执行中的评测不能删除，已全部跳过')
      setSelected((prev) => prev.filter((k) => !r.deleted.includes(String(k))))
      void load(true)
    } catch {
      // 错误已 toast
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }} wrap>
          <Space wrap>
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 130 }}
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
            />
            <Select
              allowClear
              placeholder="数据集"
              style={{ width: 190 }}
              value={dataset}
              onChange={setDataset}
              options={datasets.map((d) => ({ value: d.name, label: d.name }))}
            />
            <Select
              allowClear
              placeholder="Target"
              style={{ width: 170 }}
              value={target}
              onChange={setTarget}
              options={targets.map((t) => ({ value: t.name, label: t.name }))}
            />
            {selected.length > 0 && (
              <Popconfirm
                title={`删除选中的 ${selected.length} 个评测？`}
                description={
                  selectedRunning > 0
                    ? `其中 ${selectedRunning} 个正在执行将被跳过，其余的逐 case 结果会一并删除，不可恢复。`
                    : '将同时删除全部逐 case 结果，不可恢复。'
                }
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void doDelete(selected.map(String))}
              >
                <Button danger icon={<DeleteOutlined />} loading={deleting}>
                  删除选中（{selected.length}）
                </Button>
              </Popconfirm>
            )}
          </Space>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setWizardOpen(true)}>
            发起评测
          </Button>
        </Space>

        <Table<RunSummary>
          rowKey="id"
          loading={loading}
          dataSource={runs}
          columns={columns}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys),
            selections: [Table.SELECTION_ALL, Table.SELECTION_INVERT, Table.SELECTION_NONE],
          }}
          locale={{
            emptyText: hasFilter ? (
              '没有符合筛选条件的 Run'
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有评测 Run：完成「导入资产 → 创建数据集 → 发布版本」后，在这里发起首次评测"
                style={{ padding: '32px 0' }}
              >
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setWizardOpen(true)}>
                  发起首次评测
                </Button>
              </Empty>
            ),
          }}
          pagination={{
            total,
            pageSize: 100,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            hideOnSinglePage: true,
          }}
          onRow={(r) => ({
            style: { cursor: 'pointer' },
            onClick: (e) => {
              // 复选框列点击不触发行跳转（避免勾选时误入详情）
              if ((e.target as HTMLElement).closest('.ant-table-selection-column')) return
              nav(`/runs/${r.id}`)
            },
          })}
        />
      </Card>

      <StartRunWizard
        open={wizardOpen}
        initial={wizardInitial.datasetName ? wizardInitial : undefined}
        onClose={() => setWizardOpen(false)}
        onCreated={(runId) => {
          setWizardOpen(false)
          nav(`/runs/${runId}`)
        }}
      />
    </div>
  )
}
