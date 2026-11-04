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
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { DeleteOutlined, InfoCircleOutlined, PlusOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { EvalTarget, MetricConfig, MetricInfo, MetricSpec } from '../api/types'
import { SceneTag, SCENE_META } from '../components/labels'
import { fmtTime } from '../utils/format'

// ---------- 指标中文名与通俗说明（下拉选择引导） ----------

const METRIC_ZH: Record<string, { zh: string; tip: string }> = {
  'rule:exact': { zh: '精确匹配', tip: '回答与标准答案完全一致（忽略首尾空格和大小写），适合有唯一标准答案的题' },
  'rule:contains': { zh: '包含关键词', tip: '回答中必须包含指定关键词，适合检查"必须提到的信息"（如数字、名词）' },
  'rule:not_contains': { zh: '不包含', tip: '回答中不得出现指定词，适合检查违禁词、内部信息泄漏' },
  'rule:regex': { zh: '正则匹配', tip: '用正则表达式校验回答格式，如订单号、日期、编号' },
  'rule:json_schema': { zh: 'JSON 结构校验', tip: '回答（JSON）必须符合指定 Schema，适合结构化输出验收' },
  'rule:one_of': { zh: '枚举命中', tip: '回答必须是候选列表之一，适合分类、单选题' },
  'rule:numeric_within': { zh: '数值容差', tip: '从回答提取数字与期望值比较并允许误差，适合价格、百分比' },
  'rule:custom': { zh: '自定义规则', tip: '组合多种检测：关键词组 / 长度区间 / 正则 / 数值容差 / 结构校验' },
  'judge:correctness': { zh: '正确性评审（LLM）', tip: 'LLM 对照标准答案给 0~1 分并说明理由，适合开放性问答' },
  'judge:faithfulness': { zh: '忠实度评审（LLM）', tip: '检查回答是否忠于参考资料、有没有编造，RAG 防幻觉必备' },
  'judge:custom': { zh: '自定义评审（LLM）', tip: 'LLM 按你写的评分细则打分，如简洁度、语气、是否夹带推广' },
}

// 下拉选项：中文名 + 类型名 + 一句话说明（两行渲染，支持中文搜索）
function metricOption(m: MetricInfo) {
  const zh = METRIC_ZH[m.type]?.zh ?? m.type
  const tip = METRIC_ZH[m.type]?.tip ?? m.description
  return {
    value: m.type,
    search: `${m.type} ${zh}`,
    zh,
    label: (
      <div style={{ lineHeight: 1.4, padding: '2px 0' }}>
        <div>
          <b>{zh}</b>
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{m.type}</Typography.Text>
          {m.builtin === false && <Tag color="orange" style={{ marginLeft: 8, fontSize: 11 }}>自定义</Tag>}
        </div>
        <div style={{ fontSize: 12, color: '#8c8c8c', whiteSpace: 'normal', wordBreak: 'break-all' }}>{tip}</div>
      </div>
    ),
  }
}

// ---------- 指标参数描述（与 agenthub/metrics 各实现的 spec 约定对齐） ----------

interface Field {
  key: string
  label: string
  widget: 'text' | 'textarea' | 'number' | 'switch' | 'select'
  placeholder?: string
  required?: boolean
  help?: string
  options?: { value: string; label: string }[]
  /** 仅当 rule:custom 的 kind 为这些值时才显示（undefined = 恒显示） */
  kinds?: string[]
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
  'rule:custom': [
    {
      key: 'kind',
      label: '规则 kind',
      widget: 'select',
      required: true,
      options: [
        { value: 'contains_any', label: 'contains_any 关键词组' },
        { value: 'length_range', label: 'length_range 长度区间' },
        { value: 'regex', label: 'regex 正则' },
        { value: 'numeric_within', label: 'numeric_within 数值容差' },
        { value: 'json_schema', label: 'json_schema 结构校验' },
      ],
    },
    { key: 'keywords', label: '关键词列表 keywords', widget: 'text', placeholder: '逗号分隔，如：退款, 工单, 发票', kinds: ['contains_any'] },
    {
      key: 'match',
      label: '命中模式 match',
      widget: 'select',
      options: [
        { value: 'any', label: 'any 任一命中' },
        { value: 'all', label: 'all 全部命中' },
      ],
      kinds: ['contains_any'],
    },
    { key: 'min_len', label: '最小长度', widget: 'number', kinds: ['length_range'] },
    { key: 'max_len', label: '最大长度', widget: 'number', placeholder: '留空不限制', kinds: ['length_range'] },
    { key: 'pattern', label: '正则 pattern', widget: 'text', kinds: ['regex'] },
    { key: 'value', label: '期望数值 value', widget: 'text', kinds: ['numeric_within'] },
    { key: 'abs_tolerance', label: '绝对容差', widget: 'number', kinds: ['numeric_within'] },
    { key: 'rel_tolerance', label: '相对容差', widget: 'number', kinds: ['numeric_within'] },
    { key: 'schema', label: 'JSON Schema', widget: 'textarea', help: 'JSON 对象文本', kinds: ['json_schema'] },
  ],
}

/** 提交前把表单行转换为 MetricSpec（类型转换：choices/keywords 拆分、schema 解析、数值化） */
function rowToSpec(row: Record<string, unknown>): MetricSpec {
  const type = String(row.type)
  const spec: MetricSpec = { type }
  if (row.weight != null) spec.weight = row.weight as number
  if (row.threshold != null) spec.threshold = row.threshold as number
  for (const f of TYPE_FIELDS[type] ?? []) {
    const v = row[f.key]
    if (v === undefined || v === null || v === '') continue
    if (f.key === 'choices' || f.key === 'keywords')
      spec[f.key] = String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    else if (f.key === 'schema') spec.schema = JSON.parse(String(v))
    else if (['abs_tolerance', 'rel_tolerance', 'min_len', 'max_len'].includes(f.key)) spec[f.key] = Number(v)
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
  const customKind = Form.useWatch(['metrics', name, 'kind'], form) as string | undefined
  const allFields = TYPE_FIELDS[type ?? ''] ?? []
  // rule:custom 按所选 kind 过滤参数字段（kinds 未标注的字段恒显示）
  const extra = allFields.filter((f) => !f.kinds || !customKind || f.kinds.includes(customKind))

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
        ) : f.widget === 'select' ? (
          <Select options={f.options} placeholder={f.placeholder} />
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
            placeholder="选择指标（输入可搜索中文名）"
            virtual={false}
            popupMatchSelectWidth={false}
            dropdownStyle={{ minWidth: 460, maxWidth: 600 }}
            optionLabelProp="zh"
            filterOption={(input, option) =>
              String((option as { search?: string })?.search ?? '').toLowerCase().includes(input.toLowerCase())
            }
            options={[
              {
                label: '规则类（代码判定，免费稳定）',
                options: metricInfos
                  .filter((m) => m.kind === 'rule')
                  .map((m) => metricOption(m)),
              },
              {
                label: 'LLM 裁判（智能评审，消耗 Token）',
                options: metricInfos
                  .filter((m) => m.kind === 'judge')
                  .map((m) => metricOption(m)),
              },
            ].filter((g) => g.options.length > 0)}
          />
        </Form.Item>
        <Form.Item
          name={[name, 'weight']}
          label={
            <Tooltip title="该指标在此条评分中的占比，最终得分 = Σ(指标得分 × 权重) ÷ Σ(权重)">
              权重 <QuestionCircleOutlined style={{ color: '#8c8c8c' }} />
            </Tooltip>
          }
          initialValue={1}
          style={{ marginBottom: 8 }}
        >
          <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name={[name, 'threshold']}
          label={
            <Tooltip title="该指标的及格线：得分低于阈值时，整条 case 判失败（红）">
              阈值 <QuestionCircleOutlined style={{ color: '#8c8c8c' }} />
            </Tooltip>
          }
          style={{ marginBottom: 8 }}
        >
          <InputNumber min={0} max={1} step={0.05} placeholder={kind === 'judge' ? '默认 0.7' : '默认 1'} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      {type && METRIC_ZH[type] && (
        <div style={{ marginBottom: 8, fontSize: 12, color: '#8c8c8c', background: 'rgba(22,119,255,0.06)', borderRadius: 6, padding: '6px 10px' }}>
          <InfoCircleOutlined style={{ marginRight: 6, color: '#1677ff' }} />
          {METRIC_ZH[type].tip}
        </div>
      )}
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

  const doDeleteTarget = async (t: EvalTarget) => {
    try {
      await api.deleteTarget(t.id)
      message.success(`Target「${t.name}」已删除`)
      reload()
    } catch {
      // 错误已统一 toast（409 会提示先删除相关 Run）
    }
  }

  const doDeleteConfig = async (c: MetricConfig) => {
    try {
      await api.deleteMetricConfig(c.id)
      message.success(`指标组合「${c.name}」已删除`)
      reload()
    } catch {
      // 错误已统一 toast
    }
  }

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
            {
              title: '操作',
              width: 80,
              render: (_, t) => (
                <Popconfirm
                  title={`删除 Target「${t.name}」？`}
                  description="已被评测任务引用时无法删除。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void doDeleteTarget(t)}
                >
                  <Button danger type="text" size="small" icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              ),
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
            {
              title: '操作',
              width: 80,
              render: (_, c) => (
                <Popconfirm
                  title={`删除指标组合「${c.name}」？`}
                  description="已被评测任务引用时无法删除。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void doDeleteConfig(c)}
                >
                  <Button danger type="text" size="small" icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              ),
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

      {/* 指标目录（内置 + 自定义规则入口） */}
      <Card title="指标目录" size="small">
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
              render: (t: string, m) => (
                <Space size={4}>
                  <Tag color={t.startsWith('rule') ? 'cyan' : 'purple'}>{t}</Tag>
                  {m.builtin === false && <Tag color="orange">自定义</Tag>}
                </Space>
              ),
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
