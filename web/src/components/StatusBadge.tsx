// 状态徽标：running 蓝点脉冲 / done 绿 / failed 红 / canceled 灰 / draft 灰 / published 蓝
const META: Record<string, { color: string; text: string }> = {
  running: { color: '#1677ff', text: '运行中' },
  done: { color: '#52c41a', text: '已完成' },
  failed: { color: '#ff4d4f', text: '失败' },
  pending: { color: '#faad14', text: '待执行' },
  canceled: { color: '#8c8c8c', text: '已取消' },
  draft: { color: '#8c8c8c', text: '草稿' },
  published: { color: '#1677ff', text: '已发布' },
}

export default function StatusBadge({ status }: { status: string }) {
  const m = META[status] ?? { color: '#8c8c8c', text: status }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={status === 'running' ? 'dot pulse' : 'dot'} style={{ background: m.color }} />
      <span style={{ color: m.color }}>{m.text}</span>
    </span>
  )
}
