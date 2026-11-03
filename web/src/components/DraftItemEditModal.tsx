// 草稿 item 编辑（UI-303）。后端无 PATCH 端点：采用「删除原草稿 → 重写新条目」，item ID 会变化
import { useEffect, useState } from 'react'
import { Alert, Form, Input, Modal, Select, message } from 'antd'
import { api } from '../api/client'
import type { DatasetItem } from '../api/types'
import { SCENE_META } from './labels'

export default function DraftItemEditModal({
  datasetId,
  scene,
  item,
  onClose,
  onSaved,
}: {
  datasetId: string
  scene: string
  item: DatasetItem | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  // 原草稿已删除但新内容尚未写入成功时置 true：重试直接走写入
  const [deleted, setDeleted] = useState(false)
  const meta = SCENE_META[scene]

  useEffect(() => {
    setDeleted(false)
    if (item) {
      form.setFieldsValue({
        input: JSON.stringify(item.input, null, 2),
        expected: JSON.stringify(item.expected, null, 2),
        context: JSON.stringify(item.context, null, 2),
        tags: item.tags,
      })
    }
  }, [item, form])

  const submit = async () => {
    if (!item) return
    const { input, expected, context, tags } = await form.validateFields()
    let parsed: { input: Record<string, unknown>; expected: Record<string, unknown>; context: Record<string, unknown> }
    try {
      parsed = {
        input: JSON.parse(input),
        expected: JSON.parse(expected || '{}'),
        context: JSON.parse(context || '{}'),
      }
    } catch {
      message.error('input / expected / context 必须是合法 JSON')
      return
    }
    setBusy(true)
    try {
      if (!deleted) {
        await api.deleteDatasetItem(datasetId, item.id)
        setDeleted(true)
      }
      try {
        await api.addDatasetItems(datasetId, {
          items: [{ ...parsed, tags, source_asset_id: item.source_asset_id }],
        })
      } catch (e) {
        message.error('场景校验未通过，请修正后重试（原草稿已删除，此编辑器保留了全部内容）')
        throw e
      }
      message.success('草稿已更新')
      onSaved()
    } catch {
      // 错误已 toast
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={item !== null}
      title="编辑草稿 item"
      width={640}
      okText="保存"
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() => void submit()}
    >
      <Alert
        type="info"
        style={{ margin: '12px 0' }}
        message={`场景 Schema：${meta?.schema ?? scene}`}
        description="保存 = 删除原草稿后重写（item ID 会变化）；来源资产关联保留。"
      />
      <Form form={form} layout="vertical">
        <Form.Item name="input" label="input（JSON）" rules={[{ required: true, message: '必填' }]}>
          <Input.TextArea className="num" rows={6} style={{ fontSize: 12 }} />
        </Form.Item>
        <Form.Item name="expected" label="expected（JSON）">
          <Input.TextArea className="num" rows={4} style={{ fontSize: 12 }} />
        </Form.Item>
        <Form.Item name="context" label="context（JSON，可选）">
          <Input.TextArea className="num" rows={3} style={{ fontSize: 12 }} />
        </Form.Item>
        <Form.Item name="tags" label="标签">
          <Select mode="tags" tokenSeparators={[',']} open={false} placeholder="回车添加" style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
