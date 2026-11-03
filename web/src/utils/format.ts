import dayjs from 'dayjs'

/** 后端时间戳为无时区 UTC（naive UTC），补 Z 后转本地时区显示 */
export function fmtTime(s?: string | null): string {
  if (!s) return '—'
  const iso = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`
  return dayjs(iso).format('YYYY-MM-DD HH:mm')
}

/** 0~1 分数 → 百分比文本；N/A 显示 — */
export function fmtPct(v?: number | null, digits = 1): string {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`
}

/** 分数分档：≥80 绿 / 50~80 黄 / <50 红 / N/A 灰 */
export type Tone = 'pass' | 'warn' | 'fail' | 'na'

export function scoreTone(v?: number | null): Tone {
  if (v == null) return 'na'
  if (v >= 0.8) return 'pass'
  if (v >= 0.5) return 'warn'
  return 'fail'
}

export const TONE_COLOR: Record<Tone, string> = {
  pass: '#52c41a',
  warn: '#faad14',
  fail: '#ff4d4f',
  na: '#bfbfbf',
}
