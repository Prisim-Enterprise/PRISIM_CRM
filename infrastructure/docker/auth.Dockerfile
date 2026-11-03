# Prisim CRM auth service (FastAPI) — multi-arch (Oracle Ampere ARM and x86)
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY apps/auth/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/auth/app app
RUN useradd --system --uid 1001 auth
USER auth
EXPOSE 4100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4100", "--proxy-headers", "--forwarded-allow-ips", "*"]
