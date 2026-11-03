from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", env_prefix="AGENTHUB_", extra="ignore")

    db: str = "sqlite:///data/agenthub.db"
    data_dir: str = "./data/snapshots"
    api_key: str = ""  # 留空 = 开发模式，不校验

    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    cors_origins: str = "*"  # 逗号分隔的来源列表，供前端控制台跨域调用
    run_concurrency: int = 4  # 托管评测并发数：同时调用被测 Agent 的线程数
    run_retry: int = 1  # 单 case 网络失败自动重试次数（0 关闭）
    webhook_url: str = ""  # 评测完成事件推送地址（POST JSON），空则关闭


@lru_cache
def get_settings() -> Settings:
    return Settings()
