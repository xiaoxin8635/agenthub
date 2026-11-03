// 圈选资产向导（UI-304）：筛选资产 → 勾选 → 确认转入草稿 → 结果报告
import { useCallback, useEffect, useState } from 'react'
import type { Key } from 'react'
import {
  Alert,
  Button,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { api } from '../api/client'
import type { Asset, DatasetBrief, FromAssetsResult } from '../api/types'
import { SCENE_META, SourceTag, TypeTag } from './labels'

const TYPE_OPTIONS = [
  { value: 'dialog', label: '对话' },
  { value: 'trace', label: '轨迹' },
  { value: 'tool_log', label: '工具日志' },
  { value: 'doc', label: '文档' },
  { value: 'custom', label: '自定义' },
]

const SOURCE_OPTIONS = [
  { value: 'manual', label: '手工创建' },
  { value: 'trace_import', label: 'Trace 导入' },
  { value: 'badcase_feedback', label: 'Badcase 回灌' },
]

const PAGE_SIZE = 10

interface AssetFilters {
  type?: string
  source?: string
  tag?: string
  q?: string
  offset: number
}

export default function SelectAssetsWizard({
  open,
  dataset,
  includedAssetIds,
  onClose,
  onDone,
}: {
  open: boolean
  dataset: DatasetBrief
  /** 已存在于该数据集的资产 ID（重复圈选会被去重跳过，这里直接禁选） */
  includedAssetIds: Set<string>
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState(0)
  const [filters, setFilters] = useState<AssetFilters>({ offset: 0 })
  const [qInput, setQInput] = useState('')
  const [items, setItems] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Key[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FromAssetsResult | null>(null)

  const load = useCallback(async (f: AssetFilters) => {
    setLoading(true)
    try {
      const r = await api.assets({ ...f, limit: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
    } catch {
      // 失败保留旧数据
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setStep(0)
      setSelected([])
      setTags([])
      setResult(null)
      setQInput('')
      setFilters({ offset: 0 })
    }
  }, [open])

  useEffect(() => {
    if (open && step === 0) void load(filters)
  }, [open, step, filters, load])

  // 关键词防抖 300ms（与 UI-201 一致）
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === qInput ? f : { ...f, q: qInput, offset: 0 }))
    }, 300)
    return () => clearTimeout(t)
  }, [qInput])

  const patch = (p: Partial<AssetFilters>) => setFilters((f) => ({ ...f, ...p, offset: 0 }))
  const sceneMeta = SCENE_META[dataset.scene]

  const submit = async () => {
    setBusy(true)
    try {
      setResult(await api.addFromAssets(dataset.id, { asset_ids: selected.map(String), tags }))
      setStep(2)
    } catch {
      // 错误已 toast
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      width={920}
      title={`圈选资产 → ${dataset.name}`}
      onCancel={step === 2 ? onDone : onClose}
      footer={
        step === 0 ? (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" disabled={selected.length === 0} onClick={() => setStep(1)}>
              下一步（已选 {selected.length} 条）
            </Button>
          </Space>
        ) : step === 1 ? (
          <Space>
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Button type="primary" loading={busy} onClick={() => void submit()}>
              确认转入草稿
            </Button>
          </Space>
        ) : (
          <Button type="primary" onClick={onDone}>
            完成
          </Button>
        )
      }
    >
      <Steps
        size="small"
        current={step}
        style={{ margin: '8px 0 16px' }}
        items={[{ title: '筛选并勾选' }, { title: '确认转入' }, { title: '结果' }]}
      />

      {step === 0 && (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            <Select
              placeholder="类型"
              allowClear
              style={{ width: 120 }}
              options={TYPE_OPTIONS}
              value={filters.type}
              onChange={(v) => patch({ type: v })}
            />
            <Select
              placeholder="来源"
              allowClear
              style={{ width: 140 }}
              options={SOURCE_OPTIONS}
              value={filters.source}
              onChange={(v) => patch({ source: v })}
            />
            <Input
              placeholder="按标签筛选"
              allowClear
              style={{ width: 140 }}
              value={filters.tag}
              onChange={(e) => patch({ tag: e.target.value || undefined })}
            />
            <Input.Search
              placeholder="搜索内容关键词"
              allowClear
              style={{ width: 220 }}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </Space>
          <Table<Asset>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={items}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: setSelected,
              getCheckboxProps: (a) => ({ disabled: includedAssetIds.has(a.id) }),
            }}
            pagination={{
              current: filters.offset / PAGE_SIZE + 1,
              pageSize: PAGE_SIZE,
              total,
              showSizeChanger: false,
              showTotal: (t) => `共 ${t} 条`,
              onChange: (page) => setFilters((f) => ({ ...f, offset: (page - 1) * PAGE_SIZE })),
            }}
            columns={[
              { title: '类型', dataIndex: 'type', width: 90, render: (t: string) => <TypeTag type={t} /> },
              { title: '来源', dataIndex: 'source', width: 120, render: (s: string) => <SourceTag source={s} /> },
              {
                title: '内容摘要',
                dataIndex: 'content',
                render: (_, a) => {
                  const full = JSON.stringify(a.content, null, 2)
                  return (
                    <Tooltip
                      title={<pre style={{ maxWidth: 440, maxHeight: 320, overflow: 'auto' }}>{full}</pre>}
                    >
                      <Typography.Text ellipsis style={{ maxWidth: 380 }}>
                        {JSON.stringify(a.content)}
                      </Typography.Text>
                    </Tooltip>
                  )
                },
              },
              {
                title: '状态',
                key: 'state',
                width: 110,
                render: (_, a) =>
                  includedAssetIds.has(a.id) ? (
                    <Tag color="default">已在本数据集</Tag>
                  ) : (
                    <Tag color="green">可圈选</Tag>
                  ),
              },
            ]}
          />
        </>
      )}

      {step === 1 && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert
            type="info"
            message={`将把 ${selected.length} 条资产按「${sceneMeta?.label ?? dataset.scene}」场景映射为草稿 item`}
            description={`映射规则：${sceneMeta?.schema ?? '—'}。无法映射或校验不通过的资产会自动跳过，并在下一步结果中报告原因。`}
          />
          <div>
            <div style={{ marginBottom: 4 }}>附加标签（可选，会与资产自身标签合并）</div>
            <Select
              mode="tags"
              tokenSeparators={[',']}
              value={tags}
              onChange={setTags}
              placeholder="回车添加，如 冒烟集"
              style={{ width: '100%' }}
              open={false}
            />
          </div>
          <Alert type="warning" message="转入的是「草稿」，需在数据集详情页发布版本后才会进入不可变快照。" />
        </Space>
      )}

      {step === 2 && result && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space size={32}>
            <Statistic title="圈选资产" value={result.selected} />
            <Statistic title="转入草稿" value={result.added} valueStyle={{ color: '#52c41a' }} />
            <Statistic
              title="无法映射/非法"
              value={result.skipped_invalid}
              valueStyle={{ color: result.skipped_invalid ? '#faad14' : undefined }}
            />
            <Statistic title="重复跳过" value={result.skipped_dup} />
          </Space>
          {result.errors?.length > 0 && (
            <Alert
              type="warning"
              message="部分条目被跳过"
              description={
                <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              }
            />
          )}
          {result.added > 0 && (
            <Alert type="success" message="草稿已写入，可在「数据管理」Tab 中查看并发布版本。" />
          )}
        </Space>
      )}
    </Modal>
  )
}
