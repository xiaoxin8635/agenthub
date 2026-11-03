// 仪表盘（UI-100）：指标卡 4 张 + 通过率趋势 + 最近 Run + 待办条 + 空态引导
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Card, Col, Progress, Row, Space, Statistic, Table } from 'antd'
import echarts from '../utils/echarts'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { RunSummary, Stats } from '../api/types'
import PassRate from '../components/PassRate'
import StatusBadge from '../components/StatusBadge'
import EmptyGuide from '../components/EmptyGuide'
import { fmtTime } from '../utils/format'

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const nav = useNavigate()

  const load = async () => {
    setLoading(true)
    try {
      const [s, r] = await Promise.all([api.stats(), api.runs({ limit: 10 })])
      setStats(s)
      setRuns(r.items)
    } catch {
      // 错误已统一 toast
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  // 近 30 天平均通过率（按 Run 数加权）
  const avgPassRate = useMemo(() => {
    if (!stats || stats.trend_30d.length === 0) return null
    let sum = 0
    let n = 0
    for (const t of stats.trend_30d) {
      sum += t.pass_rate * t.runs
      n += t.runs
    }
    return n > 0 ? sum / n : null
  }, [stats])

  const isEmpty =
    stats != null &&
    stats.counts.assets === 0 &&
    stats.counts.datasets === 0 &&
    stats.counts.runs === 0

  if (isEmpty) return <EmptyGuide />

  return (
    <div>
      {/* UI-104 待办提示条 */}
      {stats && (stats.draft_datasets > 0 || stats.unfeedback_runs > 0) && (
        <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
          {stats.draft_datasets > 0 && (
            <Alert
              type="info"
              showIcon
              message={
                <Link to="/datasets">
                  有 {stats.draft_datasets} 个数据集存在未发布草稿，前往处理 →
                </Link>
              }
            />
          )}
          {stats.unfeedback_runs > 0 && (
            <Alert
              type="warning"
              showIcon
              message={
                <Link to="/runs">
                  有 {stats.unfeedback_runs} 次评测的失败 case 未回灌，前往处理 →
                </Link>
              }
            />
          )}
        </Space>
      )}

      {/* UI-101 指标卡 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading}>
            <Statistic title="数据资产" value={stats?.counts.assets ?? 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading}>
            <Statistic
              title="评测数据集"
              value={stats?.counts.datasets ?? 0}
              suffix={
                <span style={{ fontSize: 14, color: '#8c8c8c' }}>
                  / {stats?.counts.dataset_versions ?? 0} 个版本
                </span>
              }
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading}>
            <Statistic title="评测 Run" value={stats?.counts.runs ?? 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card loading={loading}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <Progress
                type="circle"
                size={72}
                percent={avgPassRate == null ? 0 : avgPassRate * 100}
                strokeColor={avgPassRate == null ? '#bfbfbf' : undefined}
                format={() => (avgPassRate == null ? '—' : `${(avgPassRate * 100).toFixed(0)}%`)}
              />
              <div>
                <div style={{ color: 'rgba(0,0,0,.45)' }}>平均通过率（近 30 天）</div>
                <div style={{ color: '#8c8c8c', fontSize: 12 }}>
                  基于 {stats?.trend_30d.reduce((n, t) => n + t.runs, 0) ?? 0} 次已完成评测
                </div>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* UI-102 通过率趋势 */}
      <Card title="通过率趋势（近 30 天）" style={{ marginTop: 16 }} loading={loading}>
        {stats && stats.trend_30d.length > 0 ? (
          <TrendChart trend={stats.trend_30d} />
        ) : (
          <div style={{ color: '#8c8c8c', textAlign: 'center', padding: '48px 0' }}>
            暂无已完成的评测，发起首次评测后这里会显示每日通过率曲线
          </div>
        )}
      </Card>

      {/* UI-103 最近评测 Run */}
      <Card title="最近评测 Run" style={{ marginTop: 16 }} loading={loading}>
        <Table<RunSummary>
          rowKey="id"
          size="small"
          dataSource={runs}
          pagination={false}
          onRow={() => ({ style: { cursor: 'pointer' }, onClick: () => nav('/runs') })}
          columns={[
            { title: '数据集@版本', dataIndex: 'dataset', render: (v) => v ?? '—' },
            { title: 'Target', dataIndex: 'target', render: (v) => v ?? '—' },
            { title: '指标组合', dataIndex: 'metric_config', render: (v) => v ?? '—' },
            { title: 'Agent 版本', dataIndex: 'agent_version', render: (v) => v || '—' },
            {
              title: '通过率',
              dataIndex: 'pass_rate',
              width: 180,
              render: (v: number | null) => <PassRate value={v} />,
            },
            { title: '状态', dataIndex: 'status', width: 90, render: (s: string) => <StatusBadge status={s} /> },
            {
              title: '发起时间',
              dataIndex: 'created_at',
              width: 150,
              render: (v: string) => <span className="num">{fmtTime(v)}</span>,
            },
          ]}
        />
      </Card>
    </div>
  )
}

function TrendChart({ trend }: { trend: Stats['trend_30d'] }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current === null) return
    const chart = echarts.init(ref.current)
    chart.setOption({
      grid: { left: 56, right: 24, top: 24, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const p = (params as { name: string; data: number; dataIndex: number }[])[0]
          const t = trend[p.dataIndex]
          return `${p.name}<br/>通过率 ${p.data}%<br/>当日 Run 数 ${t.runs}`
        },
      },
      xAxis: {
        type: 'category',
        data: trend.map((t) => t.date.slice(5)),
        boundaryGap: false,
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { formatter: '{value}%' },
      },
      series: [
        {
          type: 'line',
          data: trend.map((t) => +(t.pass_rate * 100).toFixed(1)),
          smooth: true,
          symbolSize: 6,
          lineStyle: { color: '#1677ff' },
          itemStyle: { color: '#1677ff' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(22,119,255,0.18)' },
              { offset: 1, color: 'rgba(22,119,255,0.02)' },
            ]),
          },
        },
      ],
    })
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
    }
  }, [trend])

  return <div ref={ref} style={{ height: 280 }} />
}
