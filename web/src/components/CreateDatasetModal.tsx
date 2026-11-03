// 创建评测数据集（UI-302）：名称格式提示 + 5 场景卡片单选 + 描述
import { useEffect, useState } from 'react'
import { Form, Input, Modal, Radio, Typography, message } from 'antd'
import { api } from '../api/client'
import type { DatasetBrief } from '../api/types'
import { SCENE_META } from './labels'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/

export default function CreateDatasetModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (ds: DatasetBrief) => void
}) {
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const scene = Form.useWatch('scene', form) ?? 'qa'

  useEffect(() => {
    if (open) form.resetFields()
  }, [open, form])

  const submit = async () => {
    const values = await form.validateFields()
    setBusy(true)
    try {
      const ds = await api.createDataset(values)
      message.success(`数据集「${ds.name}」已创建`)
      onCreated(ds)
    } catch {
      // 重名等错误已 toast
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="创建评测数据集"
      width={780}
      okText="创建"
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() => void submit()}
    >
      <Form form={form} layout="vertical" initialValues={{ scene: 'qa', description: '' }} style={{ marginTop: 12 }}>
        <Form.Item
          name="name"
          label="数据集名称"
          rules={[
            { required: true, message: '请输入名称' },
            { pattern: NAME_RE, message: '小写字母或数字开头，仅含小写字母/数字/中划线/下划线，3~63 位' },
          ]}
          extra="名称将用于 CLI 拉取与导出地址，如 order-agent-regression"
        >
          <Input className="num" placeholder="order-agent-regression" maxLength={63} />
        </Form.Item>

        <Form.Item name="scene" label="评测场景（决定 item 的 Schema 校验与资产映射规则）" required>
          <Radio.Group style={{ width: '100%' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
              {Object.entries(SCENE_META).map(([key, m]) => (
                <Radio
                  key={key}
                  value={key}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    margin: 0,
                    padding: '10px 12px',
                    border: `1px solid ${scene === key ? '#1677ff' : '#d9d9d9'}`,
                    borderRadius: 8,
                    background: scene === key ? '#e6f4ff' : undefined,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontSize: 12, color: '#8c8c8c', whiteSpace: 'normal' }}>{m.desc}</div>
                    <div style={{ fontSize: 12, color: '#bfbfbf', whiteSpace: 'normal' }} className="num">
                      {m.schema}
                    </div>
                  </div>
                </Radio>
              ))}
            </div>
          </Radio.Group>
        </Form.Item>

        <Form.Item name="description" label="描述（可选）">
          <Input.TextArea rows={2} maxLength={200} showCount placeholder="这个数据集评测什么能力？" />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        创建后进入详情页：圈选资产生成草稿 → 发布为不可变版本。
      </Typography.Text>
    </Modal>
  )
}
