// 数据资产页（UI-200）：列表筛选 / 导入向导 / 详情抽屉 / 批量加入数据集 / 删除确认
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  AutoComplete,
  Button,
  Divider,
  Drawer,
  Descriptions,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { DeleteOutlined, ReloadOutlined, RobotOutlined, UploadOutlined } from '@ant-design/icons'
import type { Asset } from '../api/types'
import { api } from '../api/client'
import { fmtTime } from '../utils/format'
import { SourceTag, TypeTag } from '../components/labels'
import JsonTree from '../components/JsonTree'
import ImportAssetsModal from '../components/ImportAssetsModal'
import GenerateEvalsetModal from '../components/GenerateEvalsetModal'
import BatchAddToDatasetModal from '../components/BatchAddToDatasetModal'

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
  { value: 'ai_generated', label: 'AI 生成' },
]

const PAGE_SIZE = 20

interface Filters {
  type?: string
  source?: string
  source_name?: string
  tag?: string
  q?: string
  offset: number
}

export default function Assets() {
  const [items, setItems] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [filters, setFilters] = useState<Filters>({ offset: 0 })
  const [qInput, setQInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [srcText, setSrcText] = useState('') // 来源输入框文本（选中/回车/失焦才应用为筛选）

  const [importOpen, setImportOpen] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [detail, setDetail] = useState<Asset | null>(null)
  const [delTarget, setDelTarget] = useState<Asset | null>(null)
  const [delInput, setDelInput] = useState('')

  // 全局搜索跳转：/assets?asset=<id> → 自动打开详情抽屉
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const assetId = searchParams.get('asset')
    if (!assetId) return
    setSearchParams({}, { replace: true })
    api.asset(assetId).then(setDetail).catch(() => {}) // 错误已统一 toast
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(
    async (f: Filters) => {
      setLoading(true)
      try {
        const r = await api.assets({ ...f, limit: PAGE_SIZE })
        setItems(r.items)
        setTotal(r.total)
        setSelectedKeys([])
      } catch {
        // UI-N3：失败保留旧数据，仅 toast
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void load(filters)
  }, [filters, load])

  // 已应用的来源筛选变化（含外部跳转）时同步输入框文本
  useEffect(() => {
    setSrcText(filters.source ?? '')
  }, [filters.source])

  // 关键词防抖 300ms（UI-201）
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === qInput ? f : { ...f, q: qInput, offset: 0 }))
    }, 300)
    return () => clearTimeout(t)
  }, [qInput])

  const patch = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p, offset: 0 }))

  const openDetail = async (a: Asset) => {
    setDetail(a)
    try {
      setDetail(await api.asset(a.id))
    } catch {
      // 保留行数据展示
    }
  }

  const saveTags = async (tags: string[]) => {
    if (!detail) return
    try {
      const updated = await api.patchAsset(detail.id, { tags })
      setDetail(updated)
      void load(filters)
      message.success('标签已更新')
    } catch {
      // 错误已 toast
    }
  }

  const doDelete = async () => {
    if (!delTarget) return
    try {
      await api.deleteAsset(delTarget.id)
      message.success('资产已删除')
      setDelTarget(null)
      setDelInput('')
      if (detail?.id === delTarget.id) setDetail(null)
      void load(filters)
    } catch {
      // 错误已 toast
    }
  }

  const doBatchDelete = async () => {
    if (selectedKeys.length === 0) return
    try {
      const r = await api.deleteAssetsBatch(selectedKeys.map(String))
      message.success(`已删除 ${r.deleted.length} 条资产`)
      setSelectedKeys([])
      void load(filters)
    } catch {
      // 错误已 toast
    }
  }

  // 跨页全选：按当前筛选条件拉全量 id 填入勾选框
  const selectAllFiltered = async () => {
    try {
      const r = await api.assets({ ...filters, limit: 1000 })
      setSelectedKeys(r.items.map((i) => i.id))
      if (r.total > 1000) message.info(`共 ${r.total} 条，已勾选前 1000 条`)
    } catch {
      // 错误已 toast
    }
  }

  return (
    <div>
      {/* UI-201 筛选器置顶 */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          placeholder="类型"
          allowClear
          style={{ width: 130 }}
          options={TYPE_OPTIONS}
          value={filters.type}
          onChange={(v) => patch({ type: v })}
        />
        <AutoComplete
          placeholder="来源（可输入/模糊）"
          allowClear
          style={{ width: 170 }}
          options={SOURCE_OPTIONS}
          value={srcText}
          onChange={(v) => {
            setSrcText(v)
            if (v === '') patch({ source: undefined }) // 清空立即生效
          }}
          onSelect={(v: string) => {
            setSrcText(v)
            patch({ source: v })
          }}
          onBlur={() => {
            // 自由输入在失焦时生效（与已应用值不同才触发）
            if ((srcText || '') !== (filters.source ?? '')) patch({ source: srcText || undefined })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (srcText || '') !== (filters.source ?? '')) patch({ source: srcText || undefined })
          }}
          filterOption={(input, option) => {
            // 模糊：值或中文标签任一包含即命中
            const k = input.toLowerCase()
            return (
              String(option?.value ?? '').toLowerCase().includes(k) ||
              String(option?.label ?? '').toLowerCase().includes(k)
            )
          }}
        />
        {filters.source === 'ai_generated' && (
          <Input
            placeholder="按来源名筛选"
            allowClear
            style={{ width: 170 }}
            value={filters.source_name}
            onChange={(e) => patch({ source_name: e.target.value || undefined })}
          />
        )}
        <Input
          placeholder="按标签筛选"
          allowClear
          style={{ width: 150 }}
          value={filters.tag}
          onChange={(e) => patch({ tag: e.target.value || undefined })}
        />
        <Input.Search
          placeholder="搜索内容关键词"
          allowClear
          style={{ width: 240 }}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void load(filters)} />
        <div style={{ flex: 1 }} />
        <Button icon={<RobotOutlined style={{ color: '#722ed1' }} />} onClick={() => setGenOpen(true)}>
          AI 生成评测集
        </Button>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
          导入 JSONL
        </Button>
      </Space>

      {/* UI-204 批量操作栏 */}
      {selectedKeys.length > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message={`已勾选 ${selectedKeys.length} 条资产`}
          action={
            <Space>
              {total > selectedKeys.length && (
                <Button size="small" onClick={() => void selectAllFiltered()}>
                  全选所有 {total} 条
                </Button>
              )}
              <Button type="primary" size="small" onClick={() => setBatchOpen(true)}>
                加入数据集…
              </Button>
              <Popconfirm
                title={`确认删除选中的 ${selectedKeys.length} 条资产？`}
                description="删除不可恢复；已转入数据集的条目会保留但失去来源关联。"
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => void doBatchDelete()}
              >
                <Button danger size="small" icon={<DeleteOutlined />}>
                  删除选中
                </Button>
              </Popconfirm>
              <Button size="small" onClick={() => setSelectedKeys([])}>
                清除
              </Button>
            </Space>
          }
        />
      )}

      <Table<Asset>
        rowKey="id"
        loading={loading}
        dataSource={items}
        locale={{
          emptyText:
            !filters.type && !filters.source && !filters.source_name && !filters.tag && !filters.q ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有数据资产" style={{ padding: '32px 0' }}>
                <Space direction="vertical" size={8}>
                  <Button type="primary" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
                    导入第一批 JSONL
                  </Button>
                  <Typography.Text type="secondary">
                    导入后可在「评测数据集」圈选生成评测集并发布版本
                  </Typography.Text>
                </Space>
              </Empty>
            ) : (
              '没有符合筛选条件的资产'
            ),
        }}
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
        onRow={(a) => ({
          style: { cursor: 'pointer' },
          onClick: (e) => {
            // 复选框列与操作按钮/链接点击不触发行打开（避免误开抽屉）
            if ((e.target as HTMLElement).closest('.ant-table-selection-column, button, a')) return
            void openDetail(a)
          },
        })}
        pagination={{
          current: filters.offset / PAGE_SIZE + 1,
          pageSize: PAGE_SIZE,
          total,
          showTotal: (t) => `共 ${t} 条`,
          showSizeChanger: false,
          onChange: (page) => setFilters((f) => ({ ...f, offset: (page - 1) * PAGE_SIZE })),
        }}
        columns={[
          { title: '类型', dataIndex: 'type', width: 100, render: (t: string) => <TypeTag type={t} /> },
          {
            title: '来源',
            dataIndex: 'source',
            width: 210,
            render: (_, a) => {
              const sn = typeof a.meta?.source_name === 'string' ? (a.meta.source_name as string) : ''
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <SourceTag source={a.source} />
                  {sn && (
                    <Typography.Text type="secondary" ellipsis={{ tooltip: sn }} style={{ maxWidth: 110 }}>
                      · {sn}
                    </Typography.Text>
                  )}
                </div>
              )
            },
          },
          {
            title: '内容摘要',
            dataIndex: 'content',
            render: (_, a) => {
              const full = JSON.stringify(a.content, null, 2)
              const brief = JSON.stringify(a.content)
              return (
                <Typography.Text
                  ellipsis={{ tooltip: <pre style={{ maxWidth: 480, maxHeight: 360, overflow: 'auto' }}>{full}</pre> }}
                  style={{ maxWidth: 360 }}
                >
                  {brief}
                </Typography.Text>
              )
            },
          },
          {
            title: '标签',
            dataIndex: 'tags',
            width: 220,
            render: (tags: string[]) =>
              tags.length === 0 ? (
                <span style={{ color: '#bfbfbf' }}>—</span>
              ) : (
                <>
                  {tags.slice(0, 3).map((t) => (
                    <Tag key={t} color="blue">
                      {t}
                    </Tag>
                  ))}
                  {tags.length > 3 && <Tag>+{tags.length - 3}</Tag>}
                </>
              ),
          },
          {
            title: '创建时间',
            dataIndex: 'created_at',
            width: 150,
            render: (v: string) => <span className="num">{fmtTime(v)}</span>,
          },
          {
            title: '操作',
            key: 'actions',
            width: 130,
            render: (_, a) => (
              <Space>
                <Button type="link" size="small" onClick={() => void openDetail(a)}>
                  详情
                </Button>
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setDelTarget(a)
                    setDelInput('')
                  }}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      {/* UI-202 导入向导 */}
      <ImportAssetsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load(filters)}
      />
      <GenerateEvalsetModal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        onDone={() => void load(filters)}
      />

      {/* UI-204 批量加入数据集 */}
      <BatchAddToDatasetModal
        open={batchOpen}
        assetIds={selectedKeys.map(String)}
        onClose={() => setBatchOpen(false)}
        onDone={() => {
          setBatchOpen(false)
          setSelectedKeys([])
        }}
      />

      {/* UI-203 详情抽屉 */}
      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={560}
        title="资产详情"
        extra={
          detail && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => {
                setDelTarget(detail)
                setDelInput('')
              }}
            >
              删除
            </Button>
          )
        }
      >
        {detail && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="ID">
                <Typography.Text copyable className="num">
                  {detail.id}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="类型">
                <TypeTag type={detail.type} />
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                <SourceTag source={detail.source} />
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                <span className="num">{fmtTime(detail.created_at)}（UTC 数据，已本地化）</span>
              </Descriptions.Item>
              <Descriptions.Item label="标签（修改后自动保存）">
                <Select
                  mode="tags"
                  tokenSeparators={[',']}
                  value={detail.tags}
                  onChange={(v) => void saveTags(v)}
                  placeholder="添加标签"
                  style={{ width: '100%' }}
                  open={false}
                />
              </Descriptions.Item>
            </Descriptions>
            <Divider orientation="left" plain>
              content
            </Divider>
            <JsonTree data={detail.content} />
            {detail.meta && Object.keys(detail.meta).length > 0 && (
              <>
                <Divider orientation="left" plain>
                  meta
                </Divider>
                <JsonTree data={detail.meta} />
              </>
            )}
          </>
        )}
      </Drawer>

      {/* 删除确认：输入短 ID 防误删 */}
      <Modal
        open={delTarget !== null}
        title="删除资产"
        okText="删除"
        okType="danger"
        okButtonProps={{ disabled: delInput !== (delTarget?.id.slice(0, 8) ?? '') }}
        onCancel={() => setDelTarget(null)}
        onOk={() => void doDelete()}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert type="warning" message="删除后不可恢复，已生成的数据集草稿将保留但失去来源关联。" />
          <div>
            请输入 <Typography.Text code>{delTarget?.id.slice(0, 8)}</Typography.Text> 确认删除：
          </div>
          <Input
            className="num"
            value={delInput}
            onChange={(e) => setDelInput(e.target.value)}
            placeholder={delTarget?.id.slice(0, 8)}
          />
        </Space>
      </Modal>
    </div>
  )
}
