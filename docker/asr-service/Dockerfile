FROM python:3.11-slim

WORKDIR /service
ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ffmpeg libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY service.py .
VOLUME ["/models"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD curl -fsS http://localhost:8000/health >/dev/null || exit 1

CMD ["python", "service.py"]
