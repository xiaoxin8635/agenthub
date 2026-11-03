// 评测数据集列表（UI-301）：卡片网格 + 场景筛选 + 创建（UI-302）/ 删除确认
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { DatasetBrief } from '../api/types'
import { SCENE_META, SceneTag } from '../components/labels'
import CreateDatasetModal from '../components/CreateDatasetModal'
import { fmtTime } from '../utils/format'

export default function Datasets() {
  const navigate = useNavigate()
  const [items, setItems] = useState<DatasetBrief[] | null>(null)
  const [scene, setScene] = useState<string>()
  const [createOpen, setCreateOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<DatasetBrief | null>(null)
  const [delInput, setDelInput] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setItems(null)
    api
      .datasets()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = (items ?? []).filter((d) => !scene || d.scene === scene)

  const doDelete = async () => {
    if (!delTarget) return
    setBusy(true)
    try {
      const r = await api.deleteDataset(delTarget.id)
      message.success(`数据集已删除（清除 ${r.items_removed} 条 item）`)
      setDelTarget(null)
      setDelInput('')
      void load()
    } catch {
      // 错误已 toast
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {/* 场景筛选置顶 */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          placeholder="按场景筛选"
          allowClear
          style={{ width: 180 }}
          value={scene}
          onChange={(v) => setScene(v)}
          options={Object.entries(SCENE_META).map(([k, m]) => ({ value: k, label: m.label }))}
        />
        <Button icon={<ReloadOutlined />} onClick={load} />
        <div style={{ flex: 1 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建数据集
        </Button>
      </Space>

      {items === null && <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>}

      {items !== null && filtered.length === 0 && scene && (
        <Card>
          <Empty description="该场景下暂无数据集" />
        </Card>
      )}

      {items !== null && filtered.length === 0 && !scene && (
        <Card>
          <Empty description="还没有评测数据集">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              创建第一个数据集
            </Button>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
              建议流程：导入资产 → 创建数据集 → 圈选资产入草稿 → 发布版本 → 发起评测
            </Typography.Paragraph>
          </Empty>
        </Card>
      )}

      {/* UI-301 卡片网格（逐卡渐入 + hover 上浮） */}
      {filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {filtered.map((d, i) => (
            <Card
              key={d.id}
              hoverable
              className="lift-card stagger-item"
              style={{ animationDelay: `${Math.min(i * 40, 320)}ms` }}
              onClick={() => navigate(`/datasets/${d.id}`)}
              title={<Typography.Text strong>{d.name}</Typography.Text>}
              extra={<SceneTag scene={d.scene} />}
            >
              <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ minHeight: 44, marginBottom: 8 }}>
                {d.description || '暂无描述'}
              </Typography.Paragraph>
              <Space wrap size={4} style={{ marginBottom: 10 }}>
                <Tag>{d.total_items} 条已发布</Tag>
                <Tag color={d.draft_count > 0 ? 'orange' : 'default'}>{d.draft_count} 条草稿</Tag>
                <Tag color={d.latest_version ? 'blue' : 'default'}>
                  {d.latest_version ? `v${d.latest_version}` : '未发布'}
                </Tag>
              </Space>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  创建于 <span className="num">{fmtTime(d.created_at)}</span>
                </Typography.Text>
                <Space onClick={(e) => e.stopPropagation()}>
                  <Link to={`/datasets/${d.id}`}>详情</Link>
                  <Button
                    type="link"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      setDelTarget(d)
                      setDelInput('')
                    }}
                  >
                    删除
                  </Button>
                </Space>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateDatasetModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(ds) => {
          setCreateOpen(false)
          navigate(`/datasets/${ds.id}`)
        }}
      />

      {/* 删除确认：输入名称防误删 */}
      <Modal
        open={delTarget !== null}
        title="删除数据集"
        okText="删除"
        okType="danger"
        confirmLoading={busy}
        okButtonProps={{ disabled: delInput !== (delTarget?.name ?? '') }}
        onCancel={() => setDelTarget(null)}
        onOk={() => void doDelete()}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert type="warning" message="将级联删除该数据集的全部 item；已生成的版本快照文件与评测 Run 记录保留。" />
          <div>
            请输入 <Typography.Text code>{delTarget?.name}</Typography.Text> 确认删除：
          </div>
          <Input className="num" value={delInput} onChange={(e) => setDelInput(e.target.value)} placeholder={delTarget?.name} />
        </Space>
      </Modal>
    </div>
  )
}
