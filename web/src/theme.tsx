// 全局主题：亮/暗切换（localStorage 记忆）+ 统一设计 Token（圆角/字体/背景）。
// 图表配色通过 useTheme().isDark 在各图表组件内适配。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'

type Mode = 'light' | 'dark'

const ThemeCtx = createContext<{ isDark: boolean; toggle: () => void }>({
  isDark: false,
  toggle: () => {},
})

export function useTheme() {
  return useContext(ThemeCtx)
}

const FONT =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif"

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem('ah-theme')
    return saved === 'dark' ? 'dark' : 'light'
  })

  useEffect(() => {
    localStorage.setItem('ah-theme', mode)
    document.documentElement.dataset.theme = mode
  }, [mode])

  const isDark = mode === 'dark'

  return (
    <ThemeCtx.Provider value={{ isDark, toggle: () => setMode(isDark ? 'light' : 'dark') }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: '#1677ff',
            borderRadius: 8,
            fontFamily: FONT,
          },
          components: {
            Layout: {
              headerBg: isDark ? 'rgba(18,20,26,0.72)' : 'rgba(255,255,255,0.72)',
              siderBg: isDark ? '#141414' : '#fff',
            },
            Menu: { itemBorderRadius: 8, itemMarginInline: 8 },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeCtx.Provider>
  )
}
