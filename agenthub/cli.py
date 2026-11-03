"""agenthub CLI —— 数据资产导入、数据集生产、数据供给、评测执行与闭环的全链路命令行。

用法示例：
    python -m agenthub.cli import traces.jsonl --source trace_import --tags v1
    python -m agenthub.cli dataset-create order-qa qa
    python -m agenthub.cli dataset-select order-qa --filters source=trace_import tag=退款
    python -m agenthub.cli dataset-publish order-qa --changelog "首批 50 条"
    python -m agenthub.cli pull order-qa@2 -o ds.jsonl
    python -m agenthub.cli eval order-qa@2 --target fake-agent --metrics order-agent-e2e --wait
    python -m agenthub.cli run-show RUN_ID --failures
    python -m agenthub.cli compare RUN_A RUN_B
    python -m agenthub.cli feedback RUN_ID --dataset order-qa --tags regression
    python -m agenthub.cli metrics list

连接参数：--base-url / --api-key（默认取环境变量 AGENTHUB_URL / AGENTHUB_API_KEY）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx

DEFAULT_BASE_URL = "http://localhost:8300"
POLL_INTERVAL = 1.0


class CliError(Exception):
    pass


# ---------- 基础设施 ----------


def _client(args: argparse.Namespace) -> httpx.Client:
    headers = {}
    if args.api_key:
        headers["X-API-Key"] = args.api_key
    return httpx.Client(base_url=args.base_url.rstrip("/") + "/api/v1", headers=headers, timeout=30.0)


def _request(c: httpx.Client, method: str, path: str, **kwargs) -> dict:
    try:
        r = c.request(method, path, **kwargs)
    except httpx.HTTPError as e:
        raise CliError(f"request failed: {c.base_url}{path} ({e})") from e
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", {}).get("message", r.text)
        except Exception:
            msg = r.text
        raise CliError(f"{method} {path} -> {r.status_code}: {msg}")
    body = r.json()
    return body.get("data", body)


def _emit(data) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


def _parse_filters(pairs: list[str] | None) -> dict:
    filters: dict = {}
    for p in pairs or []:
        k, _, v = p.partition("=")
        if not k or not v:
            raise CliError(f"invalid filter '{p}' (expected k=v)")
        filters[k] = v
    return filters


def _find_by_name(rows: list[dict], name: str, what: str) -> dict:
    for row in rows:
        if row.get("name") == name:
            return row
    raise CliError(f"{what} '{name}' not found")


def _resolve_dataset_version(c: httpx.Client, ref: str) -> tuple[str, str, int]:
    """'name' / 'name@N' -> (version_id, name, version)。"""
    name, _, ver = ref.rpartition("@")
    if not name:
        name, ver = ref, None
    versions = _request(c, "GET", f"/datasets/{name}/versions")
    rows = versions.get("items") or []
    if not rows:
        raise CliError(f"dataset '{name}' has no versions (publish first)")
    if ver is None:
        chosen = rows[0]  # 列表按 created_at desc，最新在前
    else:
        chosen = next((v for v in rows if v.get("version") == int(ver)), None)
        if not chosen:
            raise CliError(f"version {ver} not found for dataset '{name}'")
    return chosen["id"], name, chosen["version"]


# ---------- 子命令实现 ----------


def cmd_import(c: httpx.Client, ns: argparse.Namespace) -> dict:
    path = ns.file
    try:
        content = open(path, "rb").read()  # noqa: SIM115 — 一次性读取
    except OSError as e:
        raise CliError(f"cannot read file: {e}") from e
    r = c.post(
        "/assets/import",
        files={"file": (os.path.basename(path), content, "application/octet-stream")},
        data={"source": ns.source, "tags": ",".join(ns.tags)},
    )
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", {}).get("message", r.text)
        except Exception:
            msg = r.text
        raise CliError(f"import -> {r.status_code}: {msg}")
    return r.json().get("data", r.json())


def cmd_dataset_create(c: httpx.Client, ns: argparse.Namespace) -> dict:
    body = {"name": ns.name, "scene": ns.scene}
    if ns.description:
        body["description"] = ns.description
    return _request(c, "POST", "/datasets", json=body)


def cmd_dataset_select(c: httpx.Client, ns: argparse.Namespace) -> dict:
    filters = _parse_filters(ns.filters)
    if not filters:
        raise CliError("--filters 至少提供一个条件（如 source=trace_import tag=退款）")
    body = {"filters": filters, "skip_invalid": True}
    if ns.tags:
        body["tags"] = ns.tags
    return _request(c, "POST", f"/datasets/{ns.name}/items/from-assets", json=body)


def cmd_dataset_publish(c: httpx.Client, ns: argparse.Namespace) -> dict:
    body = {"changelog": ns.changelog or ""}
    return _request(c, "POST", f"/datasets/{ns.name}/versions", json=body)


def cmd_pull(c: httpx.Client, ns: argparse.Namespace) -> dict:
    sdk_dir = str(Path(__file__).resolve().parents[1] / "sdk")
    if sdk_dir not in sys.path:
        sys.path.insert(0, sdk_dir)  # 源码仓库布局下 agenthub_sdk 未安装
    from agenthub_sdk import AgentHub

    hub = AgentHub(base_url=args_base(c), api_key=c.headers.get("X-API-Key", ""), cache_dir=ns.cache_dir)
    try:
        ds = hub.pull(ns.ref)
    finally:
        hub.close()
    lines = json.dumps(ds.to_list(), ensure_ascii=False)
    if ns.output:
        with open(ns.output, "w", encoding="utf-8") as f:
            f.write(json.dumps(ds.to_list(), ensure_ascii=False, indent=2))
        return {"name": ds.name, "version": ds.version, "items": len(ds), "from_cache": ds.from_cache, "written": ns.output}
    return {"name": ds.name, "version": ds.version, "scene": ds.scene, "from_cache": ds.from_cache, "items": json.loads(lines)}


def args_base(c: httpx.Client) -> str:
    # httpx 内部 base_url 为 URL 对象
    return str(c.base_url).rsplit("/api/v1", 1)[0]


def cmd_eval(c: httpx.Client, ns: argparse.Namespace) -> dict:
    version_id, ds_name, ver = _resolve_dataset_version(c, ns.dataset_ref)
    target = _find_by_name(_request(c, "GET", "/targets"), ns.target, "target")
    mc = _find_by_name(_request(c, "GET", "/metric-configs"), ns.metrics, "metric config")

    run = _request(c, "POST", "/runs", json={
        "dataset_version_id": version_id,
        "target_id": target["id"],
        "metric_config_id": mc["id"],
        "agent_version": ns.agent_version or "",
    })
    run_id = run["id"]
    result: dict = {"run_id": run_id, "dataset": f"{ds_name}@{ver}", "target": ns.target, "metrics": ns.metrics}

    if not ns.wait:
        _request(c, "POST", f"/runs/{run_id}/start")
        result["status"] = "started"
        return result

    _request(c, "POST", f"/runs/{run_id}/start")
    deadline = time.time() + ns.timeout
    while True:
        cur = _request(c, "GET", f"/runs/{run_id}")
        status = cur.get("status")
        if status in {"done", "failed"}:
            result["status"] = status
            result["summary"] = cur.get("summary")
            if cur.get("error"):
                result["error"] = cur["error"]
            return result
        if time.time() > deadline:
            result["status"] = status
            result["note"] = f"timeout after {ns.timeout}s, poll GET /runs/{run_id} for final state"
            return result
        time.sleep(POLL_INTERVAL)


def cmd_run_show(c: httpx.Client, ns: argparse.Namespace) -> dict:
    run = _request(c, "GET", f"/runs/{ns.run_id}")
    if ns.failures:
        results = _request(c, "GET", f"/runs/{ns.run_id}/results", params={"passed": "false", "limit": ns.limit})
        run["failed_results"] = results.get("items", [])
    return run


def cmd_compare(c: httpx.Client, ns: argparse.Namespace) -> dict:
    return _request(c, "GET", f"/runs/{ns.run_a}/compare/{ns.run_b}")


def cmd_feedback(c: httpx.Client, ns: argparse.Namespace) -> dict:
    body: dict = {"tags": ns.tags}
    if ns.dataset:
        body["dataset"] = ns.dataset
    return _request(c, "POST", f"/runs/{ns.run_id}/feedback", json=body)


def cmd_metrics(c: httpx.Client, ns: argparse.Namespace) -> dict:
    return _request(c, "GET", "/metrics")


# ---------- 参数解析 ----------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="agenthub", description="AgentHub 数据中枢 CLI")
    p.add_argument("--base-url", default=os.environ.get("AGENTHUB_URL", DEFAULT_BASE_URL))
    p.add_argument("--api-key", default=os.environ.get("AGENTHUB_API_KEY", ""))
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("import", help="导入 JSONL 资产文件")
    sp.add_argument("file")
    sp.add_argument("--source", default="trace_import")
    sp.add_argument("--tags", nargs="*", default=[])
    sp.set_defaults(func=cmd_import)

    sp = sub.add_parser("dataset-create", help="创建数据集")
    sp.add_argument("name")
    sp.add_argument("scene")
    sp.add_argument("--description", default="")
    sp.set_defaults(func=cmd_dataset_create)

    sp = sub.add_parser("dataset-select", help="圈选资产转入数据集草稿")
    sp.add_argument("name")
    sp.add_argument("--filters", nargs="*", default=[], help="k=v 形式：source=/tag=/q=/type=")
    sp.add_argument("--tags", nargs="*", default=[])
    sp.set_defaults(func=cmd_dataset_select)

    sp = sub.add_parser("dataset-publish", help="发布新版本")
    sp.add_argument("name")
    sp.add_argument("--changelog", default="")
    sp.set_defaults(func=cmd_dataset_publish)

    sp = sub.add_parser("pull", help="拉取数据集快照（走 SDK，带本地缓存）")
    sp.add_argument("ref", help="name 或 name@version")
    sp.add_argument("-o", "--output", default=None)
    sp.add_argument("--cache-dir", default=None)
    sp.set_defaults(func=cmd_pull)

    sp = sub.add_parser("eval", help="对数据集版本发起托管评测")
    sp.add_argument("dataset_ref")
    sp.add_argument("--target", required=True, help="EvalTarget 名称")
    sp.add_argument("--metrics", required=True, help="MetricConfig 名称")
    sp.add_argument("--agent-version", default="")
    sp.add_argument("--wait", action=argparse.BooleanOptionalAction, default=True, help="阻塞等待完成（默认开）")
    sp.add_argument("--timeout", type=float, default=300.0)
    sp.set_defaults(func=cmd_eval)

    sp = sub.add_parser("run-show", help="查看 Run 状态与 summary")
    sp.add_argument("run_id")
    sp.add_argument("--failures", action="store_true", help="附带失败 case 明细")
    sp.add_argument("--limit", type=int, default=20)
    sp.set_defaults(func=cmd_run_show)

    sp = sub.add_parser("compare", help="对比两个 Run（回归/修复/指标差值）")
    sp.add_argument("run_a")
    sp.add_argument("run_b")
    sp.set_defaults(func=cmd_compare)

    sp = sub.add_parser("feedback", help="失败 case 回灌为资产，可选转入数据集草稿")
    sp.add_argument("run_id")
    sp.add_argument("--dataset", default=None, help="目标数据集名（可选）")
    sp.add_argument("--tags", nargs="*", default=[])
    sp.set_defaults(func=cmd_feedback)

    sp = sub.add_parser("metrics", help="指标相关命令")
    msub = sp.add_subparsers(dest="metrics_command", required=True)
    mlist = msub.add_parser("list", help="列出注册指标")
    mlist.set_defaults(func=cmd_metrics)

    return p


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows 控制台防 GBK 报错
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — capsys 等场景可能不支持
        pass
    ns = build_parser().parse_args(argv)
    c = _client(ns)
    try:
        result = ns.func(c, ns)
        _emit(result)
        return 0
    except CliError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        c.close()


if __name__ == "__main__":
    sys.exit(main())
