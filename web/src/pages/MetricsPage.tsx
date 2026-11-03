// 指标与目标管理（UI-407）：Target 列表+新建 / MetricConfig 列表+新建（指标动态行，按类型渲染参数）
// / 指标目录只读表（GET /metrics）
import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { EvalTarget, MetricConfig, MetricInfo, MetricSpec } from '../api/types'
import { SceneTag, SCENE_META } from '../components/labels'
import { fmtTime } from '../utils/format'

// ---------- 指标参数描述（与 agenthub/metrics 各实现的 spec 约定对齐） ----------

interface Field {
  key: string
  label: string
  widget: 'text' | 'textarea' | 'number' | 'switch'
  placeholder?: string
  required?: boolean
  help?: string
}

const ACTUAL_FIELD: Field = {
  key: 'actual',
  label: '输出取值路径 actual',
  widget: 'text',
  placeholder: '默认 answer',
}

/** 各指标类型的专有参数（公共参数 actual/weight/threshold 在行内单独渲染） */
const TYPE_FIELDS: Record<string, Field[]> = {
  'rule:exact': [
    { key: 'value', label: '期望值 value', widget: 'text', help: '与 expected_path 二选一' },
    { key: 'expected_path', label: '期望路径 expected_path', widget: 'text', placeholder: '如 expected.answer' },
    { key: 'case_insensitive', label: '忽略大小写', widget: 'switch' },
  ],
  'rule:contains': [
    { key: 'value', label: '包含关键词 value', widget: 'text', help: '与 expected_path 二选一' },
    { key: 'expected_path', label: '期望路径 expected_path', widget: 'text' },
    { key: 'case_insensitive', label: '忽略大小写', widget: 'switch' },
  ],
  'rule:not_contains': [
    { key: 'value', label: '禁用关键词 value', widget: 'text', help: '与 expected_path 二选一' },
    { key: 'expected_path', label: '期望路径 expected_path', widget: 'text' },
    { key: 'case_insensitive', label: '忽略大小写', widget: 'switch' },
  ],
  'rule:regex': [
    { key: 'pattern', label: '正则 pattern', widget: 'text', help: '与 expected_path 二选一' },
    { key: 'expected_path', label: '从 item 取 pattern', widget: 'text' },
  ],
  'rule:json_schema': [
    { key: 'schema', label: 'JSON Schema', widget: 'textarea', help: 'JSON 对象文本；与 expected_path 二选一' },
    { key: 'expected_path', label: '从 item 取 schema', widget: 'text' },
  ],
  'rule:one_of': [
    { key: 'choices', label: '候选列表 choices', widget: 'text', placeholder: '逗号分隔，如：成功, OK', help: '与 expected_path 二选一' },
    { key: 'expected_path', label: '从 item 取 choices', widget: 'text' },
  ],
  'rule:numeric_within': [
    { key: 'value', label: '期望数值 value', widget: 'text', help: '与 expected_path 二选一' },
    { key: 'expected_path', label: '期望路径 expected_path', widget: 'text' },
    { key: 'abs_tolerance', label: '绝对容差', widget: 'number' },
    { key: 'rel_tolerance', label: '相对容差', widget: 'number' },
  ],
  'judge:correctness': [
    { key: 'question_path', label: '问题路径', widget: 'text', placeholder: '默认 input.question' },
    { key: 'expected_path', label: '标准答案路径', widget: 'text', placeholder: '默认 expected.answer' },
  ],
  'judge:faithfulness': [
    { key: 'context_path', label: '参考资料路径', widget: 'text', placeholder: '默认 context.passages' },
  ],
  'judge:custom': [{ key: 'rubric', label: '评分细则 rubric', widget: 'textarea', required: true }],
}

/** 提交前把表单行转换为 MetricSpec（类型转换：choices 拆分、schema 解析、数值化） */
function rowToSpec(row: Record<string, unknown>): MetricSpec {
  const type = String(row.type)
  const spec: MetricSpec = { type }
  if (row.weight != null) spec.weight = row.weight as number
  if (row.threshold != null) spec.threshold = row.threshold as number
  for (const f of TYPE_FIELDS[type] ?? []) {
    const v = row[f.key]
    if (v === undefined || v === null || v === '') continue
    if (f.key === 'choices') spec.choices = String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    else if (f.key === 'schema') spec.schema = JSON.parse(String(v))
    else if (f.key === 'abs_tolerance' || f.key === 'rel_tolerance') spec[f.key] = Number(v)
    else if (f.key === 'value') {
      const n = Number(v)
      spec.value = Number.isFinite(n) && String(v).trim() !== '' && /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? n : v
    } else spec[f.key] = v
  }
  return spec
}

// ---------- 指标动态行 ----------

function MetricRow({ name, metricInfos, onRemove }: {
  name: number
  metricInfos: MetricInfo[]
  onRemove: () => void
}) {
  const form = Form.useFormInstance()
  const type = Form.useWatch(['metrics', name, 'type'], form) as string | undefined
  const kind = type?.split(':')[0]
  const extra = TYPE_FIELDS[type ?? ''] ?? []

  const renderField = (f: Field, prefix: (string | number)[] = []) => {
    const path = [...prefix, f.key]
    const rules = f.required ? [{ required: true, message: `请填写${f.label}` }] : []
    return (
      <Form.Item key={f.key} name={path} label={f.label} rules={rules} extra={f.help} style={{ marginBottom: 8 }}>
        {f.widget === 'textarea' ? (
          <Input.TextArea rows={2} placeholder={f.placeholder} />
        ) : f.widget === 'number' ? (
          <InputNumber style={{ width: '100%' }} placeholder={f.placeholder} />
        ) : f.widget === 'switch' ? (
          <Switch />
        ) : (
          <Input placeholder={f.placeholder} />
        )}
      </Form.Item>
    )
  }

  return (
    <div style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: '12px 16px 4px', marginBottom: 12, position: 'relative' }}>
      <Button
        type="text"
        danger
        size="small"
        icon={<DeleteOutlined />}
        onClick={onRemove}
        style={{ position: 'absolute', top: 8, right: 8 }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px', gap: 12 }}>
        <Form.Item name={[name, 'type']} label="指标类型" rules={[{ required: true, message: '请选择指标' }]} style={{ marginBottom: 8 }}>
          <Select
            showSearch
            placeholder="选择指标"
            options={[
              { label: '规则类（rule）', options: metricInfos.filter((m) => m.kind === 'rule').map((m) => ({ value: m.type, label: m.type })) },
              { label: 'LLM 裁判（judge）', options: metricInfos.filter((m) => m.kind === 'judge').map((m) => ({ value: m.type, label: m.type })) },
            ].filter((g) => g.options.length > 0)}
          />
        </Form.Item>
        <Form.Item name={[name, 'weight']} label="权重" initialValue={1} style={{ marginBottom: 8 }}>
          <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name={[name, 'threshold']} label="阈值" style={{ marginBottom: 8 }}>
          <InputNumber min={0} max={1} step={0.05} placeholder={kind === 'judge' ? '默认 0.7' : '默认 1'} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 12px' }}>
        {renderField(ACTUAL_FIELD, [name])}
        {extra.map((f) => renderField(f, [name]))}
      </div>
    </div>
  )
}

// ---------- 页面 ----------

export default function MetricsPage() {
  const [targets, setTargets] = useState<EvalTarget[]>([])
  const [configs, setConfigs] = useState<MetricConfig[]>([])
  const [metricInfos, setMetricInfos] = useState<MetricInfo[]>([])
  const [targetOpen, setTargetOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [targetForm] = Form.useForm()
  const [configForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [configMetricsError, setConfigMetricsError] = useState('')

  const reload = () => {
    api.targets().then(setTargets).catch(() => {})
    api.metricConfigs().then(setConfigs).catch(() => {})
  }
  useEffect(() => {
    reload()
    api.metrics().then(setMetricInfos).catch(() => {})
  }, [])

  const descOf = (type: string) => metricInfos.find((m) => m.type === type)?.description ?? ''

  const submitTarget = async () => {
    const v = await targetForm.validateFields()
    setSubmitting(true)
    try {
      await api.createTarget({
        name: v.name,
        kind: v.kind,
        endpoint_config: v.kind === 'http' ? { url: v.url } : {},
      })
      setTargetOpen(false)
      targetForm.resetFields()
      reload()
    } catch {
      // 错误已统一 toast
    } finally {
      setSubmitting(false)
    }
  }

  const submitConfig = async () => {
    const v = await configForm.validateFields()
    if (!v.metrics || v.metrics.length === 0) {
      setConfigMetricsError('至少添加一个指标')
      return
    }
    setConfigMetricsError('')
    setSubmitting(true)
    try {
      await api.createMetricConfig({
        name: v.name,
        scene: v.scene,
        metrics: (v.metrics as Record<string, unknown>[]).map(rowToSpec),
      })
      setConfigOpen(false)
      configForm.resetFields()
      reload()
    } catch (e) {
      if (e instanceof SyntaxError) {
        // schema JSON 解析失败
        configForm.setFields([{ name: ['metrics'], errors: ['JSON Schema 不是合法 JSON'] }])
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {/* Target 管理 */}
      <Card
        title="被测目标 Target"
        size="small"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setTargetOpen(true)}>
            新建 Target
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Table<EvalTarget>
          rowKey="id"
          size="small"
          dataSource={targets}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name', width: 200 },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 130,
              render: (k: string) => (
                <Tag color={k === 'http' ? 'blue' : 'orange'}>{k === 'http' ? 'HTTP 托管' : 'External 回传'}</Tag>
              ),
            },
            {
              title: 'Endpoint',
              dataIndex: 'endpoint_config',
              render: (cfg: Record<string, unknown>, t) =>
                t.kind === 'http' ? (
                  <Space size={6}>
                    <Tooltip title="已配置 URL">
                      <span className="dot" style={{ background: cfg.url ? '#52c41a' : '#ff4d4f' }} />
                    </Tooltip>
                    <Typography.Text className="num" style={{ fontSize: 12 }}>
                      {String(cfg.url ?? '未配置')}
                    </Typography.Text>
                  </Space>
                ) : (
                  <Space size={6}>
                    <Tooltip title="External：由外部系统调用 API 回传结果">
                      <span className="dot" style={{ background: '#8c8c8c' }} />
                    </Tooltip>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      POST /api/v1/runs/&#123;id&#125;/results
                    </Typography.Text>
                  </Space>
                ),
            },
            {
              title: '创建时间',
              dataIndex: 'created_at',
              width: 150,
              render: (v: string) => <span className="num">{fmtTime(v)}</span>,
            },
          ]}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有 Target：托管 http 服务或 external 回传的 Agent 都需先登记为 Target"
                style={{ padding: '24px 0' }}
              >
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setTargetOpen(true)}>
                  新建 Target
                </Button>
              </Empty>
            ),
          }}
        />
      </Card>

      {/* MetricConfig 管理 */}
      <Card
        title="指标组合 MetricConfig"
        size="small"
        extra={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setConfigOpen(true)}
            disabled={metricInfos.length === 0}
          >
            新建指标组合
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Table<MetricConfig>
          rowKey="id"
          size="small"
          dataSource={configs}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name', width: 200 },
            { title: '场景', dataIndex: 'scene', width: 130, render: (s: string) => <SceneTag scene={s} /> },
            {
              title: '指标（含权重）',
              dataIndex: 'metrics',
              render: (ms: MetricSpec[]) => (
                <Space size={4} wrap>
                  {ms.map((m, i) => (
                    <Tooltip key={`${m.type}-${i}`} title={descOf(m.type) || `${m.type} · 权重 ×${m.weight ?? 1}`}>
                      <Tag>
                        {m.type}
                        {m.weight != null && m.weight !== 1 && <span style={{ color: '#8c8c8c' }}> ×{m.weight}</span>}
                      </Tag>
                    </Tooltip>
                  ))}
                </Space>
              ),
            },
            {
              title: '创建时间',
              dataIndex: 'created_at',
              width: 150,
              render: (v: string) => <span className="num">{fmtTime(v)}</span>,
            },
          ]}
          locale={{
            emptyText:
              metricInfos.length === 0 ? (
                '指标目录加载中，稍候即可创建'
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有指标组合" style={{ padding: '24px 0' }}>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setConfigOpen(true)}>
                    新建指标组合
                  </Button>
                </Empty>
              ),
          }}
        />
      </Card>

      {/* 指标目录（只读） */}
      <Card title="指标目录（内置只读）" size="small">
        <Table<MetricInfo>
          rowKey="type"
          size="small"
          dataSource={metricInfos}
          pagination={false}
          columns={[
            {
              title: '类型',
              dataIndex: 'type',
              width: 200,
              render: (t: string) => <Tag color={t.startsWith('rule') ? 'cyan' : 'purple'}>{t}</Tag>,
            },
            { title: '类别', dataIndex: 'kind', width: 100 },
            { title: '说明', dataIndex: 'description' },
          ]}
          locale={{ emptyText: '加载中…' }}
        />
      </Card>

      {/* 新建 Target */}
      <Modal
        title="新建 Target"
        open={targetOpen}
        onCancel={() => {
          setTargetOpen(false)
          targetForm.resetFields()
        }}
        onOk={submitTarget}
        confirmLoading={submitting}
        okText="创建"
        destroyOnClose
      >
        <Form form={targetForm} layout="vertical" initialValues={{ kind: 'http' }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：my-agent-v2" />
          </Form.Item>
          <Form.Item name="kind" label="类型">
            <Radio.Group
              options={[
                { value: 'http', label: 'HTTP 托管（平台调用其端点）' },
                { value: 'external', label: 'External 回传（外部跑完回传）' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.kind !== c.kind}>
            {() =>
              targetForm.getFieldValue('kind') === 'http' && (
                <Form.Item
                  name="url"
                  label="Agent 服务 URL"
                  rules={[{ required: true, message: 'http 目标需要 URL' }]}
                  extra="平台将向该地址 POST 数据集 item，期望返回 JSON（含 answer 等字段）"
                >
                  <Input placeholder="http://localhost:9000/agent" />
                </Form.Item>
              )
            }
          </Form.Item>
        </Form>
      </Modal>

      {/* 新建指标组合 */}
      <Modal
        title="新建指标组合"
        open={configOpen}
        onCancel={() => {
          setConfigOpen(false)
          setConfigMetricsError('')
          configForm.resetFields()
        }}
        onOk={submitConfig}
        confirmLoading={submitting}
        okText="创建"
        width={720}
        destroyOnClose
      >
        <Form form={configForm} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12 }}>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
              <Input placeholder="如：QA-综合评测" />
            </Form.Item>
            <Form.Item name="scene" label="适用场景" rules={[{ required: true, message: '请选择场景' }]}>
              <Select
                placeholder="选择场景"
                options={Object.entries(SCENE_META).map(([k, m]) => ({ value: k, label: m.label }))}
              />
            </Form.Item>
          </div>
          <Form.Item label="指标列表" required style={{ marginBottom: 8 }}>
            <Form.List name="metrics">
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((field) => (
                    <MetricRow key={field.key} name={field.name} metricInfos={metricInfos} onRemove={() => remove(field.name)} />
                  ))}
                  <Button
                    type="dashed"
                    block
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setConfigMetricsError('')
                      add({ weight: 1 })
                    }}
                  >
                    添加指标
                  </Button>
                  {configMetricsError && (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {configMetricsError}
                    </Typography.Text>
                  )}
                  <Form.ErrorList errors={errors} />
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
