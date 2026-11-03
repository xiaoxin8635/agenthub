// 设置页（UI-500）：UI-501 服务端配置状态只读展示 + UI-502 API Key 打码可复制 + SDK/CLI 接入片段
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Descriptions, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd'
import { EyeInvisibleOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { ServerSettings } from '../api/types'
import CopyButton from '../components/CopyButton'

const { Text } = Typography

// 片段中的服务地址：SDK/CLI 直连后端端口（浏览器内走 vite 代理，嵌入式片段必须写死后端）
const API_BASE = 'http://localhost:8300'

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

/** 代码片段容器：深色块 + 右上角一键复制 */
function Snippet({ code }: { code: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>
        <CopyButton text={code} label="复制全部" />
      </div>
      <pre
        style={{
          background: '#0d1117',
          color: '#c9d1d9',
          padding: 16,
          paddingRight: 110,
          borderRadius: 8,
          overflow: 'auto',
          fontSize: 12.5,
          lineHeight: 1.7,
          margin: 0,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [showKey, setShowKey] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSettings(await api.settings())
    } catch {
      // 错误已统一 toast
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const llm = settings?.llm_judge
  const authOn = settings?.auth_enabled ?? false

  return (
    <div>
      <Alert
        style={{ marginBottom: 16 }}
        type="info"
        showIcon
        message="本页为服务端配置的只读视图；修改请在服务器 .env / 环境变量中设置（AGENTHUB_* 前缀）并重启服务生效。"
      />

      {/* UI-501 服务端配置状态 */}
      <Card
        title="服务端配置状态"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
        loading={loading && settings === null}
      >
        {settings ? (
          <Descriptions
            column={1}
            bordered
            size="small"
            styles={{ label: { width: 190 } }}
            items={[
              {
                key: 'auth',
                label: '接口鉴权',
                children: (
                  <Space direction="vertical" size={2}>
                    <Space>
                      {authOn ? <Tag color="green">已开启</Tag> : <Tag color="orange">开发模式（未校验）</Tag>}
                      {!authOn && (
                        <Text type="secondary">任何请求均放行；生产部署请在 .env 配置 AGENTHUB_API_KEY</Text>
                      )}
                    </Space>
                  </Space>
                ),
              },
              {
                key: 'apikey',
                label: 'API Key（X-API-Key）',
                children: authOn ? (
                  <Space wrap>
                    <Text code className="num" style={{ fontSize: 13 }}>
                      {showKey ? settings.api_key : maskKey(settings.api_key)}
                    </Text>
                    <Button
                      size="small"
                      type="text"
                      icon={showKey ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                      onClick={() => setShowKey((v) => !v)}
                    >
                      {showKey ? '隐藏' : '显示'}
                    </Button>
                    <CopyButton text={settings.api_key} label="复制 Key" />
                  </Space>
                ) : (
                  <Text type="secondary">
                    未配置 —— 开发模式无需携带鉴权头，下方接入片段中的 X-API-Key 可省略
                  </Text>
                ),
              },
              {
                key: 'llm',
                label: 'LLM Judge（OpenAI 兼容）',
                children: llm?.configured ? (
                  <Space direction="vertical" size={2}>
                    <Space wrap>
                      <Tag color="green">已配置</Tag>
                      <Text code className="num">
                        {llm.base_url}
                      </Text>
                      <Tag color="purple">{llm.model}</Tag>
                    </Space>
                    <Space size={8}>
                      <Text type="secondary">密钥</Text>
                      <Text code className="num">
                        {llm.api_key_masked || '（未设置，按无鉴权端点调用）'}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        服务端永远打码显示
                      </Text>
                    </Space>
                  </Space>
                ) : (
                  <Space direction="vertical" size={2}>
                    <Tag>未配置</Tag>
                    <Text type="secondary">
                      judge:* 类指标（judge:correctness / judge:faithfulness / judge:custom）运行时将失败，规则指标不受影响。
                      配置：.env 中设置 AGENTHUB_LLM_BASE_URL / AGENTHUB_LLM_MODEL / AGENTHUB_LLM_API_KEY
                    </Text>
                  </Space>
                ),
              },
              {
                key: 'data_dir',
                label: '数据目录（快照存储）',
                children: (
                  <Space>
                    <Text code copyable className="num">
                      {settings.data_dir}
                    </Text>
                  </Space>
                ),
              },
              {
                key: 'db',
                label: '数据库',
                children: (
                  <Text code copyable className="num">
                    {settings.db}
                  </Text>
                ),
              },
              {
                key: 'cors',
                label: 'CORS 允许来源',
                children: (
                  <Text code className="num">
                    {settings.cors_origins}
                  </Text>
                ),
              },
              {
                key: 'run_concurrency',
                label: (
                  <Tooltip title="托管评测时同时调用被测 Agent 的线程数，环境变量 AGENTHUB_RUN_CONCURRENCY 可调">
                    评测并发数（Agent 调用线程）
                  </Tooltip>
                ),
                children: (
                  <Text code className="num">
                    {settings.run_concurrency ?? '—'}
                  </Text>
                ),
              },
            ]}
          />
        ) : loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : null}
      </Card>

      {/* UI-502 SDK / CLI 接入片段 */}
      {settings && (
        <Card title="SDK / CLI 接入片段" style={{ marginTop: 16 }}>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            复制即可在 Agent 工程或自动化脚本中接入。鉴权开启时把 <Text code>&lt;API_KEY&gt;</Text>{' '}
            替换为上方复制的 Key；CLI 亦可通过环境变量 <Text code>AGENTHUB_URL</Text> /{' '}
            <Text code>AGENTHUB_API_KEY</Text> 传入。
          </Typography.Paragraph>
          <Tabs
            items={[
              {
                key: 'sdk',
                label: 'Python SDK（拉取数据集）',
                children: (
                  <Snippet
                    code={`# 依赖：pip install httpx；源码仓库布局下把 sdk/ 加入 sys.path
import sys
sys.path.append("sdk")  # 或将 sdk/agenthub_sdk 复制进你的工程
from agenthub_sdk import AgentHub

hub = AgentHub(base_url="${API_BASE}", api_key="<API_KEY>")

# 拉取数据集快照：显式版本命中本地缓存（版本不可变）；只传名称则自动解析最新版
ds = hub.pull("order-qa@1")
for item in ds:
    output = my_agent(item.input)   # 替换为你的 Agent 推理调用
    print(item.id, item.tags, "->", output)`}
                  />
                ),
              },
              {
                key: 'cli',
                label: 'CLI（全链路）',
                children: (
                  <Snippet
                    code={`# 连接参数：--base-url / --api-key（默认读环境变量 AGENTHUB_URL / AGENTHUB_API_KEY）
python -m agenthub.cli import traces.jsonl --source trace_import --tags v1
python -m agenthub.cli dataset-create order-qa qa
python -m agenthub.cli dataset-select order-qa --filters source=trace_import tag=退款
python -m agenthub.cli dataset-publish order-qa --changelog "首批 50 条"
python -m agenthub.cli pull order-qa@1 -o ds.jsonl        # Agent 侧拉取评测集
python -m agenthub.cli eval order-qa@1 --target fake-agent --metrics qa-basic --wait
python -m agenthub.cli run-show RUN_ID --failures         # 失败明细
python -m agenthub.cli compare RUN_A RUN_B                # 版本对比
python -m agenthub.cli feedback RUN_ID --dataset order-qa --tags regression   # badcase 回灌`}
                  />
                ),
              },
              {
                key: 'rest',
                label: 'REST API（cURL）',
                children: (
                  <Snippet
                    code={`BASE=${API_BASE}/api/v1

# 拉取数据集版本快照（JSONL）
curl -H "X-API-Key: <API_KEY>" "$BASE/datasets/order-qa/versions/1/export?format=jsonl" -o ds.jsonl

# 发起评测（external Target 回传模式：创建后由外部系统回传结果）
curl -X POST -H "X-API-Key: <API_KEY>" -H "Content-Type: application/json" \\
  -d '{"dataset_version_id":"<版本ID>","target_id":"<TargetID>","metric_config_id":"<指标组合ID>","agent_version":"v1"}' \\
  "$BASE/runs"

# 外部系统逐条回传结果（全部回传后 run 自动 finalize）
curl -X POST -H "X-API-Key: <API_KEY>" -H "Content-Type: application/json" \\
  -d '{"results":[{"item_id":"<条目ID>","output":{"answer":"..."}}]}' \\
  "$BASE/runs/<RUN_ID>/results"

# 失败 case 一键回灌为资产（可选转入数据集草稿）
curl -X POST -H "X-API-Key: <API_KEY>" -H "Content-Type: application/json" \\
  -d '{"dataset":"order-qa","tags":["regression"]}' \\
  "$BASE/runs/<RUN_ID>/feedback"`}
                  />
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  )
}
