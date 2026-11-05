// 数据集 item 表格（UI-303 草稿/已发布区与 UI-306 快照预览共用）
// 列 = 场景感知的输入摘要 / 期望摘要 / 标签 / 来源资产；extraColumns 供草稿区追加操作列
import { Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { DatasetItem } from '../api/types'

/** 场景感知的输入摘要 */
export function summarizeInput(scene: string, input: Record<string, unknown>): string {
  switch (scene) {
    case 'qa':
    case 'rag':
      return String(input.question ?? '')
    case 'tool_call':
      return String(input.utterance ?? '')
    case 'multi_turn': {
      const turns = Array.isArray(input.turns) ? (input.turns as { content?: unknown }[]) : []
      const last = turns[turns.length - 1]
      return `[${turns.length} 轮] ${String(last?.content ?? '')}`
    }
    case 'trajectory':
      return String(input.task ?? '')
    default:
      return JSON.stringify(input)
  }
}

/** 场景感知的期望摘要 */
export function summarizeExpected(scene: string, expected: Record<string, unknown>): string {
  switch (scene) {
    case 'qa':
    case 'rag':
      return String(expected.answer ?? '')
    case 'multi_turn':
      return String(expected.final_answer ?? '')
    case 'tool_call':
      return `${String(expected.tool ?? '?')}(${JSON.stringify(expected.args ?? {})})`
    case 'trajectory': {
      const must = Array.isArray(expected.must_call_tools) ? (expected.must_call_tools as string[]) : []
      return `${String(expected.outcome ?? '')}${must.length ? ` · 必调 [${must.join(', ')}]` : ''}`
    }
    default:
      return JSON.stringify(expected)
  }
}

function Brief({ text }: { text: string }) {
  return (
    <Tooltip
      title={<div style={{ maxWidth: 440, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{text}</div>}
    >
      <Typography.Text ellipsis style={{ maxWidth: 360 }}>
        {text || '—'}
      </Typography.Text>
    </Tooltip>
  )
}

export default function DatasetItemsTable({
  scene,
  items,
  loading,
  extraColumns = [],
}: {
  scene: string
  items: DatasetItem[]
  loading?: boolean
  extraColumns?: ColumnsType<DatasetItem>
}) {
  const columns: ColumnsType<DatasetItem> = [
    { title: '输入', render: (_, it) => <Brief text={summarizeInput(scene, it.input)} /> },
    { title: '期望', render: (_, it) => <Brief text={summarizeExpected(scene, it.expected)} /> },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 190,
      render: (tags: string[]) =>
        tags.length === 0 ? (
          <span style={{ color: '#bfbfbf' }}>—</span>
        ) : (
          <>
            {tags.slice(0, 2).map((t) => (
              <Tag key={t} color="blue">
                {t}
              </Tag>
            ))}
            {tags.length > 2 && <Tag>+{tags.length - 2}</Tag>}
          </>
        ),
    },
    {
      title: '来源资产',
      dataIndex: 'source_asset_id',
      width: 130,
      render: (v: string | null) =>
        v ? (
          <Typography.Text className="num" copyable={{ text: v, tooltips: ['复制资产 ID', '已复制'] }}>
            {v.slice(0, 8)}
          </Typography.Text>
        ) : (
          <span style={{ color: '#bfbfbf' }}>直接录入</span>
        ),
    },
    ...extraColumns,
  ]

  return (
    <Table<DatasetItem>
      rowKey="id"
      size="small"
      loading={loading}
      dataSource={items}
      columns={columns}
      // 大数据集（500+ 条）时避免全量 DOM 渲染（UI-N2）；virtual 模式 scroll.x 必须为数字，长文本由 ellipsis+Tooltip 收敛
      virtual
      scroll={{ y: 520 }}
      pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (t) => `共 ${t} 条`, hideOnSinglePage: true }}
    />
  )
}
