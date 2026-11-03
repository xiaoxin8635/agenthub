// 全站统一徽标文案与配色（06 文档第 6 节视觉规范）
import { Tag } from 'antd'

export const ASSET_TYPE_META: Record<string, { label: string; color: string }> = {
  dialog: { label: '对话', color: 'geekblue' },
  trace: { label: '轨迹', color: 'purple' },
  tool_log: { label: '工具日志', color: 'cyan' },
  doc: { label: '文档', color: 'orange' },
  custom: { label: '自定义', color: 'default' },
}

export const ASSET_SOURCE_META: Record<string, { label: string; color: string }> = {
  manual: { label: '手工创建', color: 'default' },
  trace_import: { label: 'Trace 导入', color: 'blue' },
  badcase_feedback: { label: 'Badcase 回灌', color: 'red' },
}

export function TypeTag({ type }: { type: string }) {
  const m = ASSET_TYPE_META[type] ?? { label: type, color: 'default' }
  return <Tag color={m.color}>{m.label}</Tag>
}

export function SourceTag({ source }: { source: string }) {
  const m = ASSET_SOURCE_META[source] ?? { label: source, color: 'default' }
  return <Tag color={m.color}>{m.label}</Tag>
}

/** 评测场景（与后端 agenthub/schemas/scenes.py 的 SCENES 对齐） */
export const SCENE_META: Record<string, { label: string; color: string; desc: string; schema: string }> = {
  qa: {
    label: 'QA 问答',
    color: 'blue',
    desc: '单轮问答',
    schema: 'input:{question} · expected:{answer}',
  },
  rag: {
    label: 'RAG 检索问答',
    color: 'purple',
    desc: '带检索上下文的问答',
    schema: 'input:{question} · context:{passages[]} · expected:{answer}',
  },
  tool_call: {
    label: '工具调用',
    color: 'cyan',
    desc: '用户意图 → 工具与参数',
    schema: 'input:{utterance} · context:{available_tools[]} · expected:{tool, args}',
  },
  multi_turn: {
    label: '多轮对话',
    color: 'geekblue',
    desc: '多轮对话收尾能力',
    schema: 'input:{turns[{role, content}]} · expected:{final_answer}',
  },
  trajectory: {
    label: '任务轨迹',
    color: 'orange',
    desc: '任务级执行与工具约束',
    schema: 'input:{task} · context:{available_tools[], max_steps} · expected:{outcome, must/not_call_tools[]}',
  },
}

export function SceneTag({ scene }: { scene: string }) {
  const m = SCENE_META[scene] ?? { label: scene, color: 'default', desc: '', schema: '' }
  return <Tag color={m.color}>{m.label}</Tag>
}
