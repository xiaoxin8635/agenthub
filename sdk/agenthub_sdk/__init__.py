"""AgentHub SDK —— Agent 项目拉取评测数据集的最小客户端。

用法：
    from agenthub_sdk import AgentHub
    hub = AgentHub(base_url="http://localhost:8300", api_key="...")
    ds = hub.pull("order-agent-regression@3")   # 显式版本
    ds = hub.pull("order-agent-regression")     # 自动解析最新版
    for item in ds:
        output = my_agent(item.input)
"""
from dataclasses import dataclass, field
from pathlib import Path
import json

import httpx

__version__ = "0.1.0"


@dataclass
class Item:
    id: str
    input: dict
    expected: dict = field(default_factory=dict)
    context: dict = field(default_factory=dict)
    tags: list = field(default_factory=list)
    source_asset_id: str | None = None


@dataclass
class Dataset:
    name: str
    version: int
    scene: str | None
    items: list[Item]
    from_cache: bool = False

    def __iter__(self):
        return iter(self.items)

    def __len__(self):
        return len(self.items)

    def to_list(self) -> list[dict]:
        return [
            {
                "id": it.id, "input": it.input, "expected": it.expected,
                "context": it.context, "tags": it.tags, "source_asset_id": it.source_asset_id,
            }
            for it in self.items
        ]


class AgentHubError(Exception):
    pass


class AgentHub:
    def __init__(
        self,
        base_url: str = "http://localhost:8300",
        api_key: str = "",
        cache_dir: str | Path | None = None,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,  # 测试注入用
    ):
        self.base_url = base_url.rstrip("/")
        self.cache_dir = Path(cache_dir) if cache_dir else Path.home() / ".agenthub" / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        headers = {"X-API-Key": api_key} if api_key else {}
        self._http = httpx.Client(
            base_url=self.base_url + "/api/v1",
            headers=headers,
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    # ---------- 内部 ----------

    @staticmethod
    def _parse_ref(ref: str) -> tuple[str, int | None]:
        if "@" in ref:
            name, _, ver = ref.rpartition("@")
            if not name or not ver.isdigit():
                raise AgentHubError(f"invalid dataset ref: '{ref}' (expected 'name' or 'name@version')")
            return name, int(ver)
        return ref, None

    def _get(self, path: str, **kwargs) -> httpx.Response:
        try:
            r = self._http.get(path, **kwargs)
        except httpx.HTTPError as e:
            raise AgentHubError(f"request failed: {self.base_url}{path} ({e})") from e
        if r.status_code != 200:
            try:
                msg = r.json().get("error", {}).get("message", r.text)
            except Exception:
                msg = r.text
            raise AgentHubError(f"GET {path} -> {r.status_code}: {msg}")
        return r

    def resolve(self, ref: str) -> tuple[str, int]:
        """把 'name' / 'name@N' 解析为 (name, 具体版本号)。"""
        name, ver = self._parse_ref(ref)
        if ver is not None:
            return name, ver
        data = self._get(f"/supply/datasets/{name}/resolve").json()["data"]
        return name, data["latest_version"]

    def _cache_path(self, name: str, version: int) -> Path:
        return self.cache_dir / f"{name}-v{version}.jsonl"

    @staticmethod
    def _load_jsonl(path: Path) -> list[Item]:
        items = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            obj = json.loads(line)
            items.append(Item(
                id=obj["id"], input=obj.get("input") or {}, expected=obj.get("expected") or {},
                context=obj.get("context") or {}, tags=obj.get("tags") or [],
                source_asset_id=obj.get("source_asset_id"),
            ))
        return items

    # ---------- 公开 API ----------

    def pull(self, ref: str, use_cache: bool = True) -> Dataset:
        """拉取数据集快照。显式版本 + 缓存命中时不发网络请求（版本不可变）。"""
        name, ver = self._parse_ref(ref)
        explicit = ver is not None
        if not explicit:
            name, ver = self.resolve(ref)

        cache = self._cache_path(name, ver)
        if use_cache and cache.exists():
            scene = None
            if not explicit:  # 走了 resolve，顺带补 scene
                try:
                    scene = self._get(f"/supply/datasets/{name}/resolve").json()["data"]["scene"]
                except AgentHubError:
                    pass
            return Dataset(name=name, version=ver, scene=scene, items=self._load_jsonl(cache), from_cache=True)

        r = self._get(f"/datasets/{name}/versions/{ver}/export", params={"format": "jsonl"})
        cache.write_bytes(r.content)
        # 显式版本时服务端未告知 scene，再查一次（可容忍失败）
        scene = None
        try:
            scene = self._get(f"/supply/datasets/{name}/resolve").json()["data"]["scene"]
        except AgentHubError:
            pass
        return Dataset(name=name, version=ver, scene=scene, items=self._load_jsonl(cache), from_cache=False)
