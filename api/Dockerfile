# Build from the repo root: the image needs both api/ and quantum/.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1

RUN pip install --no-cache-dir \
    fastapi==0.162.2 \
    starlette==1.10.0 \
    uvicorn==0.54.0 \
    qiskit==2.6.2 \
    qiskit-aer==0.18.2 \
    qiskit-ibm-runtime==0.51.0

WORKDIR /srv
COPY quantum/ quantum/
COPY api/ api/
RUN rm -rf quantum/tests api/tests \
    && useradd --system --no-create-home casino
USER casino

# Cloud Run sets PORT. Client addresses are read in api/guards.py, not by uvicorn.
CMD ["sh", "-c", "exec uvicorn --factory api.main:create_app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-proxy-headers"]
