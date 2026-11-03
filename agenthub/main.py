from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from agenthub.config import get_settings
from agenthub.dependencies import require_api_key
from agenthub.routers import assets, datasets, runs, settings, stats, supply, targets
from agenthub.schemas.common import http_exception_handler, ok, validation_exception_handler


@asynccontextmanager
async def lifespan(_: FastAPI):
    from agenthub.db.base import init_db

    init_db()
    yield


app = FastAPI(title="AgentHub", version="0.1.0", description="面向 Agent 评测的轻量数据中枢", lifespan=lifespan)

app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)

_origins = [o.strip() for o in get_settings().cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/v1/health")
def health():
    return ok({"status": "up"})


app.include_router(assets.router, dependencies=[Depends(require_api_key)])
app.include_router(datasets.router, dependencies=[Depends(require_api_key)])
app.include_router(supply.router, dependencies=[Depends(require_api_key)])
app.include_router(targets.router, dependencies=[Depends(require_api_key)])
app.include_router(runs.router, dependencies=[Depends(require_api_key)])
app.include_router(stats.router, dependencies=[Depends(require_api_key)])
app.include_router(settings.router, dependencies=[Depends(require_api_key)])
