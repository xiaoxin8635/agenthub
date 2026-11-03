// 轻量 JSON 树：默认展开第一层，对象/数组可折叠，值按类型着色
import { useState } from 'react'
import { CaretDownOutlined, CaretRightOutlined } from '@ant-design/icons'

const KEY_COLOR = '#d4380d'

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span style={{ color: '#8c8c8c' }}>null</span>
  if (typeof value === 'string') return <span style={{ color: '#389e0d' }}>"{value}"</span>
  if (typeof value === 'number')
    return (
      <span className="num" style={{ color: '#0958d9' }}>
        {value}
      </span>
    )
  if (typeof value === 'boolean') return <span style={{ color: '#722ed1' }}>{String(value)}</span>
  return <span>{String(value)}</span>
}

function Branch({ name, value, depth }: { name?: string; value: object; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const isArr = Array.isArray(value)
  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)

  return (
    <div>
      <span
        onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', userSelect: 'none', lineHeight: '20px' }}
      >
        {open ? <CaretDownOutlined style={{ color: '#8c8c8c' }} /> : <CaretRightOutlined style={{ color: '#8c8c8c' }} />}{' '}
        {name !== undefined && <span style={{ color: KEY_COLOR }}>{name}</span>}
        {!open && (
          <span style={{ color: '#8c8c8c' }}>
            {isArr ? `[…] ${entries.length} 项` : `{…} ${entries.length} 键`}
          </span>
        )}
      </span>
      {open && (
        <div style={{ paddingLeft: 16, marginLeft: 7, borderLeft: '1px solid #f0f0f0' }}>
          {entries.map(([k, v]) =>
            v !== null && typeof v === 'object' ? (
              <Branch key={k} name={k} value={v as object} depth={depth + 1} />
            ) : (
              <div key={k} style={{ lineHeight: '20px' }}>
                <span style={{ color: KEY_COLOR }}>{k}</span>
                <span style={{ color: '#8c8c8c' }}>: </span>
                <Primitive value={v} />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}

export default function JsonTree({ data, name }: { data: unknown; name?: string }) {
  if (data === null || typeof data !== 'object') return <Primitive value={data} />
  return <Branch name={name} value={data as object} depth={0} />
}
