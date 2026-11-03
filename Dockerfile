# 后端：FastAPI + SQLite（数据卷挂载 /app/data）
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agenthub ./agenthub

# 数据目录（SQLite + 快照文件统一落在数据卷）
ENV AGENTHUB_DB=sqlite:////app/data/agenthub.db \
    AGENTHUB_DATA_DIR=/app/data/snapshots
VOLUME /app/data
EXPOSE 8300

CMD ["python", "-m", "uvicorn", "agenthub.main:app", "--host", "0.0.0.0", "--port", "8300"]
