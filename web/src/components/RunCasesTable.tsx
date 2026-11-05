// Run 逐 case 结果表（UI-404）：输入摘要 / Agent 输出（截断+悬浮全文）/ 逐指标分数（红绿点+分值，hover detail）
// / passed 徽标 / error；工具栏 = 仅看失败、按指标筛选、搜索；行点击展开完整输入/输出/轨迹 JSON
import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { RedoOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { DatasetItem, EvalResultItem } from '../api/types'
import JsonTree from './JsonTree'
import { summarizeInput } from './DatasetItemsTable'
import { fmtPct } from '../utils/format'

function ScoreChip({ s }: { s: EvalResultItem['scores'][string] }) {
  // N/A（score 与 passed 均 null）灰「—」+ tooltip 无法评估
  if (s.score == null && s.passed == null) {
    return (
      <Tooltip title={`无法评估${s.detail ? `：${s.detail}` : ''}`}>
        <span style={{ color: '#bfbfbf' }}>—</span>
      </Tooltip>
    )
  }
  const color = s.passed === true ? '#52c41a' : s.passed === false ? '#ff4d4f' : '#bfbfbf'
  return (
    <Tooltip title={`${s.detail || '（无评分说明）'} · ${s.passed == null ? 'N/A' : s.passed ? '通过' : '未过'}`}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span className="dot" style={{ background: color }} />
        <span className="num" style={{ color }}>{fmtPct(s.score)}</span>
      </span>
    </Tooltip>
  )
}

function outputBrief(r: EvalResultItem): string {
  const o = r.output as Record<string, unknown>
  if (typeof o.answer === 'string') return o.answer
  if (Object.keys(o).length === 0) return r.error || '（空输出）'
  return JSON.stringify(o)
}

export default function RunCasesTable({
  runId,
  scene,
  metricTypes,
  itemsMap,
  onFeedback,
  feedbackVisible,
}: {
  runId: string
  /** 数据集场景，用于输入摘要 */
  scene: string
  /** 指标类型列表（来自指标组合），决定逐指标列 */
  metricTypes: string[]
  itemsMap: Record<string, DatasetItem>
  onFeedback: () => void
  feedbackVisible: boolean
}) {
  const [results, setResults] = useState<EvalResultItem[]>([])
  const [loading, setLoading] = useState(true)
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [metricFilter, setMetricFilter] = useState<string>()
  const [q, setQ] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .runResults(runId, { passed: onlyFailed ? false : undefined, limit: 500 })
      .then((r) => {
        if (!cancelled) setResults(r.items)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [runId, onlyFailed])

  const rows = useMemo(() => {
    return results.filter((r) => {
      if (metricFilter) {
        const s = r.scores[metricFilter]
        if (!s || s.passed !== false) return false // 仅看该指标未通过的 case
      }
      if (q) {
        const it = itemsMap[r.item_id]
        const hay = [
          it ? summarizeInput(scene, it.input) : '',
          JSON.stringify(r.output),
          r.item_id,
          r.error,
        ]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q.toLowerCase())) return false
      }
      return true
    })
  }, [results, metricFilter, q, itemsMap, scene])

  const columns: ColumnsType<EvalResultItem> = [
    {
      title: '输入摘要',
      width: 220,
      render: (_, r) => {
        const it = itemsMap[r.item_id]
        return (
          <Tooltip title={it ? JSON.stringify(it.input, null, 2) : r.item_id}>
            <Typography.Text ellipsis style={{ maxWidth: 200 }}>
              {it ? summarizeInput(scene, it.input) || r.item_id : r.item_id}
            </Typography.Text>
          </Tooltip>
        )
      },
    },
    {
      title: 'Agent 输出',
      width: 260,
      render: (_, r) => (
        <Tooltip
          title={<div style={{ maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{outputBrief(r)}</div>}
        >
          <Typography.Text ellipsis style={{ maxWidth: 240 }}>
            {outputBrief(r)}
          </Typography.Text>
        </Tooltip>
      ),
    },
    ...metricTypes.map((mt) => ({
      title: <span style={{ fontSize: 12 }}>{mt}</span>,
      width: 110,
      render: (_: unknown, r: EvalResultItem) => {
        const s = r.scores[mt]
        return s ? <ScoreChip s={s} /> : <span style={{ color: '#bfbfbf' }}>—</span>
      },
    })),
    {
      title: '结果',
      dataIndex: 'passed',
      width: 80,
      render: (p: boolean | null) =>
        p == null ? (
          <span style={{ color: '#bfbfbf' }}>—</span>
        ) : p ? (
          <Tag color="success">通过</Tag>
        ) : (
          <Tag color="error">失败</Tag>
        ),
    },
    {
      title: '错误',
      dataIndex: 'error',
      width: 160,
      render: (e: string) =>
        e ? (
          <Tooltip title={e}>
            <Typography.Text type="danger" ellipsis style={{ maxWidth: 140 }}>
              {e}
            </Typography.Text>
          </Tooltip>
        ) : (
          <span style={{ color: '#bfbfbf' }}>—</span>
        ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Checkbox checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)}>
          仅看失败
        </Checkbox>
        <Select
          allowClear
          placeholder="按指标筛选（未通过）"
          style={{ width: 190 }}
          value={metricFilter}
          onChange={setMetricFilter}
          options={metricTypes.map((m) => ({ value: m, label: m }))}
        />
        <Input.Search
          placeholder="搜索输入 / 输出 / item_id"
          style={{ width: 240 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          allowClear
        />
        {feedbackVisible && (
          <Button danger icon={<RedoOutlined />} onClick={onFeedback} style={{ marginLeft: 'auto' }}>
            回灌失败 case
          </Button>
        )}
      </Space>

      <Table<EvalResultItem>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        // 评测 case 可达数百上千条，虚拟滚动避免全量 DOM 渲染（UI-N2）；virtual 模式 scroll.x 必须为数字
        virtual
        scroll={{ y: 560 }}
        expandable={{
          expandRowByClick: true,
          expandedRowRender: (r) => {
            const it = itemsMap[r.item_id]
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>数据集 Item（输入 / 期望 / 标签）</div>
                  {it ? (
                    <JsonTree data={{ id: it.id, input: it.input, expected: it.expected, context: it.context, tags: it.tags }} />
                  ) : (
                    <span style={{ color: '#8c8c8c' }}>{r.item_id}（快照 item 未找到）</span>
                  )}
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Agent 输出</div>
                  <JsonTree data={r.output} />
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>执行轨迹</div>
                  {Object.keys(r.trajectory).length > 0 ? (
                    <JsonTree data={r.trajectory} />
                  ) : (
                    <span style={{ color: '#8c8c8c' }}>（无轨迹）</span>
                  )}
                </div>
              </div>
            )
          },
        }}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (t) => `共 ${t} 条`, hideOnSinglePage: true }}
        locale={{ emptyText: onlyFailed ? '没有失败 case' : '暂无结果' }}
      />
    </div>
  )
}
