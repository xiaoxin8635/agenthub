// 导入向导（UI-202）：三步——选文件 → source/tags → 导入结果
import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Select, Space, Statistic, Steps, Upload } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { ImportResult } from '../api/types'

const SOURCE_OPTIONS = [
  { value: 'trace_import', label: 'Trace 导入' },
  { value: 'manual', label: '手工创建' },
]

export default function ImportAssetsModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: () => void
}) {
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [lineCount, setLineCount] = useState(0)
  const [source, setSource] = useState('trace_import')
  const [tags, setTags] = useState<string[]>([])
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setStep(0)
      setFile(null)
      setLineCount(0)
      setSource('trace_import')
      setTags([])
      setResult(null)
    }
  }, [open])

  const pickFile = (f: File) => {
    setFile(f)
    f.text().then((t) => setLineCount(t.split(/\r?\n/).filter((l) => l.trim()).length))
  }

  const submit = async () => {
    if (!file) return
    setBusy(true)
    try {
      const r = await api.importAssets(file, source, tags)
      setResult(r)
      setStep(2)
    } catch {
      // 错误已 toast
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="导入数据资产"
      width={560}
      onCancel={onClose}
      footer={
        step === 0 && (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" disabled={!file} onClick={() => setStep(1)}>
              下一步
            </Button>
          </Space>
        )
      }
    >
      {step === 0 && (
        <>
          <Steps
            size="small"
            current={0}
            items={[{ title: '选择文件' }, { title: '来源与标签' }, { title: '导入结果' }]}
            style={{ marginBottom: 16 }}
          />
          <Upload.Dragger
            accept=".jsonl,.json,.txt"
            maxCount={1}
            beforeUpload={(f) => {
              pickFile(f)
              return false
            }}
            onRemove={() => {
              setFile(null)
              setLineCount(0)
            }}
            fileList={file ? [file as unknown as never] : []}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">拖拽 JSONL 文件到此处，或点击选择</p>
            <p className="ant-upload-hint">每行一个 JSON 对象，须含 type 与 content 字段</p>
          </Upload.Dragger>
          {file && (
            <Alert
              style={{ marginTop: 12 }}
              type="success"
              message={`已选择 ${file.name}，共 ${lineCount} 行非空数据`}
            />
          )}
        </>
      )}

      {step === 1 && (
        <>
          <Steps
            size="small"
            current={1}
            items={[{ title: '选择文件' }, { title: '来源与标签' }, { title: '导入结果' }]}
            style={{ marginBottom: 16 }}
          />
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <div>
              <div style={{ marginBottom: 4 }}>来源 source</div>
              <Select value={source} onChange={setSource} options={SOURCE_OPTIONS} style={{ width: 240 }} />
            </div>
            <div>
              <div style={{ marginBottom: 4 }}>标签（输入回车添加，将附加到每条资产）</div>
              <Select
                mode="tags"
                tokenSeparators={[',']}
                value={tags}
                onChange={setTags}
                placeholder="如：线上trace、订单域"
                style={{ width: '100%' }}
                open={false}
              />
            </div>
            <Alert
              type="info"
              message={`将为 ${file?.name}（${lineCount} 行）创建资产；content 重复的行自动跳过去重。`}
            />
          </Space>
        </>
      )}

      {step === 2 && result && (
        <>
          <Steps
            size="small"
            current={2}
            items={[{ title: '选择文件' }, { title: '来源与标签' }, { title: '导入结果' }]}
            style={{ marginBottom: 16 }}
          />
          <Space size={32} style={{ marginBottom: 16 }}>
            <Statistic title="解析总数" value={result.total} />
            <Statistic title="新建" value={result.created} valueStyle={{ color: '#52c41a' }} />
            <Statistic title="重复跳过" value={result.skipped} valueStyle={{ color: '#faad14' }} />
          </Space>
          {result.errors?.length ? (
            <Alert
              type="warning"
              message={`${result.errors.length} 行解析失败`}
              description={
                <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              }
            />
          ) : (
            <Alert type="success" message="全部行导入成功" />
          )}
        </>
      )}

      {step > 0 && (
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Space>
            {step === 1 && (
              <>
                <Button onClick={() => setStep(0)}>上一步</Button>
                <Button type="primary" loading={busy} onClick={submit}>
                  开始导入
                </Button>
              </>
            )}
            {step === 2 && (
              <>
                <Button
                  onClick={() => {
                    onImported()
                    onClose()
                  }}
                >
                  完成
                </Button>
                <Button
                  type="primary"
                  onClick={() => {
                    setStep(0)
                    setFile(null)
                    setLineCount(0)
                    setResult(null)
                  }}
                >
                  再导入一个文件
                </Button>
              </>
            )}
          </Space>
        </div>
      )}
    </Modal>
  )
}
