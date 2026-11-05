# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

AgentHub — 面向 Agent 评测的轻量数据中枢。核心闭环：导入数据资产 → 圈选生产评测数据集 → 发布不可变版本 → 发起评测（HTTP 托管 / External 回传）→ 失败 case 回灌形成下一轮回归。设计文档在 `docs/`（00-需求 ~ 07-使用指南），其中 `docs/03-数据模型与API设计.md` 是表结构与 API 的权威参考。

技术栈：后端 Python 3.11 / FastAPI / SQLAlchemy 2 / SQLite（零外部依赖）/ Pydantic v2；前端 React 18 / TypeScript / Vite / Ant Design 5 / ECharts 5；另有 Python SDK（`sdk/agenthub_sdk`）与 CLI（`python -m agenthub.cli`）。

## 常用命令

```bash
# 后端（端口 8300）
pip install -r requirements.txt
python -m uvicorn agenthub.main:app --port 8300

# 前端（端口 5173，vite 将 /api 代理到 127.0.0.1:8300）
cd web && npm install && npm run dev

# 测试
pytest                                  # 后端全部用例
pytest tests/test_eval.py               # 单文件
pytest tests/test_eval.py::test_xxx     # 单用例
cd web && npx tsc --noEmit              # 前端类型检查（无独立 lint）

# Docker 一键部署（nginx 托管前端并反代 /api，端口 8080）
docker compose up -d --build
```

CI（`.github/workflows/`）跑两件事：`python -m pytest -q` 和前端 `npx tsc --noEmit` + `npm run build`。没有 Python linter 配置。

## 后端架构（agenthub/）

分层：`routers/`（FastAPI 路由，薄）→ `services/`（业务逻辑）→ `db/models.py`（SQLAlchemy ORM）。所有主键是 26 位可排序 ULID（`new_id()`）。

- **API 约定**：统一前缀 `/api/v1`；所有 router 挂 `Depends(require_api_key)`（`AGENTHUB_API_KEY` 为空 = 开发模式不校验）；响应统一用 `schemas/common.py` 的 `ok()` 包装为 `{data: ...}`，错误为 `{error: {message}}`。
- **数据流三层模型**：`Asset`（原始资产，`content_hash` 指纹去重）→ `Dataset`/`DatasetItem`（草稿，`version_id` 为 NULL）→ `DatasetVersion`（发布时写不可变 JSONL 快照到 `AGENTHUB_DATA_DIR`，`snapshot_path` 指向文件）。评测永远绑定版本快照而非草稿。
- **指标插件体系**（`metrics/`）：`base.py` 定义 `Metric` Protocol + `@register` 装饰器注册表。指标类型是带前缀的字符串：`rule:*`（exact/contains/json_schema，纯函数离线跑）、`judge:*`（LLM Judge，OpenAI 兼容接口）、`rag:*`、`traj:*`。新增指标 = 写一个带 `name` 和 `evaluate(item, output, spec) -> MetricScore` 的类并 `@register`，`metrics/__init__.py` 的 import 副作用完成注册。`MetricConfig.metrics` 存加权 spec 列表 `[{"type": "rule:exact", "actual": "answer", "expected_path": "expected.answer", "weight": 1}, ...]`。分数 `None` 表示 N/A（无法评估），不参与通过判定与加权。
- **评测两种模式**：
  - HTTP 托管：`runners/http_runner.py` 在**后台线程**（ThreadPoolExecutor，并发数 `AGENTHUB_RUN_CONCURRENCY`）逐条调 Agent 端点、算分、落库；网络失败按 `AGENTHUB_RUN_RETRY` 重试。
  - External 回传：外部 Agent 调 `POST /runs/{id}/results` 逐条回传，收齐后自动 `finalize_run` 聚合。
  - 两者共用 `services/eval_service.py` 的 `evaluate_item` / `compute_summary`（逐指标 avg/pass_rate + 加权总分 weighted_total）。完成时经 `services/notify.py` 推 webhook。
- **后台线程的数据库访问**：http_runner 和 `services/generator.py`（AI 生成评测集：文档切片 → LLM 出题 → MD5 + 3-gram Jaccard 去重 → 入资产）都在后台线程开独立 Session（`SessionLocal`），不与请求共享。
- **配置**：`config.py` 用 pydantic-settings，环境变量前缀 `AGENTHUB_`（见 `.env.example`），`get_settings()` 是 `lru_cache` 单例。

## 前端架构（web/src/）

- 页面在 `App.tsx` 全部 `lazy()` 路由级代码分割；布局在 `layouts/MainLayout`。
- `api/client.ts` 是唯一请求层（不依赖 React）；antd message 通过 `setNotifier` 桥接注入（见 `App.tsx` 的 `Bridge`）。
- vite dev server 全响应带 `no-store`（防旧模块缓存）；构建时 react/antd/echarts 手动分包。

## 测试关键约定（tests/conftest.py）

- 测试库用**临时文件 SQLite** 而非内存库：Runner 后台线程与 HTTP 请求需要各自独立连接，单连接 StaticPool 会互相回滚事务。改测试基建时必须保留这一点。
- **不要** `from tests.conftest import ...`（tests/ 无 `__init__.py`，会创建第二个 conftest 模块实例指向另一个空库）；需要 Session 工厂时用 `session_factory` fixture。
- autouse fixture `_isolated_llm_judge` 清空 LLM 配置：单测不依赖外网 LLM，judge 指标在测试中应记 N/A。
- 测试默认带 `X-API-Key: test-key`（conftest 顶部设置）。

## 约定

- 代码注释、文档、控制台文案均为中文优先；技术术语保留英文。
- 后端 docstring 风格：模块/函数首行中文一句话说明职责与关键行为。
- `data/`（SQLite 与版本快照）是运行时产物，不入库。
