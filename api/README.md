# The Impossible Casino API

FastAPI service for live Qiskit runs. The game plays fully without it: the client falls back to the exported results on any failure.

| Route | Purpose |
| --- | --- |
| `GET /health` | Wake-up ping. No quantum work. It answers once the noise models are built. |
| `POST /v1/chsh` `{dial}` | A live CHSH run. The dial must be on the exported grid. |
| `POST /v1/wiesner` `{length}` | A live forgery run, length 1 to 8. |
| `POST /v1/chip/run` `{passphrase}` | One press: CHSH at dial 0.5 on `ibm_kingston`, 1024 shots per question pair. Behind the gate and the spending limits below. Answers at once with `{status: "queued", jobId, backend}`. |
| `GET /v1/chip/run/{jobId}` | Poll a press. No passphrase. `queued`, `running`, `cancelled` or `error` carry no numbers. `done` carries `result`, a CHSH result labeled `ibm-chip` with the job id, chip, qubits and date. Only jobs tagged `impossible-casino-live` are served; any other id is 404. Finished answers are kept in memory, and a waiting status is reused for 5 s. |

Every run on the other routes is a noisy Aer simulation with a fresh seed, using the stored `fake_kingston` calibration, and is labeled `live-simulator`.

### Chip presses

The service keeps no state between requests that it relies on. IBM does: every press is tagged `impossible-casino-live`, plus `qubits-A-B` naming the pair the day's calibration picked and `dial-0.5`, so any instance can count and serve them. A press is refused, in this order, before anything is submitted:

1. The gate: the mode and the passphrase (403).
2. One of our tagged jobs is still queued or running (409). The answer carries its `jobId`, so a press whose first answer was lost can follow the job it already started.
3. Any other job on the account is queued or running, such as a Cage run from the command line (409). IBM's usage figure leaves those out, so the budget check below could not see them.
4. `CHIP_PRESSES_PER_DAY` tagged jobs were created in the last 24 hours (429).
5. IBM's `usage_remaining_seconds`, less `CHIP_MAX_SECONDS`, would fall below `CHIP_RESERVE_SECONDS` (409). A missing figure counts as none left.

Within an instance, a second press waits for the first to finish submitting, then meets check 2. Across instances the checks can race: two instances can each pass check 2 in the same second, and each can see 11 of 12 presses used, so the daily cap can be passed by one press per instance.

IBM cancels a job past `CHIP_MAX_SECONDS` of chip time. The recorded jobs billed about 1.6 s each plus 0.27 ms per shot: the 16,384-shot pilot billed 6 s and the 147,456-shot Tables run 41 s. A press is 4,096 shots, so it should bill about 3 s. IBM's error text never reaches a response or a log, only its type. If the IBM client cannot be built, presses and polls get 502 for a minute before it tries again.

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
| `LIVE_CHIP_MODE` | `off` | `owner`, `public` or `off`. `owner` needs `CHIP_PASSPHRASE`. `owner` and `public` need `IBM_QUANTUM_TOKEN`. |
| `CHIP_PASSPHRASE` | none | Checked by the chip gate in `owner` mode. |
| `IBM_QUANTUM_TOKEN` | none | IBM Cloud API key, from Secret Manager only. Surrounding whitespace is stripped, and a blank one counts as none. Never logged or answered. |
| `IBM_QUANTUM_INSTANCE` | `open-instance` | IBM Quantum instance the jobs run and bill under. |
| `CHIP_MAX_SECONDS` | 10 | Chip-time cap on each press. |
| `CHIP_PRESSES_PER_DAY` | 12 | Tagged jobs allowed in any 24 hours, across all instances. |
| `CHIP_RESERVE_SECONDS` | 300 | Chip time a press must leave untouched, kept for the Cage run. |
| `CHIP_POLL_LIMIT_PER_MINUTE` | 30 | Polls per client per instance. A poll the cache cannot answer is two IBM calls. |
| `CHIP_POLL_CAP_PER_MINUTE` | 120 | Polls per instance, across all clients. |
| `CORS_ORIGINS` | production site | Comma-separated full origins. Replaces the default. Previews and localhost ports are matched separately. |
| `RUN_LIMIT_PER_MINUTE` | 20 | Runs per client address per instance. A real player tops out near 18, or more if they also forge. Everyone behind one address shares it, so past the limit a room on one network gets pre-run results, labeled as such, until the minute resets. |
| `RUN_CAP_PER_HOUR` | 12000 | Requests that reach a run, per instance, across all clients. Past it, 429 until the hour ends. It binds CHSH runs but not Wiesner runs, which are too slow to reach it, so it does not bound compute cost. |
| `CHIP_LIMIT_PER_MINUTE` | 5 | Presses, right or wrong, per client per instance. |
| `MAX_CLIENTS` | 10000 | Clients each rate limiter remembers. |
| `MAX_BODY_BYTES` | 1024 | Larger bodies get 413. |
| `MAX_CONCURRENT_RUNS` | 1 | Runs past this get 503 at once. Nothing queues. |

Cloud Run sets `K_SERVICE`, which is what turns on reading the client address from `X-Forwarded-For`.

## Deploy

The image builds from the repo root with Cloud Build, because `api/Dockerfile` needs both `api/` and `quantum/`. It installs exact versions from `api/requirements.lock`. Run these from the repo root.

One-time setup. `compute.googleapis.com` creates the default service account that runs builds:

```sh
PROJECT=$(gcloud config get-value project)

gcloud services enable compute.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com

gcloud iam service-accounts create casino-api-runtime \
  --display-name="Impossible Casino API runtime"

gcloud artifacts repositories create impossible-casino \
  --repository-format=docker --location=us-east1
```

Builds run as the default compute account, which holds `roles/editor` on this project, so no extra grant is needed. If a project's default account has no such role, grant it `roles/cloudbuild.builds.builder`. The service runs as `casino-api-runtime`, which has no roles, so a compromised container cannot use that access.

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
  --service-account="casino-api-runtime@$PROJECT.iam.gserviceaccount.com" \
  --region=us-east1 \
  --min-instances=0 \
  --max-instances=2 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=2 \
  --cpu-boost \
  --timeout=30 \
  --allow-unauthenticated \
  --set-env-vars=LIVE_CHIP_MODE=off,RUN_LIMIT_PER_MINUTE=60
```

`--allow-unauthenticated` is needed because browsers call it directly. `--concurrency=2` leaves room for a ping or preflight beside the one run an instance takes at a time.

### Check it reached the app

```sh
URL=$(gcloud run services describe impossible-casino-api --region=us-east1 --format='value(status.url)')
curl -i "$URL/health"
```

Expect `HTTP/2 200`, `content-type: application/json` and exactly `{"status":"ok"}`. An HTML page or a 404 came from Google's front end, not the app.

Then time the slowest run, twice, so the first does not measure a cold start:

```sh
for i in 1 2; do
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -X POST "$URL/v1/wiesner" \
    -H 'content-type: application/json' -d '{"length":8}'
done
```

The client gives up at 1.5 s. If the second run is near that, length 8 forges will mostly fall back to pre-run.

### Point the site at it

Vite inlines `VITE_API_URL` at build time, so setting the variable changes nothing until the site is rebuilt, and the site stays pre-run with no error. Run these from `web/` in a checkout linked to the Vercel project, which has `web/.vercel`. `vercel env add` asks for the value: give it the `$URL` from the step above, and answer its branch prompt with all preview branches.

```sh
vercel env add VITE_API_URL preview
vercel pull --yes --environment=preview
vercel build --target=preview --yes
vercel deploy --prebuilt --yes --target=preview
```

A live run on that preview reads "Live Qiskit simulator" on the source label. Doing the same for `production` replaces the live site, so treat it as a separate release step.

### Before chip runs

With `LIVE_CHIP_MODE=off` the service needs no secret. Before setting `LIVE_CHIP_MODE=owner`, create the passphrase and the IBM token as secrets, grant the runtime access to both, and redeploy with them. `owner` mode refuses to start without either. On this project both secrets exist and the runtime can read them, so only the deploy below is left; the secret steps are for a fresh project.

```sh
PROJECT=$(gcloud config get-value project)

gcloud services enable secretmanager.googleapis.com

printf 'Chip passphrase: '; read -rs PASSPHRASE; echo
printf '%s' "$PASSPHRASE" | gcloud secrets create chip-passphrase --data-file=-
unset PASSPHRASE

gcloud secrets add-iam-policy-binding chip-passphrase \
  --member="serviceAccount:casino-api-runtime@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

The IBM token is the same, as `ibm-quantum-token`:

```sh
printf 'IBM Quantum API key: '; read -rs TOKEN; echo
printf '%s' "$TOKEN" | gcloud secrets create ibm-quantum-token --data-file=-
unset TOKEN

gcloud secrets add-iam-policy-binding ibm-quantum-token \
  --member="serviceAccount:casino-api-runtime@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Then build and deploy with chip presses on. This is the whole command; it replaces the deploy above:

```sh
PROJECT=$(gcloud config get-value project)
IMAGE=us-east1-docker.pkg.dev/$PROJECT/impossible-casino/api:$(git rev-parse --short HEAD)

gcloud builds submit . \
  --config=api/cloudbuild.yaml \
  --ignore-file=api/.gcloudignore \
  --substitutions=_IMAGE="$IMAGE"

gcloud run deploy impossible-casino-api \
  --image="$IMAGE" \
  --service-account="casino-api-runtime@$PROJECT.iam.gserviceaccount.com" \
  --region=us-east1 \
  --min-instances=0 \
  --max-instances=2 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=2 \
  --cpu-boost \
  --timeout=60 \
  --allow-unauthenticated \
  --set-env-vars=LIVE_CHIP_MODE=owner,RUN_LIMIT_PER_MINUTE=60 \
  --set-secrets=CHIP_PASSPHRASE=chip-passphrase:latest,IBM_QUANTUM_TOKEN=ibm-quantum-token:latest
```

The site gives up on a press after 60 s, the same as this timeout, and then says the run may have been sent. Pressing again picks the job up, through check 2 above. A press reads the chip's calibration, compiles and submits before it answers, which can pass the 30 s timeout the simulator routes need. Polls return in a second or two. The service builds its IBM client on the first press or poll, not at startup, so a bad token shows up as 502 on a press rather than a failed start.

To stop chip presses without a new build:

```sh
gcloud run services update impossible-casino-api --region=us-east1 --update-env-vars=LIVE_CHIP_MODE=off
```

## Cost

Nothing here caps spending. The budget alert only sends an email. Max instances bounds compute. Nothing in the app bounds request charges, because refused requests and pings are still billed requests, and `/health` has no limit. The real defence is the alert plus the kill command below.

The figures below are estimates to confirm against the current Google Cloud price list.

- Normal traffic should sit inside Cloud Run's and Cloud Build's free tiers.
- The image in Artifact Registry should cost cents a month.
- Two instances kept busy all day should cost about $5 a day in compute, which would use a $20 budget in about four days.
- A sustained request flood adds request charges on top. At about $0.40 per million and 1,000 requests a second, that is about $35 a day, which would use $20 in about half a day.

## Kill it

```sh
gcloud run services delete impossible-casino-api --region=us-east1
```

Deleting the service is safe. The site falls back to its exported results and keeps working, labeled pre-run. To bring it back, run the deploy command again.
