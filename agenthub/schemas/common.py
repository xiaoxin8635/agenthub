"""统一响应封装：{code, data} / {code, error}。"""
from typing import Any

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


def ok(data: Any = None) -> dict:
    return {"code": 0, "data": data}


def fail(code: int, message: str) -> dict:
    return {"code": code, "error": {"message": message}}


async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=fail(exc.status_code, str(exc.detail)))


async def validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    msg = "; ".join(f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors())
    return JSONResponse(status_code=422, content=fail(422, msg))
