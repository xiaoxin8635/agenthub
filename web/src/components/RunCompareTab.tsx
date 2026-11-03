// Run 版本对比 Tab（UI-405）：选另一同版本 Run → 指标差值表（涨绿↑跌红↓）
// + 回归/修复 case 两列表（回归默认展开对比侧输出）+ 一键回灌
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Collapse, Empty, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { RedoOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { CompareResult, RunDetail, RunSummary } from '../api/types'
import JsonTree from './JsonTree'
import FeedbackModal from './FeedbackModal'
import { fmtPct, fmtTime } from '../utils/format'

type DiffRow = {
  name: string
  base: number | null
  compare: number | null
  delta: number | null
  extra?: string
}

function DeltaCell({ delta }: { delta: number | null }) {
  if (delta == null) return <span style={{ color: '#bfbfbf' }}>—</span>
  if (delta === 0)
    return (
      <span className="num" style={{ color: '#8c8c8c' }}>
        0
      </span>
    )
  const up = delta > 0
  return (
    <span className="num" style={{ color: up ? '#52c41a' : '#ff4d4f' }}>
      {up ? '↑ +' : '↓ '}
      {(delta * 100).toFixed(1)}pp
    </span>
  )
}

export default function RunCompareTab({ run }: { run: RunDetail }) {
  const [candidates, setCandidates] = useState<RunSummary[]>([])
  const [otherId, setOtherId] = useState<string>()
  const [cmp, setCmp] = useState<CompareResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  const other = candidates.find((c) => c.id === otherId)

  // 候选：同数据集版本、非自身（优先已完成的 Run 才有可比 summary）
  useEffect(() => {
    api
      .runs({ limit: 100 })
      .then((r) => {
        setCandidates(
          r.items.filter((x) => x.dataset_version_id === run.dataset_version_id && x.id !== run.id),
        )
      })
      .catch(() => {})
  }, [run.id, run.dataset_version_id])

  useEffect(() => {
    if (!otherId) {
      setCmp(null)
      return
    }
    setLoading(true)
    api
      .compareRuns(run.id, otherId)
      .then(setCmp)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [run.id, otherId])

  const diffRows: DiffRow[] = useMemo(() => {
    if (!cmp) return []
    const rows: DiffRow[] = [
      {
        name: '加权总分 weighted_total',
        base: cmp.weighted_total.base,
        compare: cmp.weighted_total.compare,
        delta: cmp.weighted_total.delta,
      },
    ]
    for (const [type, d] of Object.entries(cmp.metric_diff)) {
      rows.push({ name: type, base: d.base, compare: d.compare, delta: d.delta })
    }
    return rows
  }, [cmp])

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ width: 380 }}
          placeholder="选择同版本的另一个 Run 进行对比"
          value={otherId}
          onChange={setOtherId}
          options={candidates.map((c) => ({
            value: c.id,
            label: `${c.target} · ${c.agent_version || '—'} · ${fmtTime(c.created_at)} · 通过率 ${fmtPct(c.pass_rate, 0)}`,
          }))}
        />
        {cmp && (
          <Button
            type="primary"
            danger
            icon={<RedoOutlined />}
            onClick={() => setFeedbackOpen(true)}
          >
            回灌全部失败 case（回归 {cmp.regressions.length} + 持续失败 {cmp.both_failed}）
          </Button>
        )}
      </Space>

      {!otherId ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            candidates.length === 0
              ? '没有可对比的 Run（需同一数据集版本的另一次评测）'
              : '请选择要对比的 Run'
          }
          style={{ padding: '48px 0' }}
        />
      ) : (
        <div style={{ opacity: loading ? 0.6 : 1 }}>
          {/* 指标差值表 */}
          <Card title="指标差值" size="small" style={{ marginBottom: 16 }}>
            <Table<DiffRow>
              rowKey="name"
              size="small"
              loading={loading}
              dataSource={diffRows}
              pagination={false}
              columns={[
                { title: '指标', dataIndex: 'name' },
                {
                  title: `基线（本 Run）`,
                  dataIndex: 'base',
                  width: 140,
                  render: (v: number | null) => <span className="num">{fmtPct(v)}</span>,
                },
                {
                  title: `对比`,
                  dataIndex: 'compare',
                  width: 140,
                  render: (v: number | null) => <span className="num">{fmtPct(v)}</span>,
                },
                { title: '差值', dataIndex: 'delta', width: 120, render: (d: number | null) => <DeltaCell delta={d} /> },
              ]}
              footer={() =>
                cmp && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    共同 case {cmp.common_items} 条 · 双通过 {cmp.both_passed} · 双失败 {cmp.both_failed} ·
                    <span style={{ color: '#ff4d4f' }}> 回归 {cmp.regressions.length}</span> ·
                    <span style={{ color: '#52c41a' }}> 修复 {cmp.fixed.length}</span>
                  </Typography.Text>
                )
              }
            />
          </Card>

          {/* 回归 case（默认全部展开，展示对比侧输出） */}
          <Card title={`回归 case（由过转败，${cmp?.regressions.length ?? 0} 条）`} size="small" style={{ marginBottom: 16 }}>
            {cmp && cmp.regressions.length > 0 ? (
              <Collapse
                defaultActiveKey={cmp.regressions.map((r) => r.item_id)}
                items={cmp.regressions.map((r) => ({
                  key: r.item_id,
                  label: (
                    <Space wrap>
                      <Typography.Text className="num">{r.item_id}</Typography.Text>
                      {Object.entries(r.base_scores).map(([mt, bs]) => {
                        const cs = r.compare_scores[mt]
                        const worse = cs && bs && (cs.passed === false || (cs.score != null && bs.score != null && cs.score < bs.score))
                        return (
                          <Tooltip key={mt} title={`${mt}：${fmtPct(bs?.score)} → ${fmtPct(cs?.score)}`}>
                            <Tag color={worse ? 'red' : 'default'} style={{ fontSize: 12 }}>
                              {mt} {fmtPct(bs?.score, 0)} → {fmtPct(cs?.score, 0)}
                            </Tag>
                          </Tooltip>
                        )
                      })}
                    </Space>
                  ),
                  children: (
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>对比侧 Agent 输出</div>
                      <JsonTree data={r.compare_output} />
                    </div>
                  ),
                }))}
              />
            ) : (
              <Alert type="success" showIcon message="没有回归 case" />
            )}
          </Card>

          {/* 修复 case */}
          <Card title={`修复 case（由败转过，${cmp?.fixed.length ?? 0} 条）`} size="small">
            {cmp && cmp.fixed.length > 0 ? (
              <Space wrap>
                {cmp.fixed.map((f) => (
                  <Tag key={f.item_id} color="green" className="num">
                    {f.item_id}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Alert type="info" showIcon message="没有修复 case" />
            )}
          </Card>
        </div>
      )}

      {/* 回灌目标为对比 Run（其全部失败 case = 回归 + 持续失败） */}
      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        runId={otherId ?? ''}
        runLabel={other ? `${other.target} · ${other.agent_version || '—'}` : undefined}
      />
    </div>
  )
}
