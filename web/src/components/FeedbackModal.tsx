// 失败 case 回灌对话框（UI-406）：可附 tags、可选目标数据集（默认不转入），
// 完成后显示 created/skipped/added 与跳转链接。任意位置（逐 case 勾选/失败筛选栏/对比页）均可触发。
import { useEffect, useState } from 'react'
import { Alert, Descriptions, Form, Modal, Select, Space, Typography } from 'antd'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { DatasetBrief, FeedbackResult } from '../api/types'

export default function FeedbackModal({
  open,
  onClose,
  runId,
  runLabel,
  onDone,
}: {
  open: boolean
  onClose: () => void
  runId: string
  /** 展示用标签（如 target@agent_version），仅提示用 */
  runLabel?: string
  /** 回灌成功后回调（父组件刷新列表） */
  onDone?: () => void
}) {
  const [form] = Form.useForm()
  const [datasets, setDatasets] = useState<DatasetBrief[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<FeedbackResult | null>(null)
  const [targetDataset, setTargetDataset] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setResult(null)
    form.resetFields()
    api
      .datasets()
      .then(setDatasets)
      .catch(() => {}) // 错误已统一 toast
  }, [open, form])

  const submit = async () => {
    const values = await form.validateFields()
    setSubmitting(true)
    try {
      const res = await api.feedback(runId, {
        dataset: values.dataset,
        tags: values.tags ?? [],
      })
      setResult(res)
      setTargetDataset(values.dataset ?? null)
      onDone?.()
    } catch {
      // 错误已统一 toast
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="回灌失败 case"
      open={open}
      onCancel={onClose}
      onOk={result ? onClose : submit}
      okText={result ? '完成' : '开始回灌'}
      confirmLoading={submitting}
      destroyOnClose
      width={520}
    >
      {result ? (
        <div>
          <Alert
            type="success"
            showIcon
            message={`回灌完成：新建资产 ${result.created_assets} 条`}
            style={{ marginBottom: 16 }}
          />
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="失败 case 数">{result.failed_cases}</Descriptions.Item>
            <Descriptions.Item label="新建资产（source=badcase_feedback）">
              {result.created_assets}
            </Descriptions.Item>
            <Descriptions.Item label="跳过（此前已回灌过）">{result.skipped_dup}</Descriptions.Item>
            <Descriptions.Item label="转入目标数据集草稿">
              {result.added_items}
              {targetDataset && result.added_items > 0 && (
                <Link to={`/datasets/${targetDataset}`} style={{ marginLeft: 8 }}>
                  查看该数据集 →
                </Link>
              )}
            </Descriptions.Item>
          </Descriptions>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
            回灌的资产可在 <Link to="/assets">数据资产</Link> 页按来源「Badcase 回灌」筛选查看。
          </Typography.Text>
        </div>
      ) : (
        <Form form={form} layout="vertical">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`将把 Run ${runLabel ?? runId} 的全部失败 case 沉淀为资产（source=badcase_feedback），重复回灌按内容指纹自动去重。`}
          />
          <Form.Item name="tags" label="附带标签（可选）">
            <Select
              mode="tags"
              placeholder="输入后回车添加，如：回归、高风险"
              tokenSeparators={[',']}
              open={false}
            />
          </Form.Item>
          <Form.Item name="dataset" label="转入目标数据集草稿（可选，默认不转入）">
            <Select
              allowClear
              placeholder="不转入，仅沉淀为资产"
              options={datasets.map((d) => ({ value: d.name, label: `${d.name}（草稿 ${d.draft_count} 条）` }))}
            />
          </Form.Item>
          <Space direction="vertical" size={0}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              资产 content 含 input / expected / context / agent_output / run_id，可被任意场景数据集重新圈选。
            </Typography.Text>
          </Space>
        </Form>
      )}
    </Modal>
  )
}
