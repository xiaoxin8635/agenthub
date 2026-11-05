// 共享统计卡片（dataviz stat tile 契约）：label 次要墨色 + 大数字（半粗、比例数字，非 tabular-nums）+ 可选附注。
// HeroStat 为页面引导数字（44px + 分档语义色 meter，轨道为同色浅阶，文本数值保持主墨色不穿数据色）。
// inkTokens 提供亮暗两套图表墨色/网格 token，供各页 ECharts 配色复用（网格一律 hairline 实线）。
import type { ReactNode } from 'react'
import { Card } from 'antd'
import { useTheme } from '../theme'
import { useCountUp } from '../utils/useCountUp'
import { scoreTone, TONE_COLOR } from '../utils/format'

/** 图表墨色/网格 token：亮暗两套；文本走文本色不穿系列色 */
export function inkTokens(isDark: boolean) {
  return isDark
    ? {
        ink1: 'rgba(255,255,255,0.92)',
        ink2: 'rgba(255,255,255,0.65)',
        ink3: 'rgba(255,255,255,0.45)',
        grid: 'rgba(255,255,255,0.08)',
        axis: 'rgba(255,255,255,0.16)',
        cross: 'rgba(255,255,255,0.25)',
        barCtx: '#898781',
        barHover: 'rgba(255,255,255,0.6)',
        tooltipBg: '#1f1f1f',
        surface: '#141414',
      }
    : {
        ink1: 'rgba(0,0,0,0.88)',
        ink2: 'rgba(0,0,0,0.65)',
        ink3: 'rgba(0,0,0,0.45)',
        grid: 'rgba(0,0,0,0.06)',
        axis: 'rgba(0,0,0,0.15)',
        cross: 'rgba(0,0,0,0.2)',
        barCtx: '#898781',
        barHover: '#5e5c56',
        tooltipBg: '#ffffff',
        surface: '#ffffff',
      }
}

/** Stat tile：label + 大数字 + 可选附注；整卡可点击跳转 */
export function StatTile({
  label,
  value,
  sub,
  onClick,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  onClick?: () => void
}) {
  const { isDark } = useTheme()
  const t = inkTokens(isDark)
  return (
    <Card
      className="lift-card"
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', height: '100%' }}
    >
      <div style={{ fontSize: 13, color: t.ink2 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, color: t.ink1, lineHeight: 1.3, marginTop: 8 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: t.ink3, marginTop: 8 }}>{sub}</div>}
    </Card>
  )
}

/** Hero 数字块：44px 引导数字（同 sans、比例数字）+ 分档语义色 meter；value 传 0~1 或 null（N/A 显示 —） */
export function HeroStat({
  label,
  value,
  sub,
  digits = 0,
}: {
  label: string
  value: number | null
  sub?: ReactNode
  digits?: number
}) {
  const { isDark } = useTheme()
  const t = inkTokens(isDark)
  const animated = useCountUp(value == null ? 0 : value * 100)
  const color = value == null ? TONE_COLOR.na : TONE_COLOR[scoreTone(value)]
  const pct = value == null ? 0 : Math.round(value * 100)
  return (
    <Card className="lift-card" style={{ height: '100%' }}>
      <div style={{ fontSize: 13, color: t.ink2 }}>{label}</div>
      <div style={{ fontSize: 44, fontWeight: 600, color: t.ink1, lineHeight: 1.15, marginTop: 8 }}>
        {value == null ? '—' : `${animated.toFixed(digits)}%`}
      </div>
      {/* meter：填充承载分档语义色，轨道为同色 15% 浅阶（同 ramp） */}
      <div style={{ height: 4, borderRadius: 2, background: `${color}26`, marginTop: 14 }}>
        <div
          style={{
            height: 4,
            borderRadius: 2,
            width: `${pct}%`,
            background: color,
            transition: 'width 0.6s cubic-bezier(0, 0, 0.2, 1)',
          }}
        />
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: t.ink3, marginTop: 10 }}>{sub}</div>
      )}
    </Card>
  )
}
