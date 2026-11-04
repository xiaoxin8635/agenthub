// AI 生成评测集弹窗：上传文档 → 后台 LLM 出题 → 代码去重 → 进度轮询 → 结果统计
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, InputNumber, Modal, Progress, Space, Statistic, Upload, message } from 'antd'
import { CheckCircleOutlined, InboxOutlined, RobotOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { GenerateJob } from '../api/types'

export default function GenerateEvalsetModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [perChunk, setPerChunk] = useState(2)
  const [job, setJob] = useState<GenerateJob | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  // 轮询 job
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return
    timer.current = setInterval(async () => {
      try {
        const j = await api.generateJob(job.id)
        setJob(j)
        if (j.status === 'done') {
          const dropped = (j.stats?.dropped_exact ?? 0) + (j.stats?.dropped_fuzzy ?? 0)
          message.success(`生成完成：入库 ${j.inserted ?? 0} 条（去重剔除 ${dropped} 条）`)
          onDone()
        }
        if (j.status === 'error') message.error(`生成失败：${j.error}`)
      } catch {
        // 单次轮询失败忽略
      }
    }, 1500)
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }, [job?.id, job?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setFile(null)
    setJob(null)
    onClose()
  }

  const start = async () => {
    if (!file) {
      message.warning('请先选择文档（.md / .txt）')
      return
    }
    setBusy(true)
    try {
      const r = await api.generateEvalset(file, perChunk)
      setJob({ id: r.job_id, filename: file.name, status: 'running', done: 0, total: 0, generated: 0 })
    } catch {
      // 错误已 toast
    } finally {
      setBusy(false)
    }
  }

  const running = job?.status === 'running'
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0

  return (
    <Modal
      title={
        <Space>
          <RobotOutlined style={{ color: '#722ed1' }} />
          AI 生成评测集（RAG 问答）
        </Space>
      }
      open={open}
      onCancel={close}
      footer={
        job ? (
          <Button onClick={close}>{job.status === 'running' ? '后台运行，关闭弹窗' : '关闭'}</Button>
        ) : (
          <Space>
            <Button onClick={close}>取消</Button>
            <Button type="primary" loading={busy} disabled={!file} onClick={start}>
              开始生成
            </Button>
          </Space>
        )
      }
      width={560}
      destroyOnHidden
    >
      {!job && (
        <>
          <Upload.Dragger
            accept=".md,.txt,.markdown"
            maxCount={1}
            beforeUpload={(f) => {
              setFile(f)
              return false
            }}
            onRemove={() => setFile(null)}
            fileList={file ? [file as unknown as never] : []}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">拖入知识库文档（Markdown / 纯文本）</p>
            <p className="ant-upload-hint">按标题切片后由 LLM 逐片段出题，答案完全依据文档原文</p>
          </Upload.Dragger>
          <Space style={{ marginTop: 16 }} align="center">
            <span>每个片段生成</span>
            <InputNumber min={1} max={5} value={perChunk} onChange={(v) => setPerChunk(v ?? 1)} />
            <span>条问答</span>
          </Space>
          <Alert
            style={{ marginTop: 16 }}
            type="info"
            showIcon
            message="生成后自动去重（精确重复 + 相似问题），并入库为「AI 生成」来源的资产，可预览、可删除、可圈选建数据集"
          />
        </>
      )}

      {job && running && (
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <Progress type="circle" percent={pct} />
          <div style={{ marginTop: 12 }}>
            正在出题：片段 {job.done}/{job.total || '…'}，已生成 {job.generated} 条
          </div>
          <div style={{ marginTop: 4, color: '#8c8c8c', fontSize: 12 }}>
            可关闭弹窗，生成在后台继续（LLM 逐片段调用，约数秒/片段）
          </div>
        </div>
      )}

      {job && job.status === 'done' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <CheckCircleOutlined style={{ fontSize: 40, color: '#52c41a' }} />
          </div>
          <Space size={32} wrap style={{ justifyContent: 'center', width: '100%' }}>
            <Statistic title="LLM 原始生成" value={job.stats?.generated ?? 0} />
            <Statistic
              title="去重剔除"
              value={(job.stats?.dropped_exact ?? 0) + (job.stats?.dropped_fuzzy ?? 0)}
            />
            <Statistic title="入库资产" value={job.inserted} valueStyle={{ color: '#52c41a' }} />
          </Space>
          <Alert
            style={{ marginTop: 16 }}
            type="success"
            showIcon
            message="资产已入库（来源 = ai_generated），可在数据资产页圈选进数据集并发布版本"
          />
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <Button
              type="primary"
              onClick={() => {
                close()
                location.href = '/assets?source=ai_generated'
              }}
            >
              查看生成的资产
            </Button>
          </div>
        </div>
      )}

      {job && job.status === 'error' && (
        <Alert type="error" showIcon message="生成失败" description={job.error} />
      )}
    </Modal>
  )
}
