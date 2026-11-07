# Build from the repo root: the image needs both api/ and quantum/.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1

WORKDIR /srv
COPY api/requirements.lock api/requirements.lock
RUN pip install --no-cache-dir --no-deps -r api/requirements.lock \
    && pip check

COPY quantum/ quantum/
COPY api/ api/
RUN rm -rf quantum/tests api/tests \
    && useradd --system --no-create-home casino
USER casino

# Cloud Run sets PORT. Client addresses are read in api/guards.py, not by uvicorn.
CMD ["sh", "-c", "exec uvicorn --factory api.main:create_app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-proxy-headers"]
