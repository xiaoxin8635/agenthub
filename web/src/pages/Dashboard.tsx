// 仪表盘（UI-100）：待办条 + KPI 行（hero 平均通过率 + 3 个 stat tile）+ 通过率趋势（折线 + Run 数活动条 + 数据表视图）+ 最近 Run
// 视觉遵循 dataviz 规范：单主色系列、2px 折线、hairline 实线网格、仅端点直接标注、图表/数据表双视图（tooltip 只增强不独占）
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Card, Col, Row, Segmented, Table } from 'antd'
import echarts from '../utils/echarts'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { RunSummary, Stats } from '../api/types'
import PassRate from '../components/PassRate'
import StatusBadge from '../components/StatusBadge'
import EmptyGuide from '../components/EmptyGuide'
import { HeroStat, StatTile, inkTokens } from '../components/statTiles'
import { fmtPct, fmtTime } from '../utils/format'
import { useCountUp } from '../utils/useCountUp'
import { useTheme } from '../theme'

/** 趋势主色：单系列（品牌蓝），亮/暗卡面对比度均 ≥3:1（手算 WCAG：4.10 / 4.49） */
const SERIES = '#1677ff'

/** 趋势日（前端补齐空白天后的形状） */
type TrendDay = { date: string; pass_rate: number | null; runs: number }

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [trendView, setTrendView] = useState<'chart' | 'table'>('chart')
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

  // 指标卡数字滚动（数据就绪后从 0 缓动到目标值）
  const nAssets = useCountUp(stats?.counts.assets ?? 0)
  const nDatasets = useCountUp(stats?.counts.datasets ?? 0)
  const nRuns = useCountUp(stats?.counts.runs ?? 0)

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

  // 补齐近 30 天（UTC，与后端一致）：后端只返回有已完成 Run 的日期，空白天 pass_rate=null、runs=0
  const days = useMemo<TrendDay[]>(() => {
    const map = new Map((stats?.trend_30d ?? []).map((d) => [d.date, d]))
    const now = new Date()
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const out: TrendDay[] = []
    for (let i = 29; i >= 0; i--) {
      const date = new Date(todayUtc - i * 86400000).toISOString().slice(0, 10)
      const hit = map.get(date)
      out.push({ date, pass_rate: hit ? hit.pass_rate : null, runs: hit ? hit.runs : 0 })
    }
    return out
  }, [stats])

  // 附注数据：近 7 天已完成 Run 数 / hero 基于的总完成数
  const runs7d = useMemo(() => days.slice(-7).reduce((n, d) => n + d.runs, 0), [days])
  const runs30d = useMemo(() => days.reduce((n, d) => n + d.runs, 0), [days])

  const isEmpty =
    stats != null &&
    stats.counts.assets === 0 &&
    stats.counts.datasets === 0 &&
    stats.counts.runs === 0

  if (isEmpty) return <EmptyGuide />

  return (
    <div>
      {/* UI-104 待办提示条（并排压低占高） */}
      {stats && (stats.draft_datasets > 0 || stats.unfeedback_runs > 0) && (
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          {stats.draft_datasets > 0 && (
            <Col xs={24} md={stats.unfeedback_runs > 0 ? 12 : 24}>
              <Alert
                type="info"
                showIcon
                message={
                  <Link to="/datasets">
                    有 {stats.draft_datasets} 个数据集存在未发布草稿，前往处理 →
                  </Link>
                }
              />
            </Col>
          )}
          {stats.unfeedback_runs > 0 && (
            <Col xs={24} md={stats.draft_datasets > 0 ? 12 : 24}>
              <Alert
                type="warning"
                showIcon
                message={
                  <Link to="/runs">
                    有 {stats.unfeedback_runs} 次评测的失败 case 未回灌，前往处理 →
                  </Link>
                }
              />
            </Col>
          )}
        </Row>
      )}

      {/* UI-101 KPI 行：hero 平均通过率打头，3 个 stat tile 可点击跳转对应页面 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <HeroStat
            label="平均通过率（近 30 天）"
            value={avgPassRate}
            digits={0}
            sub={avgPassRate == null ? '暂无已完成评测' : `基于 ${runs30d} 次已完成评测`}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatTile label="数据资产" value={Math.round(nAssets)} onClick={() => nav('/assets')} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatTile
            label="评测数据集"
            value={Math.round(nDatasets)}
            onClick={() => nav('/datasets')}
            sub={<>{stats?.counts.dataset_versions ?? 0} 个已发布版本</>}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatTile
            label="评测 Run"
            value={Math.round(nRuns)}
            onClick={() => nav('/runs')}
            sub={<>近 7 天完成 {runs7d} 次</>}
          />
        </Col>
      </Row>

      {/* UI-102 通过率趋势：图表（折线 + Run 数活动条）/ 数据表双视图 */}
      <Card
        title="通过率趋势（近 30 天）"
        style={{ marginTop: 16 }}
        loading={loading}
        extra={
          hasTrendCard(days) ? (
            <Segmented
              size="small"
              value={trendView}
              onChange={(v) => setTrendView(v as 'chart' | 'table')}
              options={[
                { label: '图表', value: 'chart' },
                { label: '数据表', value: 'table' },
              ]}
            />
          ) : undefined
        }
      >
        {!hasTrendCard(days) ? (
          <div style={{ color: '#8c8c8c', textAlign: 'center', padding: '48px 0' }}>
            暂无已完成的评测，发起首次评测后这里会显示每日通过率曲线
          </div>
        ) : trendView === 'chart' ? (
          <TrendChart days={days} />
        ) : (
          <Table<TrendDay>
            rowKey="date"
            size="small"
            dataSource={days}
            pagination={false}
            scroll={{ y: 300 }}
            columns={[
              { title: '日期', dataIndex: 'date' },
              {
                title: '通过率',
                dataIndex: 'pass_rate',
                align: 'right',
                width: 120,
                render: (v: number | null) => (
                  <span className="num">{v == null ? '—' : fmtPct(v)}</span>
                ),
              },
              {
                title: 'Run 数',
                dataIndex: 'runs',
                align: 'right',
                width: 100,
                render: (v: number) => <span className="num">{v}</span>,
              },
            ]}
          />
        )}
      </Card>

      {/* UI-103 最近评测 Run：整行点击进 Run 详情 */}
      <Card
        title="最近评测 Run"
        style={{ marginTop: 16 }}
        loading={loading}
        extra={<Link to="/runs">查看全部 →</Link>}
      >
        <Table<RunSummary>
          rowKey="id"
          size="small"
          dataSource={runs}
          pagination={false}
          onRow={(r) => ({ style: { cursor: 'pointer' }, onClick: () => nav(`/runs/${r.id}`) })}
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

/** 趋势区是否有数据（存在任一已完成 Run 的日期） */
function hasTrendCard(days: TrendDay[]): boolean {
  return days.some((d) => d.pass_rate != null)
}

/** 通过率趋势：上方 2px 折线（10% 面积洗色 + 末端点 + 端点直标）+ 下方 Run 数活动条（上下文灰），
 *  两 grid 共享 crosshair；tooltip 内容由 days 直接构建（数值加粗为主、系列名次要、短线色键） */
function TrendChart({ days }: { days: TrendDay[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const { isDark } = useTheme()

  useEffect(() => {
    if (ref.current === null) return
    const chart = echarts.init(ref.current)
    const t = inkTokens(isDark)
    const labels = days.map((d) => d.date.slice(5))
    const prData = days.map((d) => (d.pass_rate == null ? null : +(d.pass_rate * 100).toFixed(1)))
    // selective labeling：只对最后一个可评点做末端直标 + 末端点（surface ring）
    let lastIdx = -1
    for (let i = days.length - 1; i >= 0; i--) {
      if (prData[i] != null) {
        lastIdx = i
        break
      }
    }
    const endDot = lastIdx >= 0 ? [[lastIdx, prData[lastIdx]]] : []

    chart.setOption({
      animationDuration: 600,
      animationDurationUpdate: 300,
      animationEasing: 'cubicOut',
      legend: {
        data: ['通过率', 'Run 数'],
        top: 0,
        left: 52,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { color: t.ink2, fontSize: 12 },
      },
      grid: [
        { left: 52, right: 64, top: 32, height: 168 },
        { left: 52, right: 64, top: 236, height: 36 },
      ],
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: t.cross, width: 1, type: 'solid' } },
      tooltip: {
        trigger: 'axis',
        backgroundColor: t.tooltipBg,
        borderColor: t.axis,
        borderWidth: 1,
        textStyle: { color: t.ink1, fontSize: 12 },
        formatter: (params: unknown) => {
          const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0
          const d = days[i]
          const key = (c: string) =>
            `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${c};vertical-align:middle;margin-right:6px"></span>`
          const pr =
            d.pass_rate == null
              ? `<span style="color:${t.ink3}">无已完成评测</span>`
              : `<b>${fmtPct(d.pass_rate)}</b>`
          return (
            `<div style="font-weight:600;margin-bottom:4px">${d.date}</div>` +
            `<div>${key(SERIES)}<span style="color:${t.ink2}">通过率</span>&nbsp;&nbsp;${pr}</div>` +
            `<div style="margin-top:2px">${key(t.barCtx)}<span style="color:${t.ink2}">Run 数</span>&nbsp;&nbsp;<b>${d.runs}</b></div>`
          )
        },
      },
      xAxis: [
        { type: 'category', gridIndex: 0, data: labels, show: false },
        {
          type: 'category',
          gridIndex: 1,
          data: labels,
          axisLine: { lineStyle: { color: t.axis } },
          axisTick: { show: false },
          axisLabel: { color: t.ink3, fontSize: 11 },
        },
      ],
      yAxis: [
        {
          type: 'value',
          gridIndex: 0,
          min: 0,
          max: 100,
          interval: 25,
          axisLabel: { formatter: '{value}%', color: t.ink3, fontSize: 11 },
          splitLine: { lineStyle: { color: t.grid, type: 'solid' } },
        },
        {
          type: 'value',
          gridIndex: 1,
          min: 0,
          max: Math.max(5, ...days.map((d) => d.runs)) * 1.25,
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '通过率',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: prData,
          connectNulls: true,
          showSymbol: false,
          symbolSize: 8,
          lineStyle: { width: 2, color: SERIES, cap: 'round', join: 'round' },
          itemStyle: { color: SERIES },
          areaStyle: { color: 'rgba(22,119,255,0.10)' },
          endLabel: {
            show: lastIdx >= 0,
            formatter: () => (lastIdx >= 0 ? `${prData[lastIdx]}%` : ''),
            color: t.ink2,
            fontSize: 12,
            distance: 8,
          },
          z: 3,
        },
        {
          // 末端点：≥8px 系列色圆点 + 2px 表面色 ring；不进 legend、不响应交互
          name: '末端',
          type: 'scatter',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: endDot,
          symbolSize: 8,
          silent: true,
          legendHoverLink: false,
          itemStyle: { color: SERIES, borderColor: t.surface, borderWidth: 2 },
          z: 4,
        },
        {
          name: 'Run 数',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: days.map((d) => d.runs),
          barWidth: 14,
          itemStyle: { color: t.barCtx, borderRadius: [4, 4, 0, 0] },
          emphasis: { itemStyle: { color: t.barHover } },
        },
      ],
    })
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
    }
  }, [days, isDark])

  return <div ref={ref} style={{ height: 300 }} />
}
