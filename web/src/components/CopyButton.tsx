// 一键复制按钮（UI-502）：navigator.clipboard 优先，非安全上下文降级 execCommand
import { useState } from 'react'
import { Button } from 'antd'
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let okFlag = false
    try {
      okFlag = document.execCommand('copy')
    } catch {
      // 忽略：个别环境不支持
    }
    document.body.removeChild(ta)
    return okFlag
  }
}

export default function CopyButton({
  text,
  label = '复制',
  type = 'default',
}: {
  text: string
  label?: string
  type?: 'default' | 'primary' | 'text'
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="small"
      type={type}
      icon={copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
      onClick={async () => {
        if (await writeClipboard(text)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
      }}
    >
      {copied ? '已复制' : label}
    </Button>
  )
}
