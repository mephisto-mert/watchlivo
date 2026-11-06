FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py *.json ./
COPY static ./static

RUN rm -f /app/static/Watchlivo.exe /app/*.db \
    && mkdir -p /app/uploads \
    && useradd -m -u 10001 watchlivo \
    && chown -R watchlivo:watchlivo /app

USER watchlivo

EXPOSE 8080

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]
