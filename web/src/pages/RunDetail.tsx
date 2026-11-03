// Run 详情（UI-403/404/405）：概览（指标卡+环形通过率+指标分布条形图+失败分布）
// / 逐 case 结果 / 版本对比 三个 Tab；running 时 3s 轮询（页面不可见暂停）；回灌入口贯穿
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Card, Col, Progress, Row, Space, Spin, Statistic, Table, Tabs, Tag, Typography } from 'antd'
import * as echarts from 'echarts'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type {
  DatasetBrief,
  DatasetItem,
  DatasetVersion,
  EvalTarget,
  MetricConfig,
  RunDetail as RunDetailType,
  RunSummaryData,
} from '../api/types'
import StatusBadge from '../components/StatusBadge'
import RunCasesTable from '../components/RunCasesTable'
import RunCompareTab from '../components/RunCompareTab'
import FeedbackModal from '../components/FeedbackModal'
import { fmtTime, scoreTone, TONE_COLOR } from '../utils/format'

/** 指标分布条形图（UI-403）：每指标 avg（×100）+ n，N/A 灰「—」 */
function MetricBarChart({ metrics }: { metrics: RunSummaryData['metrics'] }) {
  const ref = useRef<HTMLDivElement>(null)
  const entries = Object.entries(metrics)

  useEffect(() => {
    if (ref.current === null || entries.length === 0) return
    const chart = echarts.init(ref.current)
    const sorted = [...entries].sort((a, b) => (b[1].avg ?? 0) - (a[1].avg ?? 0))
    chart.setOption({
      grid: { left: 130, right: 70, top: 10, bottom: 28 },
      tooltip: {
        trigger: 'item',
        formatter: (p: { dataIndex: number }) => {
          const [type, m] = sorted[p.dataIndex]
          return [
            `<b>${type}</b>`,
            `平均分 ${m.avg == null ? '—（无法评估）' : `${(m.avg * 100).toFixed(1)}%`}`,
            `样本 n=${m.n} · 权重 ×${m.weight}`,
            m.pass_rate != null ? `指标通过率 ${(m.pass_rate * 100).toFixed(1)}%` : null,
          ]
            .filter(Boolean)
            .join('<br/>')
        },
      },
      xAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      yAxis: {
        type: 'category',
        data: sorted.map(([type]) => type),
        axisLabel: { fontSize: 11 },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 22,
          label: {
            show: true,
            position: 'right',
            formatter: (p: { dataIndex: number }) => {
              const m = sorted[p.dataIndex][1]
              return m.avg == null ? '—' : `${(m.avg * 100).toFixed(1)}%`
            },
            color: '#595959',
            fontFamily: 'monospace',
          },
          data: sorted.map(([, m]) => {
            if (m.avg == null) {
              return { value: 0, itemStyle: { color: TONE_COLOR.na }, tooltip: 'N/A' }
            }
            const c = TONE_COLOR[scoreTone(m.avg)]
            return { value: +(m.avg * 100).toFixed(1), itemStyle: { color: c, borderRadius: [0, 4, 4, 0] } }
          }),
        },
      ],
    })
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
    }
  }, [entries])

  const height = Math.max(entries.length * 44 + 40, 120)
  return <div ref={ref} style={{ height }} />
}

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>()
  const [run, setRun] = useState<RunDetailType | null>(null)
  const [target, setTarget] = useState<EvalTarget | null>(null)
  const [config, setConfig] = useState<MetricConfig | null>(null)
  const [dataset, setDataset] = useState<DatasetBrief | null>(null)
  const [version, setVersion] = useState<DatasetVersion | null>(null)
  const [items, setItems] = useState<DatasetItem[]>([])
  const [loading, setLoading] = useState(true)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const resolvedRef = useRef(false)

  // 数据集 / 版本 / 快照 items 解析：无「版本 id → 版本」端点，遍历数据集版本匹配（数据集数量少，可接受）
  const resolveRefs = useCallback(async (r: RunDetailType) => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    try {
      const [tgs, mcs, dss] = await Promise.all([api.targets(), api.metricConfigs(), api.datasets()])
      setTarget(tgs.find((t) => t.id === r.target_id) ?? null)
      setConfig(mcs.find((c) => c.id === r.metric_config_id) ?? null)
      for (const ds of dss) {
        const vs = await api.datasetVersions(ds.id)
        const v = vs.items.find((x) => x.id === r.dataset_version_id)
        if (v) {
          setDataset(ds)
          setVersion(v)
          const its = await api.datasetItems(ds.id, { version: v.version, limit: 500 })
          setItems(its.items)
          break
        }
      }
    } catch {
      resolvedRef.current = false // 失败允许下次轮询重试
    }
  }, [])

  const load = useCallback(
    async (silent = false) => {
      if (!runId) return
      if (!silent) setLoading(true)
      try {
        const r = await api.runDetail(runId)
        setRun(r)
        await resolveRefs(r)
      } catch {
        // 错误已统一 toast
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [runId, resolveRefs],
  )

  useEffect(() => {
    resolvedRef.current = false
    void load()
  }, [load])

  // pending/running 时 3s 轮询，done/failed 即停；页面不可见暂停
  const active = run?.status === 'pending' || run?.status === 'running'
  useEffect(() => {
    if (!active) return
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
  }, [active, load])

  if (loading || !run) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin tip="加载 Run 详情…" />
      </div>
    )
  }

  const s = run.summary && (run.summary as RunSummaryData).total != null ? (run.summary as RunSummaryData) : null
  const itemsMap = Object.fromEntries(items.map((i) => [i.id, i]))
  const scene = config?.scene ?? dataset?.scene ?? ''
  const metricTypes = config?.metrics.map((m) => m.type) ?? (s ? Object.keys(s.metrics) : [])
  const hasFailed = s != null && s.total > s.passed

  return (
    <div>
      {/* 头部：状态 + 元信息 + 操作 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <Space size={12} wrap>
              <Typography.Title level={4} style={{ margin: 0 }} className="num">
                Run {run.id.slice(0, 8)}
              </Typography.Title>
              <StatusBadge status={run.status} />
            </Space>
            <div style={{ marginTop: 8 }}>
              <Space size={8} wrap>
                {dataset && version ? (
                  <Tag color="blue">
                    <Link to={`/datasets/${dataset.id}`}>
                      {dataset.name}@v{version.version}
                    </Link>
                  </Tag>
                ) : (
                  <Tag>(已删除数据集)</Tag>
                )}
                <Tag color="geekblue">Target：{target?.name ?? run.target_id}</Tag>
                <Tag color="purple">指标组合：{config?.name ?? run.metric_config_id}</Tag>
                {run.agent_version && <Tag>Agent：{run.agent_version}</Tag>}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  发起于 <span className="num">{fmtTime(run.created_at)}</span>
                </Typography.Text>
              </Space>
            </div>
          </div>
          {hasFailed && (
            <a
              onClick={() => setFeedbackOpen(true)}
              style={{ color: '#ff4d4f', fontWeight: 500 }}
            >
              回灌失败 case（{s ? s.total - s.passed : 0} 条）→
            </a>
          )}
        </div>
        {active && (
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            icon={<Spin size="small" />}
            message={run.status === 'pending' ? '评测排队中，页面每 3 秒自动刷新…' : '托管执行进行中，页面每 3 秒自动刷新…'}
          />
        )}
        {run.status === 'failed' && run.error && (
          <Alert style={{ marginTop: 12 }} type="error" showIcon message={run.error} />
        )}
      </Card>

      <Tabs
        defaultActiveKey="overview"
        items={[
          {
            key: 'overview',
            label: '概览',
            children: s ? (
              <div>
                <Row gutter={[16, 16]}>
                  <Col xs={24} sm={12} lg={6}>
                    <Card>
                      <Statistic title="评测 case 总数" value={s.total} />
                    </Card>
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <Card>
                      <Statistic title="通过 case" value={s.passed} suffix={`/ ${s.total}`} />
                    </Card>
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <Card>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <Progress
                          type="circle"
                          size={96}
                          percent={s.pass_rate == null ? 0 : s.pass_rate * 100}
                          strokeColor={s.pass_rate == null ? TONE_COLOR.na : TONE_COLOR[scoreTone(s.pass_rate)]}
                          format={() =>
                            s.pass_rate == null ? '—' : `${(s.pass_rate * 100).toFixed(1)}%`
                          }
                        />
                        <div>
                          <div style={{ color: 'rgba(0,0,0,.45)' }}>通过率</div>
                          <div style={{ color: '#8c8c8c', fontSize: 12 }}>{s.passed} / {s.total} case 全指标通过</div>
                        </div>
                      </div>
                    </Card>
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <Card>
                      <Statistic
                        title="加权总分"
                        value={s.weighted_total == null ? '—' : (s.weighted_total * 100).toFixed(1)}
                        suffix={s.weighted_total == null ? undefined : '%'}
                        valueStyle={{
                          color: s.weighted_total == null ? TONE_COLOR.na : TONE_COLOR[scoreTone(s.weighted_total)],
                        }}
                      />
                    </Card>
                  </Col>
                </Row>

                <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                  <Col xs={24} lg={14}>
                    <Card title="指标分布（平均分 × 样本数）" size="small">
                      {Object.keys(s.metrics).length > 0 ? (
                        <MetricBarChart metrics={s.metrics} />
                      ) : (
                        <Typography.Text type="secondary">该指标组合为空</Typography.Text>
                      )}
                    </Card>
                  </Col>
                  <Col xs={24} lg={10}>
                    <Card title="失败分布（按 tag 聚合）" size="small">
                      {s.failed_tags && Object.keys(s.failed_tags).length > 0 ? (
                        <Table
                          rowKey="tag"
                          size="small"
                          pagination={false}
                          dataSource={Object.entries(s.failed_tags).map(([tag, n]) => ({ tag, n }))}
                          columns={[
                            {
                              title: '标签',
                              dataIndex: 'tag',
                              render: (t: string) => (
                                <Tag color="red">{t.startsWith('run:') ? <span className="num">{t}</span> : t}</Tag>
                              ),
                            },
                            {
                              title: '失败 case 数',
                              dataIndex: 'n',
                              width: 110,
                              render: (n: number) => <span className="num">{n}</span>,
                            },
                          ]}
                        />
                      ) : (
                        <Alert type="success" showIcon message="全部通过，没有失败 case" />
                      )}
                    </Card>
                  </Col>
                </Row>
              </div>
            ) : (
              <Alert
                type="info"
                showIcon
                message={run.status === 'pending' || run.status === 'running' ? '评测完成后这里会展示聚合指标' : '尚无聚合结果'}
              />
            ),
          },
          {
            key: 'cases',
            label: '逐 case 结果',
            children: (
              <RunCasesTable
                runId={run.id}
                scene={scene}
                metricTypes={metricTypes}
                itemsMap={itemsMap}
                onFeedback={() => setFeedbackOpen(true)}
                feedbackVisible={s != null && hasFailed}
              />
            ),
          },
          {
            key: 'compare',
            label: '版本对比',
            children: <RunCompareTab run={run} />,
          },
        ]}
      />

      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        runId={run.id}
        runLabel={`${target?.name ?? ''}${run.agent_version ? ` · ${run.agent_version}` : ''}`}
        onDone={() => void load(true)}
      />
    </div>
  )
}
