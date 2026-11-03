// 全局布局（06 文档第 3 节）：左侧固定导航 220px 可折叠 + 顶部面包屑 + 内容区最大 1440px
import { useState } from 'react'
import { Breadcrumb, Layout, Menu } from 'antd'
import {
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Link, Outlet, useLocation } from 'react-router-dom'
import GlobalSearch from '../components/GlobalSearch'

const { Sider, Header, Content } = Layout

const MENU_ITEMS = [
  { key: '/', icon: <DashboardOutlined />, label: <Link to="/">仪表盘</Link> },
  { key: '/assets', icon: <DatabaseOutlined />, label: <Link to="/assets">数据资产</Link> },
  { key: '/datasets', icon: <FolderOpenOutlined />, label: <Link to="/datasets">评测数据集</Link> },
  {
    key: 'runs-menu',
    icon: <ExperimentOutlined />,
    label: '评测中心',
    children: [
      { key: '/runs', label: <Link to="/runs">评测任务</Link> },
      { key: '/runs/metrics', label: <Link to="/runs/metrics">指标与目标</Link> },
    ],
  },
  { key: '/settings', icon: <SettingOutlined />, label: <Link to="/settings">设置</Link> },
]

const BREADCRUMB_LABELS: Record<string, string> = {
  assets: '数据资产',
  datasets: '评测数据集',
  runs: '评测任务',
  metrics: '指标与目标',
  settings: '设置',
}

export default function MainLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const { pathname } = useLocation()
  const parts = pathname.split('/').filter(Boolean)
  const breadcrumb = [
    { title: parts.length === 0 ? '仪表盘' : <Link to="/">首页</Link> },
    ...parts.map((p) => ({ title: BREADCRUMB_LABELS[p] ?? p })),
  ]
  // 详情页（如 /datasets/:id）高亮所属一级菜单；评测中心展开子菜单并精确高亮
  const selectedKey =
    parts[0] === 'runs' && parts[1] === 'metrics' ? '/runs/metrics' : parts.length > 0 ? `/${parts[0]}` : '/'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        theme="light"
        width={220}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        style={{ borderRight: '1px solid #f0f0f0' }}
      >
        <div className="sider-logo">
          <span className="logo-badge">AH</span>
          {!collapsed && (
            <div style={{ lineHeight: 1.3 }}>
              <div style={{ fontWeight: 600 }}>AgentHub</div>
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>评测数据中枢</div>
            </div>
          )}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={['runs-menu']}
          items={MENU_ITEMS}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header className="top-header">
          <Breadcrumb items={breadcrumb} />
          <div style={{ marginLeft: 'auto' }}>
            <GlobalSearch />
          </div>
        </Header>
        <Content style={{ padding: 24 }}>
          <div style={{ maxWidth: 1440, margin: '0 auto' }}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
