import { Suspense, lazy, useEffect } from 'react'
import { App as AntApp, Spin, Typography } from 'antd'
import { Navigate, Route, Routes } from 'react-router-dom'
import { setNotifier } from './api/client'
import MainLayout from './layouts/MainLayout'

// 路由级代码分割：首屏只加载当前页面的 chunk，切换页面时按需拉取
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Assets = lazy(() => import('./pages/Assets'))
const Datasets = lazy(() => import('./pages/Datasets'))
const DatasetDetail = lazy(() => import('./pages/DatasetDetail'))
const Runs = lazy(() => import('./pages/Runs'))
const RunDetail = lazy(() => import('./pages/RunDetail'))
const MetricsPage = lazy(() => import('./pages/MetricsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

/** 将 antd message 注入请求层（client.ts 不依赖 React） */
export function Bridge() {
  const { message } = AntApp.useApp()
  useEffect(() => {
    setNotifier((content, type) => message[type](content))
  }, [message])
  return null
}

/** 懒加载页面的统一 fallback */
function PageFallback() {
  return (
    <div style={{ textAlign: 'center', padding: 120 }}>
      <Spin />
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 13 }}>
        页面加载中…
      </Typography.Text>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route
          index
          element={
            <Suspense fallback={<PageFallback />}>
              <Dashboard />
            </Suspense>
          }
        />
        <Route
          path="assets"
          element={
            <Suspense fallback={<PageFallback />}>
              <Assets />
            </Suspense>
          }
        />
        <Route
          path="datasets"
          element={
            <Suspense fallback={<PageFallback />}>
              <Datasets />
            </Suspense>
          }
        />
        <Route
          path="datasets/:id"
          element={
            <Suspense fallback={<PageFallback />}>
              <DatasetDetail />
            </Suspense>
          }
        />
        <Route
          path="runs"
          element={
            <Suspense fallback={<PageFallback />}>
              <Runs />
            </Suspense>
          }
        />
        <Route
          path="runs/metrics"
          element={
            <Suspense fallback={<PageFallback />}>
              <MetricsPage />
            </Suspense>
          }
        />
        <Route
          path="runs/:runId"
          element={
            <Suspense fallback={<PageFallback />}>
              <RunDetail />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={<PageFallback />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
