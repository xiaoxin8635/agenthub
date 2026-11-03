// 通过率色条：0~1 → 百分比 + 语义色进度条；N/A 灰色 —（tooltip「无法评估」）
import { Progress, Tooltip } from 'antd'
import { fmtPct, scoreTone, TONE_COLOR } from '../utils/format'

export default function PassRate({ value, width = 120 }: { value?: number | null; width?: number }) {
  if (value == null) {
    return (
      <Tooltip title="无法评估">
        <span style={{ color: TONE_COLOR.na }}>—</span>
      </Tooltip>
    )
  }
  const color = TONE_COLOR[scoreTone(value)]
  const p = value * 100
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width }}>
      <Progress
        percent={p}
        showInfo={false}
        size="small"
        strokeColor={color}
        style={{ flex: 1, margin: 0 }}
      />
      <span className="num" style={{ color, minWidth: 48, textAlign: 'right' }}>
        {fmtPct(value)}
      </span>
    </div>
  )
}
