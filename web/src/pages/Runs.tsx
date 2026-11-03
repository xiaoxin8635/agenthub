// 评测 Run 列表（UI-401）：状态/数据集/Target 筛选 + 通过率色条 + running 行 3s 轮询（页面不可见暂停）
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Empty, Select, Space, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { PlayCircleOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import type { DatasetBrief, EvalTarget, RunSummary } from '../api/types'
import PassRate from '../components/PassRate'
import StatusBadge from '../components/StatusBadge'
import StartRunWizard from '../components/StartRunWizard'
import { fmtPct, fmtTime } from '../utils/format'

const STATUS_OPTIONS = [
  { value: 'pending', label: '待执行' },
  { value: 'running', label: '运行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
]

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
    { title: '通过率', dataIndex: 'pass_rate', width: 180, render: (v: number | null) => <PassRate value={v} /> },
    {
      title: '加权总分',
      dataIndex: 'weighted_total',
      width: 100,
      render: (v: number | null) => <span className="num">{fmtPct(v)}</span>,
    },
    {
      title: '发起时间',
      dataIndex: 'created_at',
      width: 150,
      render: (v: string) => <span className="num">{fmtTime(v)}</span>,
    },
  ]

  const hasFilter = !!(status || dataset || target)

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
            onClick: () => nav(`/runs/${r.id}`),
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
