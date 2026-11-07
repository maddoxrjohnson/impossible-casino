# The Impossible Casino API

FastAPI service for live Qiskit runs. The game plays fully without it: the client falls back to the exported results on any failure.

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Wake-up ping. No quantum work. It answers once the noise models are built. |
| `POST /v1/chsh` `{dial}` | A live CHSH run. The dial must be on the exported grid. |
| `POST /v1/wiesner` `{length}` | A live forgery run, length 1 to 8. |
| `POST /v1/chip/run` `{passphrase}` | The chip gate. It enforces the mode, passphrase and rate limit, then answers 501: submission is not built yet. |

Every run is a noisy Aer simulation with a fresh seed, using the stored `fake_kingston` calibration, and is labelled `live-simulator`.

## Run locally

```sh
uv pip install --python .venv/bin/python 'fastapi==0.162.2' 'uvicorn==0.54.0' 'httpx==0.28.1'
.venv/bin/python -m uvicorn --factory api.main:create_app --port 8081
.venv/bin/python -m pytest api/tests
```

Point the web client at it with `VITE_API_URL=http://localhost:8081 npm run dev`.

## Settings

All are environment variables, read once at startup. A bad value stops the service from starting.

| Name | Default | Meaning |
| --- | --- | --- |
| `LIVE_CHIP_MODE` | `off` | `owner`, `public` or `off`. `owner` needs `CHIP_PASSPHRASE`. |
| `CHIP_PASSPHRASE` | none | Checked by the chip gate in `owner` mode. |
| `CORS_ORIGINS` | production site | Comma-separated full origins. Replaces the default. Previews and localhost ports are matched separately. |
| `RUN_LIMIT_PER_MINUTE` | 60 | Runs per client per instance. |
| `CHIP_LIMIT_PER_MINUTE` | 5 | Chip gate calls per client per instance. |
| `MAX_CLIENTS` | 10000 | Clients each rate limiter remembers. |
| `MAX_BODY_BYTES` | 1024 | Larger bodies get 413. |
| `MAX_CONCURRENT_RUNS` | 2 | Runs past this get 503 at once. Nothing queues. |

Cloud Run sets `K_SERVICE`, which is what turns on reading the client address from `X-Forwarded-For`.

## Deploy

The image builds from the repo root with Cloud Build, because `api/Dockerfile` needs both `api/` and `quantum/`. Run these from the repo root.

One-time setup:

```sh
PROJECT=$(gcloud config get-value project)
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

gcloud artifacts repositories create impossible-casino \
  --repository-format=docker --location=us-east1

read -rs PASSPHRASE
printf '%s' "$PASSPHRASE" | gcloud secrets create chip-passphrase --data-file=-
unset PASSPHRASE

gcloud secrets add-iam-policy-binding chip-passphrase \
  --member="serviceAccount:$NUMBER-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Each deploy:

```sh
PROJECT=$(gcloud config get-value project)
IMAGE=us-east1-docker.pkg.dev/$PROJECT/impossible-casino/api:$(git rev-parse --short HEAD)

gcloud builds submit . \
  --config=api/cloudbuild.yaml \
  --ignore-file=api/.gcloudignore \
  --substitutions=_IMAGE="$IMAGE"

gcloud run deploy impossible-casino-api \
  --image="$IMAGE" \
  --region=us-east1 \
  --min-instances=0 \
  --max-instances=2 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=8 \
  --cpu-boost \
  --timeout=30 \
  --allow-unauthenticated \
  --set-env-vars=LIVE_CHIP_MODE=off \
  --set-secrets=CHIP_PASSPHRASE=chip-passphrase:latest
```

Then set `VITE_API_URL` on the Vercel project to the service URL. `--allow-unauthenticated` is needed because browsers call it directly.
