// 数字滚动动画：从 0 缓动到目标值（easeOutCubic），用于指标卡数字
import { useEffect, useState } from 'react'

export function useCountUp(target: number, duration = 700): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf = 0
    const t0 = performance.now()
    const from = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration)
      setV(from + (target - from) * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return v
}
