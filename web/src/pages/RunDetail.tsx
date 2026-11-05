// Run 详情（UI-403/404/405）：概览（指标卡+环形通过率+指标分布条形图+失败分布）
// / 逐 case 结果 / 版本对比 三个 Tab；running 时 3s 轮询（页面不可见暂停）；回灌入口贯穿
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, Popconfirm, Progress, Row, Space, Spin, Table, Tabs, Tag, Typography, message } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import echarts from '../utils/echarts'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useTheme } from '../theme'
import type { DatasetItem, RunDetail as RunDetailType, RunSummaryData } from '../api/types'
import StatusBadge from '../components/StatusBadge'
import RunCasesTable from '../components/RunCasesTable'
import RunCompareTab from '../components/RunCompareTab'
import FeedbackModal from '../components/FeedbackModal'
import { HeroStat, StatTile, inkTokens } from '../components/statTiles'
import { fmtTime, scoreTone, TONE_COLOR } from '../utils/format'

/** 指标分布条形图（UI-403）：每指标 avg（×100）+ n，N/A 灰「—」 */
function MetricBarChart({ metrics }: { metrics: RunSummaryData['metrics'] }) {
  const ref = useRef<HTMLDivElement>(null)
  const { isDark } = useTheme()
  const entries = Object.entries(metrics)

  useEffect(() => {
    if (ref.current === null || entries.length === 0) return
    const t = inkTokens(isDark)
    const chart = echarts.init(ref.current)
    const sorted = [...entries].sort((a, b) => (b[1].avg ?? 0) - (a[1].avg ?? 0))
    chart.setOption({
      animationDuration: 600,
      animationDurationUpdate: 300,
      animationEasing: 'cubicOut',
      grid: { left: 156, right: 70, top: 10, bottom: 28 },
      tooltip: {
        trigger: 'item',
        backgroundColor: t.tooltipBg,
        borderColor: t.axis,
        borderWidth: 1,
        textStyle: { color: t.ink1, fontSize: 12 },
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
      xAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%', color: t.ink3, fontSize: 11 }, splitLine: { lineStyle: { color: t.grid, type: 'solid' } } },
      yAxis: {
        type: 'category',
        data: sorted.map(([type]) => type),
        axisLabel: { fontSize: 11, color: t.ink3 },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 22,
          emphasis: { itemStyle: { opacity: 0.8 } },
          label: {
            show: true,
            position: 'right',
            formatter: (p: { dataIndex: number }) => {
              const m = sorted[p.dataIndex][1]
              return m.avg == null ? '—' : `${(m.avg * 100).toFixed(1)}%`
            },
            color: t.ink2,
            fontSize: 12,
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
  }, [entries, isDark])

  const height = Math.max(entries.length * 44 + 40, 120)
  return <div ref={ref} style={{ height }} />
}

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>()
  const nav = useNavigate()
  const [run, setRun] = useState<RunDetailType | null>(null)
  const [items, setItems] = useState<DatasetItem[]>([])
  const [loading, setLoading] = useState(true)
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  const load = useCallback(
    async (silent = false) => {
      if (!runId) return
      if (!silent) setLoading(true)
      try {
        setRun(await api.runDetail(runId))
      } catch {
        // 错误已统一 toast
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [runId],
  )

  useEffect(() => {
    void load()
  }, [load])

  const doCancel = async () => {
    if (!runId) return
    try {
      await api.cancelRun(runId)
      message.success('评测已取消')
      void load(true)
    } catch {
      // 错误已统一 toast
    }
  }

  // 快照 items：服务端已内联 dataset@version，仅需一次 items 拉取（版本不变不重拉）
  const dsId = run?.dataset?.id
  const verNo = run?.dataset_version
  useEffect(() => {
    if (!dsId || verNo == null) {
      setItems([])
      return
    }
    let cancelled = false
    api.datasetItems(dsId, { version: verNo, limit: 500 })
      .then((its) => {
        if (!cancelled) setItems(its.items)
      })
      .catch(() => {}) // 错误已统一 toast
    return () => {
      cancelled = true
    }
  }, [dsId, verNo])

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
        <Spin />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          加载 Run 详情…
        </Typography.Text>
      </div>
    )
  }

  const s = run.summary && (run.summary as RunSummaryData).total != null ? (run.summary as RunSummaryData) : null
  const itemsMap = Object.fromEntries(items.map((i) => [i.id, i]))
  const scene = run.dataset?.scene ?? ''
  const metricTypes = s ? Object.keys(s.metrics) : []
  const hasFailed = s != null && s.total > s.passed

  return (
    <div>
      {/* 头部：状态 + 元信息 + 操作 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <Space size={12} wrap>
              <Button
                type="text"
                size="small"
                icon={<ArrowLeftOutlined />}
                onClick={() => nav(-1)}
              >
                返回
              </Button>
              <Typography.Title level={4} style={{ margin: 0 }} className="num">
                Run {run.id.slice(0, 8)}
              </Typography.Title>
              <StatusBadge status={run.status} />
              {(run.status === 'running' || run.status === 'pending') && (
                <Popconfirm
                  title="取消该评测？"
                  description="停止等待执行/回传，状态置为「已取消」；已收到的结果保留但不再聚合。"
                  okText="取消评测"
                  cancelText="不取消"
                  onConfirm={() => void doCancel()}
                >
                  <Button size="small" danger>
                    取消评测
                  </Button>
                </Popconfirm>
              )}
            </Space>
            <div style={{ marginTop: 8 }}>
              <Space size={8} wrap>
                {run.dataset ? (
                  <Tag color="blue">
                    <Link to={`/datasets/${run.dataset.id}`}>
                      {run.dataset.name}@v{run.dataset_version}
                    </Link>
                  </Tag>
                ) : (
                  <Tag>(已删除数据集)</Tag>
                )}
                <Tag color="geekblue">Target：{run.target_name ?? run.target_id}</Tag>
                <Tag color="purple">指标组合：{run.metric_config_name ?? run.metric_config_id}</Tag>
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
            message={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span>{run.status === 'pending' ? '评测排队中，页面每 3 秒自动刷新' : '托管执行进行中，页面每 3 秒自动刷新'}</span>
                {run.progress && run.progress.total > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220 }}>
                    <Progress
                      percent={Math.round((run.progress.done / run.progress.total) * 100)}
                      size="small"
                      status="active"
                      style={{ flex: 1, marginBottom: 0 }}
                    />
                    <span className="num" style={{ fontSize: 12, color: '#8c8c8c', whiteSpace: 'nowrap' }}>
                      {run.progress.done}/{run.progress.total} case
                    </span>
                  </div>
                )}
              </div>
            }
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
                    <StatTile label="评测 case 总数" value={s.total} />
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <StatTile label="通过 case" value={s.passed} sub={`共 ${s.total} 条`} />
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <HeroStat
                      label="通过率（全指标通过）"
                      value={s.pass_rate}
                      digits={1}
                      sub={`${s.passed} / ${s.total} case 全部指标通过`}
                    />
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <StatTile
                      label="加权总分"
                      value={
                        s.weighted_total == null ? (
                          '—'
                        ) : (
                          <span style={{ color: TONE_COLOR[scoreTone(s.weighted_total)] }}>
                            {(s.weighted_total * 100).toFixed(1)}%
                          </span>
                        )
                      }
                      sub="Σ(指标得分 × 权重) ÷ Σ(权重)"
                    />
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
        runLabel={`${run.target_name ?? ''}${run.agent_version ? ` · ${run.agent_version}` : ''}`}
        onDone={() => void load(true)}
      />
    </div>
  )
}
