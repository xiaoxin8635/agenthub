"""M3 数据供给：导出格式渲染与按名解析。"""
import json
from pathlib import Path

import yaml

from agenthub.db.models import Dataset, DatasetVersion

EXPORT_FORMATS = {"jsonl", "yaml", "hf"}

# expected 字段 → promptfoo assert type 的映射（仅单一标量字段可映射）
_ASSERT_FIELD = {"answer": "equals", "outcome": "equals", "final_answer": "equals", "tool": "equals"}


def _to_scalar(v):
    if isinstance(v, (str, int, float, bool)):
        return v
    return json.dumps(v, ensure_ascii=False)


def _promptfoo_doc(ds: Dataset, ver: DatasetVersion, items: list[dict]) -> dict:
    tests = []
    for it in items:
        case: dict = {"description": it["id"]}
        vars_ = {}
        for section in it.get("input") or {}, it.get("context") or {}:
            for k, v in section.items():
                vars_[k] = _to_scalar(v)
        if vars_:
            case["vars"] = vars_
        asserts = []
        for k, v in (it.get("expected") or {}).items():
            if k in _ASSERT_FIELD:
                asserts.append({"type": _ASSERT_FIELD[k], "value": _to_scalar(v)})
        if asserts:
            case["assert"] = asserts
        # 无损保留完整 item
        case["metadata"] = {
            "agenthub_id": it["id"],
            "input": it.get("input"),
            "expected": it.get("expected"),
            "context": it.get("context"),
            "tags": it.get("tags"),
            "source_asset_id": it.get("source_asset_id"),
        }
        tests.append(case)
    return {
        "description": f"{ds.name}@v{ver.version} (scene={ds.scene}) exported by AgentHub",
        "tests": tests,
    }


def _hf_doc(ver: DatasetVersion, items: list[dict]) -> dict:
    return {
        "dataset_name": ver.dataset_id,
        "version": ver.version,
        "splits": {
            "train": [
                {
                    "id": it["id"],
                    "input": it.get("input"),
                    "expected": it.get("expected"),
                    "context": it.get("context"),
                    "tags": it.get("tags"),
                    "source_asset_id": it.get("source_asset_id"),
                }
                for it in items
            ]
        },
    }


def render_export(ds: Dataset, ver: DatasetVersion, items: list[dict], format: str) -> tuple[bytes, str, str]:
    """返回 (content, media_type, filename)。items 顺序 = 快照顺序。"""
    if format == "jsonl":
        lines = "".join(
            json.dumps({
                "id": it["id"], "input": it.get("input"), "expected": it.get("expected"),
                "context": it.get("context"), "tags": it.get("tags"), "source_asset_id": it.get("source_asset_id"),
            }, ensure_ascii=False) + "\n"
            for it in items
        )
        return lines.encode("utf-8"), "application/x-ndjson", f"{ds.name}-v{ver.version}.jsonl"
    if format == "yaml":
        doc = _promptfoo_doc(ds, ver, items)
        content = yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, width=120)
        return content.encode("utf-8"), "application/yaml", f"{ds.name}-v{ver.version}.yaml"
    if format == "hf":
        content = json.dumps(_hf_doc(ver, items), ensure_ascii=False, indent=2)
        return content.encode("utf-8"), "application/json", f"{ds.name}-v{ver.version}.hf.json"
    raise ValueError(f"unsupported format: {format}")


def read_snapshot_items(snapshot_path: str) -> list[dict]:
    p = Path(snapshot_path)
    if not p.exists():
        raise FileNotFoundError(snapshot_path)
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
