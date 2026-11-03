// 批量加入数据集（UI-204）：勾选资产 → 选目标数据集 → from-assets 圈选转入草稿
import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Select, Space, Statistic } from 'antd'
import { api } from '../api/client'
import type { DatasetBrief, FromAssetsResult } from '../api/types'

export default function BatchAddToDatasetModal({
  open,
  assetIds,
  onClose,
  onDone,
}: {
  open: boolean
  assetIds: string[]
  onClose: () => void
  onDone: () => void
}) {
  const [datasets, setDatasets] = useState<DatasetBrief[] | null>(null)
  const [dsId, setDsId] = useState<string | undefined>()
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FromAssetsResult | null>(null)

  useEffect(() => {
    if (open) {
      setResult(null)
      setTags([])
      setDsId(undefined)
      api
        .datasets()
        .then((ds) => {
          setDatasets(ds)
          if (ds.length === 1) setDsId(ds[0].id)
        })
        .catch(() => setDatasets([]))
    }
  }, [open])

  const submit = async () => {
    if (!dsId) return
    setBusy(true)
    try {
      setResult(await api.addFromAssets(dsId, { asset_ids: assetIds, tags }))
    } catch {
      // 错误已 toast
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={`加入数据集（已选 ${assetIds.length} 条资产）`}
      onCancel={result ? onDone : onClose}
      footer={
        result ? (
          <Button type="primary" onClick={onDone}>
            完成
          </Button>
        ) : (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={busy} disabled={!dsId} onClick={submit}>
              加入草稿
            </Button>
          </Space>
        )
      }
    >
      {!result && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <div style={{ marginBottom: 4 }}>目标数据集</div>
            {datasets === null ? (
              <Select style={{ width: '100%' }} loading placeholder="加载中…" />
            ) : datasets.length === 0 ? (
              <Alert type="warning" message="还没有数据集，请先在「评测数据集」模块创建" />
            ) : (
              <Select
                style={{ width: '100%' }}
                placeholder="选择数据集"
                value={dsId}
                onChange={setDsId}
                options={datasets.map((d) => ({
                  value: d.id,
                  label: `${d.name}（${d.scene}${d.latest_version ? ` · v${d.latest_version}` : ' · 无版本'}）`,
                }))}
              />
            )}
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>附加标签（可选）</div>
            <Select
              mode="tags"
              tokenSeparators={[',']}
              value={tags}
              onChange={setTags}
              placeholder="附加到生成的草稿 item"
              style={{ width: '100%' }}
              open={false}
            />
          </div>
          <Alert
            type="info"
            message="资产将按数据集场景映射为草稿 item；无法映射或非法的资产自动跳过并在结果中报告。"
          />
        </Space>
      )}

      {result && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space size={32}>
            <Statistic title="圈选资产" value={result.selected} />
            <Statistic title="成功转入草稿" value={result.added} valueStyle={{ color: '#52c41a' }} />
            <Statistic title="无法映射/非法" value={result.skipped_invalid} valueStyle={{ color: '#faad14' }} />
            <Statistic title="重复跳过" value={result.skipped_dup} />
          </Space>
          {result.errors?.length > 0 && (
            <Alert
              type="warning"
              message="部分条目存在问题"
              description={
                <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 140, overflow: 'auto' }}>
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              }
            />
          )}
          <Alert type="info" message="草稿 item 需在数据集详情页「发布新版本」后进入不可变快照（数据集模块 UI-M2 交付）。" />
        </Space>
      )}
    </Modal>
  )
}
