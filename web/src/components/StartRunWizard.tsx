// 发起评测向导（UI-402）：①选数据集版本 ②选 Target ③选指标组合 ④确认摘要 → 提交跳 Run 详情
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Radio, Select, Space, Steps, Tag, Typography } from 'antd'
import { api } from '../api/client'
import type { DatasetBrief, DatasetVersionList, EvalTarget, MetricConfig } from '../api/types'
import { SceneTag } from './labels'

const KIND_META: Record<string, { label: string; color: string }> = {
  http: { label: 'HTTP 托管', color: 'blue' },
  external: { label: 'External 回传', color: 'orange' },
}

function PickCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <div
      onClick={onClick}
      style={{
        border: `1px solid ${selected ? '#1677ff' : '#f0f0f0'}`,
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 10,
        cursor: 'pointer',
        background: selected ? '#f0f7ff' : undefined,
      }}
    >
      {children}
    </div>
  )
}

export default function StartRunWizard({
  open,
  onClose,
  onCreated,
  initial,
}: {
  open: boolean
  onClose: () => void
  /** 提交成功（含托管 start），参数为新 Run id */
  onCreated: (runId: string) => void
  /** 从数据集详情「用此版本发起评测」等入口带入的预选 */
  initial?: { datasetName?: string; versionId?: string }
}) {
  const [step, setStep] = useState(0)
  const [datasets, setDatasets] = useState<DatasetBrief[]>([])
  const [versions, setVersions] = useState<DatasetVersionList | null>(null)
  const [targets, setTargets] = useState<EvalTarget[]>([])
  const [configs, setConfigs] = useState<MetricConfig[]>([])

  const [datasetName, setDatasetName] = useState<string>()
  const [versionId, setVersionId] = useState<string>()
  const [targetId, setTargetId] = useState<string>()
  const [configId, setConfigId] = useState<string>()
  const [agentVersion, setAgentVersion] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    // 重置状态并加载三类基础数据
    setStep(0)
    setDatasetName(undefined)
    setVersionId(undefined)
    setTargetId(undefined)
    setConfigId(undefined)
    setAgentVersion('')
    setVersions(null)
    Promise.all([api.datasets(), api.targets(), api.metricConfigs()])
      .then(async ([ds, tg, mc]) => {
        setDatasets(ds)
        setTargets(tg)
        setConfigs(mc)
        // 应用预选：定位数据集并选中指定版本（缺省回退最新版本）
        if (initial?.datasetName) {
          setDatasetName(initial.datasetName)
          try {
            const vs = await api.datasetVersions(initial.datasetName)
            setVersions(vs)
            const want =
              (initial.versionId && vs.items.find((v) => v.id === initial.versionId)) ||
              [...vs.items].sort((a, b) => b.version - a.version)[0]
            if (want) setVersionId(want.id)
          } catch {
            setVersions(null)
          }
        }
      })
      .catch(() => {}) // 错误已统一 toast
  }, [open])

  const pickDataset = async (name: string) => {
    setDatasetName(name)
    setVersionId(undefined)
    try {
      const vs = await api.datasetVersions(name)
      setVersions(vs)
      // 默认选最新版本
      const latest = [...vs.items].sort((a, b) => b.version - a.version)[0]
      if (latest) setVersionId(latest.id)
    } catch {
      setVersions(null)
    }
  }

  const dataset = datasets.find((d) => d.name === datasetName)
  const target = targets.find((t) => t.id === targetId)
  const config = configs.find((c) => c.id === configId)
  const version = versions?.items.find((v) => v.id === versionId)

  const canNext = useMemo(() => {
    if (step === 0) return !!versionId
    if (step === 1) return !!targetId
    if (step === 2) return !!configId
    return true
  }, [step, versionId, targetId, configId])

  const submit = async () => {
    if (!versionId || !targetId || !configId) return
    setSubmitting(true)
    try {
      const run = await api.createRun({
        dataset_version_id: versionId,
        target_id: targetId,
        metric_config_id: configId,
        agent_version: agentVersion,
      })
      // http 目标自动进入托管执行；external 目标由外部回传
      if (target?.kind === 'http') {
        await api.startRun(run.id).catch(() => {})
      }
      onCreated(run.id)
    } catch {
      // 错误已统一 toast
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="发起评测"
      open={open}
      width={640}
      onCancel={onClose}
      footer={undefined}
      destroyOnClose
    >
      <Steps
        size="small"
        current={step}
        style={{ margin: '8px 0 20px' }}
        items={['选数据集版本', '选 Target', '选指标组合', '确认'].map((t) => ({ title: t }))}
      />

      {step === 0 && (
        <div>
          <Typography.Paragraph type="secondary">选择已发布版本的数据集（默认最新版本）。</Typography.Paragraph>
          <Select
            style={{ width: '100%' }}
            placeholder="选择数据集"
            value={datasetName}
            onChange={pickDataset}
            options={datasets.map((d) => ({
              value: d.name,
              label: `${d.name}（最新 v${d.latest_version ?? '—'} · ${d.total_items} 条）`,
              disabled: d.latest_version == null,
            }))}
          />
          {dataset?.latest_version == null && (
            <Alert type="warning" showIcon style={{ marginTop: 10 }} message="该数据集还没有已发布版本，请先到数据集详情发布。" />
          )}
          {versions && versions.items.length > 0 && (
            <Select
              style={{ width: '100%', marginTop: 12 }}
              placeholder="选择版本"
              value={versionId}
              onChange={setVersionId}
              options={[...versions.items]
                .sort((a, b) => b.version - a.version)
                .map((v) => ({
                  value: v.id,
                  label: `v${v.version} · ${v.item_count} 条 · ${v.changelog || '无变更说明'}`,
                }))}
            />
          )}
        </div>
      )}

      {step === 1 && (
        <div>
          <Typography.Paragraph type="secondary">
            HTTP 目标由平台托管调用其端点；External 目标由外部系统跑完后回传结果。
          </Typography.Paragraph>
          <Radio.Group style={{ width: '100%' }} value={targetId}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {targets.map((t) => (
                <PickCard key={t.id} selected={t.id === targetId} onClick={() => setTargetId(t.id)}>
                  <Space>
                    <Radio value={t.id} />
                    <b>{t.name}</b>
                    <Tag color={KIND_META[t.kind]?.color}>{KIND_META[t.kind]?.label ?? t.kind}</Tag>
                  </Space>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4, marginLeft: 28 }}>
                    {t.kind === 'http' ? String(t.endpoint_config.url ?? '未配置 URL') : '由外部系统回传结果（POST /runs/{id}/results）'}
                  </div>
                </PickCard>
              ))}
              {targets.length === 0 && <Alert type="info" showIcon message="还没有 Target，请先到「指标与目标」页创建。" />}
            </Space>
          </Radio.Group>
        </div>
      )}

      {step === 2 && (
        <div>
          <Typography.Paragraph type="secondary">指标组合决定评分方式与加权总分。</Typography.Paragraph>
          <Radio.Group style={{ width: '100%' }} value={configId}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {configs.map((c) => (
                <PickCard key={c.id} selected={c.id === configId} onClick={() => setConfigId(c.id)}>
                  <Space wrap>
                    <Radio value={c.id} />
                    <b>{c.name}</b>
                    <SceneTag scene={c.scene} />
                  </Space>
                  <div style={{ marginTop: 6, marginLeft: 28 }}>
                    {c.metrics.map((m, i) => (
                      <Tag key={`${m.type}-${i}`}>
                        {m.type}
                        {m.weight != null && m.weight !== 1 && (
                          <span style={{ color: '#8c8c8c' }}> ×{m.weight}</span>
                        )}
                      </Tag>
                    ))}
                  </div>
                </PickCard>
              ))}
              {configs.length === 0 && <Alert type="info" showIcon message="还没有指标组合，请先到「指标与目标」页创建。" />}
            </Space>
          </Radio.Group>
        </div>
      )}

      {step === 3 && (
        <div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <div>
              数据集版本：<b>{datasetName}</b> {version ? `v${version.version}（${version.item_count} 条）` : '—'}
            </div>
            <div>
              Target：<b>{target?.name}</b>（{KIND_META[target?.kind ?? '']?.label}）
              {target?.kind === 'external' && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 8 }}
                  message="External 目标创建后需通过 API/CLI 回传逐条结果（POST /runs/{id}/results），收齐后自动聚合。"
                />
              )}
            </div>
            <div>
              指标组合：<b>{config?.name}</b>
              <div style={{ marginTop: 4 }}>
                {config?.metrics.map((m, i) => (
                  <Tag key={`${m.type}-${i}`}>
                    {m.type}
                    {m.weight != null && m.weight !== 1 && <span style={{ color: '#8c8c8c' }}> ×{m.weight}</span>}
                  </Tag>
                ))}
              </div>
            </div>
            <div>
              <Input
                style={{ width: 280 }}
                placeholder="Agent 版本（可选，如 v2.1）"
                value={agentVersion}
                onChange={(e) => setAgentVersion(e.target.value)}
              />
            </div>
          </Space>
        </div>
      )}

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
        <Button onClick={() => setStep(step - 1)} disabled={step === 0} style={{ visibility: step === 0 ? 'hidden' : 'visible' }}>
          上一步
        </Button>
        {step < 3 ? (
          <Button type="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            下一步
          </Button>
        ) : (
          <Button type="primary" loading={submitting} onClick={submit}>
            提交评测
          </Button>
        )}
      </div>
    </Modal>
  )
}
