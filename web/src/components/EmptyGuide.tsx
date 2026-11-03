// 全站空状态引导（UI-105）：三步快速开始
import { Card, Empty, Steps } from 'antd'
import { Link } from 'react-router-dom'

export default function EmptyGuide() {
  return (
    <Card>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有数据，三步开启评测闭环" style={{ padding: '32px 0' }}>
        <Steps
          direction="vertical"
          size="small"
          current={-1}
          style={{ maxWidth: 420, textAlign: 'left' }}
          items={[
            {
              title: '上传数据资产',
              description: <Link to="/assets">前往数据资产页导入 JSONL →</Link>,
            },
            {
              title: '创建评测数据集',
              description: <Link to="/datasets">创建数据集、圈选资产并发布版本 →</Link>,
            },
            {
              title: '发起首次评测',
              description: <Link to="/runs">选择版本、Target 与指标组合，查看通过率 →</Link>,
            },
          ]}
        />
      </Empty>
    </Card>
  )
}
