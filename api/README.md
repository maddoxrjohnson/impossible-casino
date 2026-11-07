# The Impossible Casino API

FastAPI service for live Qiskit runs. The game plays fully without it: the client falls back to the exported results on any failure.

| Route | Purpose |
| --- | --- |
| `GET /health` | Wake-up ping. No quantum work. It answers once the noise models are built. |
| `POST /v1/chsh` `{dial}` | A live CHSH run. The dial must be on the exported grid. |
| `POST /v1/wiesner` `{length}` | A live forgery run, length 1 to 8. |
| `POST /v1/chip/run` `{passphrase}` | The chip gate. It enforces the mode, passphrase and rate limit, then answers 501: submission is not built yet. |

Every run is a noisy Aer simulation with a fresh seed, using the stored `fake_kingston` calibration, and is labelled `live-simulator`.

The ping is not `/healthz`: Cloud Run's front end reserves some paths ending in `z`, and that request never reaches the container.

## Run locally

```sh
uv pip install --python .venv/bin/python --no-deps -r api/requirements.lock
uv pip install --python .venv/bin/python 'httpx==0.28.1'
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
| `RUN_LIMIT_PER_MINUTE` | 20 | Runs per client per instance. A real player tops out near 18. |
| `RUN_CAP_PER_HOUR` | 12000 | Runs per instance across all clients, for a room of players. Past it, 429 until the hour ends. |
| `CHIP_LIMIT_PER_MINUTE` | 5 | Chip gate calls per client per instance. |
| `MAX_CLIENTS` | 10000 | Clients each rate limiter remembers. |
| `MAX_BODY_BYTES` | 1024 | Larger bodies get 413. |
| `MAX_CONCURRENT_RUNS` | 1 | Runs past this get 503 at once. Nothing queues. |

Cloud Run sets `K_SERVICE`, which is what turns on reading the client address from `X-Forwarded-For`.

## Deploy

The image builds from the repo root with Cloud Build, because `api/Dockerfile` needs both `api/` and `quantum/`. It installs exact versions from `api/requirements.lock`. Run these from the repo root.

One-time setup. `compute.googleapis.com` creates the default service account the next step names, and it can take a minute to appear:

```sh
PROJECT=$(gcloud config get-value project)
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud services enable compute.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$NUMBER-compute@developer.gserviceaccount.com" \
  --role=roles/cloudbuild.builds.builder

gcloud artifacts repositories create impossible-casino \
  --repository-format=docker --location=us-east1
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
  --concurrency=2 \
  --cpu-boost \
  --timeout=30 \
  --allow-unauthenticated \
  --set-env-vars=LIVE_CHIP_MODE=off
```

`--allow-unauthenticated` is needed because browsers call it directly. `--concurrency=2` leaves room for a ping or preflight beside the one run an instance takes at a time.

### Check it reached the app

```sh
URL=$(gcloud run services describe impossible-casino-api --region=us-east1 --format='value(status.url)')
curl -i "$URL/health"
```

Expect `HTTP/2 200`, `content-type: application/json` and exactly `{"status":"ok"}`. An HTML page or a 404 came from Google's front end, not the app.

### Point the site at it

Vite inlines `VITE_API_URL` at build time, so setting the variable changes nothing until the site is rebuilt, and the site stays pre-run with no error. From `web/`, check on a preview first:

```sh
vercel env add VITE_API_URL preview
vercel pull --yes --environment=preview
vercel build --target=preview
vercel deploy --prebuilt --target=preview
```

A live run on that preview reads "Live Qiskit simulator" on the source label. Repeat with `production` once it does.

### Before chip runs

With `LIVE_CHIP_MODE=off` the service needs no secret. Before setting `LIVE_CHIP_MODE=owner`, create the passphrase, grant the runtime access, and redeploy with it. `owner` mode refuses to start without it.

```sh
PROJECT=$(gcloud config get-value project)
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud services enable secretmanager.googleapis.com

read -rs PASSPHRASE
printf '%s' "$PASSPHRASE" | gcloud secrets create chip-passphrase --data-file=-
unset PASSPHRASE

gcloud secrets add-iam-policy-binding chip-passphrase \
  --member="serviceAccount:$NUMBER-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Then add `--set-env-vars=LIVE_CHIP_MODE=owner --set-secrets=CHIP_PASSPHRASE=chip-passphrase:latest` to the deploy command in place of the `LIVE_CHIP_MODE=off` line.

## Cost

Nothing here caps spending. The budget alert only sends an email. Max instances, the rate limits and the hourly cap limit how fast money can be spent, and they do not stop it.

The figures below are estimates to confirm against the current Google Cloud price list.

- Normal traffic should sit inside Cloud Run's and Cloud Build's free tiers.
- The image in Artifact Registry should cost cents a month.
- Two instances kept busy all day should cost about $5 a day, which would use a $20 budget in about four days.

## Kill it

```sh
gcloud run services delete impossible-casino-api --region=us-east1
```

Deleting the service is safe. The site falls back to its exported results and keeps working, labelled pre-run. To bring it back, run the deploy command again.
