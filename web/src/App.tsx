import { useEffect } from 'react'
import { App as AntApp } from 'antd'
import { Navigate, Route, Routes } from 'react-router-dom'
import { setNotifier } from './api/client'
import MainLayout from './layouts/MainLayout'
import Dashboard from './pages/Dashboard'
import Assets from './pages/Assets'
import Datasets from './pages/Datasets'
import DatasetDetail from './pages/DatasetDetail'
import Runs from './pages/Runs'
import RunDetail from './pages/RunDetail'
import MetricsPage from './pages/MetricsPage'
import SettingsPage from './pages/SettingsPage'

/** 将 antd message 注入请求层（client.ts 不依赖 React） */
export function Bridge() {
  const { message } = AntApp.useApp()
  useEffect(() => {
    setNotifier((content, type) => message[type](content))
  }, [message])
  return null
}

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="assets" element={<Assets />} />
        <Route path="datasets" element={<Datasets />} />
        <Route path="datasets/:id" element={<DatasetDetail />} />
        <Route path="runs" element={<Runs />} />
        <Route path="runs/metrics" element={<MetricsPage />} />
        <Route path="runs/:runId" element={<RunDetail />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
