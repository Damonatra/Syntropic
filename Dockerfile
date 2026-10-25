FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY migrations ./migrations
COPY security ./security
COPY syntropic ./syntropic

RUN mkdir -p /app/outputs/uploads

EXPOSE 8000

CMD ["uvicorn", "syntropic.core.matching.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
