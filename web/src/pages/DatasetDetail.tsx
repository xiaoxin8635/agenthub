// 数据集详情（UI-303/305/306/307）：三 Tab —— 数据管理 / 版本与快照 / badcase 回灌
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Key } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  SelectOutlined,
} from '@ant-design/icons'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Asset, DatasetBrief, DatasetItem, DatasetVersion } from '../api/types'
import DatasetItemsTable from '../components/DatasetItemsTable'
import DraftItemEditModal from '../components/DraftItemEditModal'
import PublishVersionModal from '../components/PublishVersionModal'
import SelectAssetsWizard from '../components/SelectAssetsWizard'
import { SCENE_META, SceneTag } from '../components/labels'
import { fmtTime } from '../utils/format'

function ContentBrief({ content }: { content: Record<string, unknown> }) {
  return (
    <Tooltip title={<pre style={{ maxWidth: 440, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(content, null, 2)}</pre>}>
      <Typography.Text ellipsis style={{ maxWidth: 380 }}>
        {JSON.stringify(content)}
      </Typography.Text>
    </Tooltip>
  )
}

export default function DatasetDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const [ds, setDs] = useState<DatasetBrief | null>(null)
  const [missing, setMissing] = useState(false)
  const [tab, setTab] = useState('data')

  const [drafts, setDrafts] = useState<DatasetItem[]>([])
  const [draftsLoading, setDraftsLoading] = useState(false)
  const [published, setPublished] = useState<DatasetItem[]>([])
  const [pubLoading, setPubLoading] = useState(false)
  const [versions, setVersions] = useState<DatasetVersion[] | null>(null)

  // 弹层状态
  const [selectOpen, setSelectOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [editItem, setEditItem] = useState<DatasetItem | null>(null)
  const [delItem, setDelItem] = useState<DatasetItem | null>(null)
  const [previewVer, setPreviewVer] = useState<DatasetVersion | null>(null)
  const [previewItems, setPreviewItems] = useState<DatasetItem[] | null>(null)
  const [delDsOpen, setDelDsOpen] = useState(false)
  const [delDsInput, setDelDsInput] = useState('')

  // badcase 回灌 Tab
  const [bcItems, setBcItems] = useState<Asset[] | null>(null)
  const [bcSelected, setBcSelected] = useState<Key[]>([])
  const [bcBusy, setBcBusy] = useState(false)

  // 已被本数据集收录的来源资产（草稿 + 已发布），用于禁选重复圈选
  const includedAssetIds = useMemo(
    () =>
      new Set(
        [...drafts, ...published].map((i) => i.source_asset_id).filter((v): v is string => v !== null),
      ),
    [drafts, published],
  )

  const loadDs = useCallback(async () => {
    try {
      setDs(await api.dataset(id))
    } catch {
      setMissing(true)
    }
  }, [id])

  const loadDrafts = useCallback(async () => {
    setDraftsLoading(true)
    try {
      setDrafts((await api.datasetItems(id, { draft: true, limit: 500 })).items)
    } catch {
      // 失败保留旧数据
    } finally {
      setDraftsLoading(false)
    }
  }, [id])

  const loadPublished = useCallback(async () => {
    if (!ds?.latest_version) {
      setPublished([])
      return
    }
    setPubLoading(true)
    try {
      setPublished((await api.datasetItems(id, { version: ds.latest_version, limit: 500 })).items)
    } catch {
      // 失败保留旧数据
    } finally {
      setPubLoading(false)
    }
  }, [id, ds?.latest_version])

  const loadVersions = useCallback(async () => {
    try {
      setVersions((await api.datasetVersions(id)).items)
    } catch {
      setVersions([])
    }
  }, [id])

  useEffect(() => {
    void loadDs()
    void loadDrafts()
    void loadVersions()
  }, [loadDs, loadDrafts, loadVersions])

  useEffect(() => {
    void loadPublished()
  }, [loadPublished])

  const loadBadcase = useCallback(async () => {
    setBcItems(null)
    try {
      setBcItems((await api.assets({ source: 'badcase_feedback', limit: 100 })).items)
    } catch {
      setBcItems([])
    }
  }, [])

  useEffect(() => {
    if (tab === 'badcase') void loadBadcase()
  }, [tab, loadBadcase])

  // ---------- 操作 ----------

  const doDeleteItem = async () => {
    if (!delItem) return
    try {
      await api.deleteDatasetItem(id, delItem.id)
      message.success('草稿已删除')
      setDelItem(null)
      void loadDrafts()
      void loadDs()
    } catch {
      // 错误已 toast
    }
  }

  const transferBadcase = async () => {
    if (bcSelected.length === 0) return
    setBcBusy(true)
    try {
      const r = await api.addFromAssets(id, { asset_ids: bcSelected.map(String) })
      message.success(`已转入草稿 ${r.added} 条（无法映射/重复跳过 ${r.skipped_invalid + r.skipped_dup} 条）`)
      setBcSelected([])
      void loadDrafts()
      void loadDs()
    } catch {
      // 错误已 toast
    } finally {
      setBcBusy(false)
    }
  }

  const openPreview = async (v: DatasetVersion) => {
    setPreviewVer(v)
    setPreviewItems(null)
    try {
      setPreviewItems((await api.datasetItems(id, { version: v.version, limit: 50 })).items)
    } catch {
      setPreviewItems([])
    }
  }

  const exportUrl = (version: number, format: string) =>
    `/api/v1/datasets/${ds?.name}/versions/${version}/export?format=${format}`

  const copyPull = async (version: number) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${exportUrl(version, 'jsonl')}`)
      message.success('JSONL 拉取地址已复制（GET 该地址即下载快照；CLI 亦可用 agenthub pull）')
    } catch {
      message.error('复制失败，请手动复制浏览器地址')
    }
  }

  const doDeleteDs = async () => {
    if (!ds) return
    try {
      await api.deleteDataset(ds.id)
      message.success('数据集已删除')
      navigate('/datasets')
    } catch {
      // 错误已 toast
    }
  }

  // ---------- 渲染 ----------

  if (missing) {
    return (
      <Card>
        <Empty description="数据集不存在或已被删除">
          <Button onClick={() => navigate('/datasets')}>返回列表</Button>
        </Empty>
      </Card>
    )
  }
  if (!ds) return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>

  const meta = SCENE_META[ds.scene]
  const publishDisabled = ds.draft_count === 0 && !ds.latest_version

  return (
    <div>
      {/* 头部概览 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <Space size={8} wrap>
              <Typography.Title level={4} style={{ margin: 0 }} className="num">
                {ds.name}
              </Typography.Title>
              <SceneTag scene={ds.scene} />
              {ds.latest_version ? <Tag color="blue">v{ds.latest_version}</Tag> : <Tag>未发布</Tag>}
            </Space>
            <div style={{ marginTop: 6, color: '#595959' }}>{ds.description || '暂无描述'}</div>
            <div style={{ marginTop: 6, fontSize: 12, color: '#8c8c8c' }}>
              场景 Schema：<code className="num">{meta?.schema}</code>
            </div>
          </div>
          <Space align="start" wrap>
            <Statistic title="已发布 item" value={ds.total_items} />
            <Statistic title="草稿" value={ds.draft_count} valueStyle={{ color: ds.draft_count ? '#fa8c16' : undefined }} />
            <Statistic title="版本" value={ds.latest_version ?? '—'} />
            <Button icon={<SelectOutlined />} onClick={() => setSelectOpen(true)}>
              圈选资产
            </Button>
            <Tooltip title={publishDisabled ? '请先添加草稿 item（圈选资产或 CLI 录入）' : ''}>
              <Button
                type="primary"
                icon={<CloudUploadOutlined />}
                disabled={publishDisabled}
                onClick={() => setPublishOpen(true)}
              >
                发布新版本
              </Button>
            </Tooltip>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => {
                setDelDsOpen(true)
                setDelDsInput('')
              }}
            >
              删除
            </Button>
          </Space>
        </div>
      </Card>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          // ---------- Tab1 数据管理（UI-303） ----------
          {
            key: 'data',
            label: `数据管理（草稿 ${ds.draft_count}）`,
            children: (
              <>
                <Card
                  size="small"
                  title={`草稿区 · ${drafts.length} 条（可编辑，发布后进入只读快照）`}
                  extra={
                    <Space>
                      <Button size="small" icon={<SelectOutlined />} onClick={() => setSelectOpen(true)}>
                        圈选资产转入
                      </Button>
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={() => {
                          void loadDrafts()
                          void loadDs()
                        }}
                      />
                    </Space>
                  }
                >
                  {drafts.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无草稿：圈选资产、CLI 录入或回灌转入">
                      <Button type="primary" icon={<SelectOutlined />} onClick={() => setSelectOpen(true)}>
                        圈选资产
                      </Button>
                    </Empty>
                  ) : (
                    <DatasetItemsTable
                      scene={ds.scene}
                      items={drafts}
                      loading={draftsLoading}
                      extraColumns={[
                        {
                          title: '操作',
                          key: 'ops',
                          width: 140,
                          render: (_, it) => (
                            <Space>
                              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditItem(it)}>
                                编辑
                              </Button>
                              <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => setDelItem(it)}>
                                删除
                              </Button>
                            </Space>
                          ),
                        },
                      ]}
                    />
                  )}
                </Card>

                <Card
                  size="small"
                  style={{ marginTop: 16 }}
                  title={ds.latest_version ? `已发布区 · v${ds.latest_version}（只读快照，${published.length} 条）` : '已发布区'}
                >
                  {ds.latest_version ? (
                    <DatasetItemsTable scene={ds.scene} items={published} loading={pubLoading} />
                  ) : (
                    <Typography.Text type="secondary">
                      尚无发布版本；草稿在「发布新版本」后进入只读快照并在历史版本中可查。
                    </Typography.Text>
                  )}
                </Card>
              </>
            ),
          },
          // ---------- Tab2 版本与快照（UI-306） ----------
          {
            key: 'versions',
            label: '版本与快照',
            children:
              versions === null ? (
                <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
              ) : versions.length === 0 ? (
                <Empty description="还没有版本：添加草稿后点「发布新版本」" />
              ) : (
                <Timeline
                  items={versions.map((v) => ({
                    color: 'blue',
                    children: (
                      <Card size="small">
                        <Space wrap size={8} style={{ marginBottom: 4 }}>
                          <Typography.Text strong className="num">
                            v{v.version}
                          </Typography.Text>
                          <Tag>{v.item_count} 条</Tag>
                          <Tag color="green">新增 {v.stats?.new ?? '—'}</Tag>
                          <Tag>保留 {v.stats?.carried ?? '—'}</Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            发布于 <span className="num">{fmtTime(v.created_at)}</span>
                          </Typography.Text>
                        </Space>
                        <div style={{ marginBottom: 8 }}>
                          {v.changelog || <Typography.Text type="secondary">无变更说明</Typography.Text>}
                        </div>
                        <Space wrap>
                          <Button size="small" onClick={() => void openPreview(v)}>
                            预览快照
                          </Button>
                          <Button size="small" href={exportUrl(v.version, 'jsonl')}>
                            导出 JSONL
                          </Button>
                          <Button size="small" href={exportUrl(v.version, 'yaml')}>
                            导出 YAML
                          </Button>
                          <Button size="small" href={exportUrl(v.version, 'hf')}>
                            导出 HF
                          </Button>
                          <Button size="small" icon={<CopyOutlined />} onClick={() => void copyPull(v.version)}>
                            复制拉取地址
                          </Button>
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            onClick={() => navigate(`/runs?dataset=${ds.name}&vid=${v.id}`)}
                          >
                            用此版本发起评测
                          </Button>
                        </Space>
                      </Card>
                    ),
                  }))}
                />
              ),
          },
          // ---------- Tab3 badcase 回灌（UI-307） ----------
          {
            key: 'badcase',
            label: 'Badcase 回灌',
            children: (
              <>
                <Alert
                  type="info"
                  style={{ marginBottom: 12 }}
                  message="以下为评测失败回灌产生的资产（来源 = Badcase 回灌）。勾选后按本数据集场景映射转入草稿；已在本数据集中的资产不可重复转入。"
                />
                {bcSelected.length > 0 && (
                  <Alert
                    style={{ marginBottom: 12 }}
                    type="warning"
                    showIcon
                    message={`已勾选 ${bcSelected.length} 条`}
                    action={
                      <Space>
                        <Button size="small" type="primary" loading={bcBusy} onClick={() => void transferBadcase()}>
                          转入草稿
                        </Button>
                        <Button size="small" onClick={() => setBcSelected([])}>
                          清除
                        </Button>
                      </Space>
                    }
                  />
                )}
                <Table<Asset>
                  rowKey="id"
                  size="small"
                  loading={bcItems === null}
                  dataSource={bcItems ?? []}
                  rowSelection={{
                    selectedRowKeys: bcSelected,
                    onChange: setBcSelected,
                    getCheckboxProps: (a) => ({ disabled: includedAssetIds.has(a.id) }),
                  }}
                  pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条`, hideOnSinglePage: true }}
                  locale={{ emptyText: '暂无 badcase 回灌资产：评测中心的「失败回灌」动作会写入这里（UI-M3）' }}
                  columns={[
                    { title: '内容摘要', dataIndex: 'content', render: (_, a) => <ContentBrief content={a.content} /> },
                    {
                      title: '标签',
                      dataIndex: 'tags',
                      width: 180,
                      render: (tags: string[]) =>
                        tags.length === 0 ? (
                          <span style={{ color: '#bfbfbf' }}>—</span>
                        ) : (
                          <>
                            {tags.slice(0, 2).map((t) => (
                              <Tag key={t} color="red">
                                {t}
                              </Tag>
                            ))}
                            {tags.length > 2 && <Tag>+{tags.length - 2}</Tag>}
                          </>
                        ),
                    },
                    {
                      title: '关联 Run',
                      key: 'run',
                      width: 120,
                      render: (_, a) => {
                        // 回灌资产的 run_id 存于 content（旧版可能在 meta）
                        const rid = a.content?.run_id ?? a.meta?.run_id
                        return typeof rid === 'string' ? (
                          <Link to={`/runs/${rid}`} className="num">
                            {rid.slice(0, 8)}
                          </Link>
                        ) : (
                          <span style={{ color: '#bfbfbf' }}>—</span>
                        )
                      },
                    },
                    {
                      title: '时间',
                      dataIndex: 'created_at',
                      width: 140,
                      render: (v: string) => <span className="num">{fmtTime(v)}</span>,
                    },
                    {
                      title: '状态',
                      key: 'state',
                      width: 120,
                      render: (_, a) =>
                        includedAssetIds.has(a.id) ? (
                          <Tag color="default">已在本数据集</Tag>
                        ) : (
                          <Tag color="green">可转入</Tag>
                        ),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />

      {/* 圈选资产向导（UI-304） */}
      <SelectAssetsWizard
        open={selectOpen}
        dataset={ds}
        includedAssetIds={includedAssetIds}
        onClose={() => setSelectOpen(false)}
        onDone={() => {
          setSelectOpen(false)
          void loadDrafts()
          void loadDs()
        }}
      />

      {/* 发布新版本（UI-305） */}
      <PublishVersionModal
        open={publishOpen}
        dataset={ds}
        onClose={() => setPublishOpen(false)}
        onPublished={() => {
          setPublishOpen(false)
          setTab('versions')
          void loadVersions()
          void loadDrafts()
          void loadDs()
        }}
      />

      {/* 草稿编辑 */}
      <DraftItemEditModal
        datasetId={id}
        scene={ds.scene}
        item={editItem}
        onClose={() => setEditItem(null)}
        onSaved={() => {
          setEditItem(null)
          void loadDrafts()
          void loadDs()
        }}
      />

      {/* 删除草稿确认 */}
      <Modal
        open={delItem !== null}
        title="删除草稿 item"
        okText="删除"
        okType="danger"
        onCancel={() => setDelItem(null)}
        onOk={() => void doDeleteItem()}
      >
        <Typography.Paragraph type="secondary">
          删除后不可恢复；已发布版本中的 item 不受影响（版本不可变）。
        </Typography.Paragraph>
        <pre className="num" style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, background: '#fafafa', padding: 8 }}>
          {JSON.stringify(delItem?.input, null, 2)}
        </pre>
      </Modal>

      {/* 快照预览（前 50 条） */}
      <Modal
        open={previewVer !== null}
        width={960}
        title={
          previewVer
            ? `v${previewVer.version} 快照预览（前 ${previewItems?.length ?? 0} 条 / 共 ${previewVer.item_count} 条）`
            : ''
        }
        footer={null}
        onCancel={() => setPreviewVer(null)}
      >
        {previewItems === null ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : (
          <DatasetItemsTable scene={ds.scene} items={previewItems} />
        )}
      </Modal>

      {/* 删除数据集确认：输入名称防误删 */}
      <Modal
        open={delDsOpen}
        title="删除数据集"
        okText="删除"
        okType="danger"
        okButtonProps={{ disabled: delDsInput !== ds.name }}
        onCancel={() => setDelDsOpen(false)}
        onOk={() => void doDeleteDs()}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert type="warning" message="将级联删除该数据集的全部 item；已生成的版本快照文件与评测 Run 记录保留。" />
          <div>
            请输入 <Typography.Text code>{ds.name}</Typography.Text> 确认删除：
          </div>
          <Input className="num" value={delDsInput} onChange={(e) => setDelDsInput(e.target.value)} placeholder={ds.name} />
        </Space>
      </Modal>
    </div>
  )
}
