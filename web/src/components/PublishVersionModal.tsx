// 发布新版本（UI-305）：变更摘要（新增/保留/版本号）→ changelog → 确认发布
import { useEffect, useState } from 'react'
import { Alert, Checkbox, Input, Modal, Space, Statistic, Typography, message } from 'antd'
import { api, ApiError } from '../api/client'
import type { DatasetBrief, DatasetVersion } from '../api/types'

export default function PublishVersionModal({
  open,
  dataset,
  onClose,
  onPublished,
}: {
  open: boolean
  dataset: DatasetBrief
  onClose: () => void
  onPublished: (ver: DatasetVersion) => void
}) {
  const [changelog, setChangelog] = useState('')
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    if (open) {
      setChangelog('')
      setSkipInvalid(false)
      setErrors([])
    }
  }, [open])

  const nextVersion = (dataset.latest_version ?? 0) + 1

  const submit = async () => {
    if (!changelog.trim()) {
      message.error('请填写变更说明（changelog）')
      return
    }
    setBusy(true)
    setErrors([])
    try {
      const ver = await api.publishVersion(dataset.id, {
        changelog: changelog.trim(),
        skip_invalid: skipInvalid,
      })
      message.success(`已发布 v${ver.version}（共 ${ver.item_count} 条）`)
      onPublished(ver)
    } catch (e) {
      // 422 = 存在非法草稿：展示原因并引导开启跳过
      if (e instanceof ApiError && e.status === 422) setErrors(e.message.split('; '))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="发布新版本"
      okText={`发布 v${nextVersion}`}
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() => void submit()}
    >
      <Space direction="vertical" size={12} style={{ width: '100%', margin: '12px 0' }}>
        {/* 变更摘要 */}
        <Space size={40} wrap>
          <Statistic
            title="新增草稿"
            value={dataset.draft_count}
            valueStyle={{ color: dataset.draft_count ? '#52c41a' : undefined }}
          />
          <Statistic title="保留已有（carried）" value={dataset.total_items} />
          <Statistic title="发布版本" value={`v${nextVersion}`} />
        </Space>

        <Alert
          type="info"
          message="发布后草稿将写入不可变快照（文件即真相），此后仅可整体回看、不可逐条修改。"
        />

        <div>
          <div style={{ marginBottom: 4 }}>变更说明 changelog（必填）</div>
          <Input.TextArea
            rows={3}
            maxLength={200}
            showCount
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            placeholder="如：接入线上 badcase 回灌 12 条，补充退款场景"
          />
        </div>

        <Checkbox checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)}>
          跳过无法通过场景 Schema 校验的草稿（不勾选则存在非法草稿时整批拒绝发布）
        </Checkbox>

        {errors.length > 0 && (
          <Alert
            type="error"
            message="存在非法草稿，发布被拒绝"
            description={
              <>
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, maxHeight: 140, overflow: 'auto' }}>
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
                <Typography.Text type="secondary">
                  可回到「数据管理」Tab 编辑或删除非法草稿，或勾选上方「跳过非法草稿」后重试。
                </Typography.Text>
              </>
            }
          />
        )}
      </Space>
    </Modal>
  )
}
