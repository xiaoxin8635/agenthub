// 顶部全局搜索（06 文档第 3 节站点地图）：资产内容关键词 / 数据集名称 / Run id 前缀，
// 防抖 300ms，三类实体分组展示，选中直达详情。
import { useRef, useState } from 'react'
import { AutoComplete, Input, Tag } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Asset, DatasetBrief, RunSummary } from '../api/types'

type Group = { label: string; options: { value: string; label: React.ReactNode }[] }

function brief(a: Asset): string {
  const s = JSON.stringify(a.content)
  return s.length > 44 ? s.slice(0, 44) + '…' : s
}

const STATUS_COLOR: Record<string, string> = { done: 'green', failed: 'red', running: 'blue', pending: 'default' }

export default function GlobalSearch() {
  const nav = useNavigate()
  const [value, setValue] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onSearch = (kw: string) => {
    setValue(kw)
    if (timer.current) clearTimeout(timer.current)
    const key = kw.trim()
    if (!key) {
      setGroups([])
      return
    }
    timer.current = setTimeout(async () => {
      const lower = key.toLowerCase()
      const [assets, dss, rns] = await Promise.all([
        api.assets({ q: key, limit: 5 }).catch(() => ({ items: [] as Asset[] })),
        api.datasets().catch(() => [] as DatasetBrief[]),
        api.runs({ limit: 100 }).catch(() => ({ items: [] as RunSummary[] })),
      ])
      const next: Group[] = []
      if (assets.items.length)
        next.push({
          label: '数据资产',
          options: assets.items.map((a) => ({
            value: `/assets?asset=${a.id}`,
            label: (
              <span>
                <Tag style={{ marginInlineEnd: 8 }}>{a.type}</Tag>
                <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{brief(a)}</span>
              </span>
            ),
          })),
        })
      const hitDs = dss.filter((d) => d.name.toLowerCase().includes(lower))
      if (hitDs.length)
        next.push({
          label: '评测数据集',
          options: hitDs.slice(0, 5).map((d) => ({
            value: `/datasets/${d.id}`,
            label: (
              <span>
                <Tag color="blue" style={{ marginInlineEnd: 8 }}>
                  {d.name}
                </Tag>
                {d.scene} · v{d.latest_version ?? '—'}
              </span>
            ),
          })),
        })
      const hitRun = rns.items.filter((r) => r.id.toLowerCase().startsWith(lower))
      if (hitRun.length)
        next.push({
          label: '评测任务',
          options: hitRun.slice(0, 5).map((r) => ({
            value: `/runs/${r.id}`,
            label: (
              <span>
                <Tag color={STATUS_COLOR[r.status] ?? 'default'} style={{ marginInlineEnd: 8 }}>
                  {r.id.slice(0, 8)}
                </Tag>
                {r.status} · 通过率 {r.pass_rate != null ? `${(r.pass_rate * 100).toFixed(0)}%` : '—'}
              </span>
            ),
          })),
        })
      setGroups(next)
    }, 300)
  }

  return (
    <AutoComplete
      style={{ width: 280 }}
      value={value}
      options={groups}
      onSearch={onSearch}
      onSelect={(url: string) => {
        setValue('')
        setGroups([])
        nav(url)
      }}
      popupMatchSelectWidth={420}
    >
      <Input size="small" prefix={<SearchOutlined />} placeholder="搜索资产 / 数据集 / Run id" allowClear />
    </AutoComplete>
  )
}
