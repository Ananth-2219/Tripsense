# TripSense Vercel Production Deployment

This document describes the unified single-project Vercel deployment for TripSense, combining the React/Vite frontend and Python FastAPI scoring backend under a single origin.

---

## 1. Architecture Overview

* **Frontend**: React 19 + Vite SPA, compiled to static assets in `dist/`.
* **Backend**: FastAPI scoring service exported through `api/index.py` as a native Vercel Python Serverless Function (Python 3.12).
* **Routing**: Defined in `vercel.json`:
  * `/api/:path*` rewrites directly to `/api/index.py` (FastAPI).
  * `/((?!api/).*)` falls back to `/index.html` (React client-side SPA routing).
* **Same-Origin Access**: The frontend queries `/api/...` relatively without CORS overhead, reverse proxy complexity, or domain mismatches.
* **Database & RLS**: All state is managed in Supabase (`trips`, `trip_feedback`, `trip_scores`, `score_evaluations`).

---

## 2. Configuration Files

1. **`vercel.json`**:
   * Declares `framework: "vite"`, `buildCommand: "npm run build"`, and `outputDirectory: "dist"`.
   * Sets `maxDuration: 60` seconds for `api/index.py`.
   * Maps `/api/:path*` to FastAPI before the SPA catch-all rewrite.
2. **`api/index.py`**:
   * Python entrypoint that resolves the repository root onto `sys.path` and exports `app` from `scoring_service.app`.
3. **`requirements.txt`**:
   * Pins production Python dependencies (`fastapi`, `uvicorn`, `pydantic`, `httpx`, `numpy`, `pandas`) for the Vercel build container.
4. **`.python-version`**:
   * Pins Python `3.12`.
5. **`.vercelignore`**:
   * Excludes virtual environments (`.venv*`), offline analysis datasets (`analysis/`), test files (`tests/`, `scripts/`), and credentials from the serverless function bundle to stay well below Vercel's 250 MB uncompressed limit.
6. **`.gitattributes`**:
   * Enforces `text eol=crlf` on `trip_scoring/policies/*.json` and `trip_scoring/policies/*.sha256` so that Git preserves the exact validated byte sequences and cryptographic SHA-256 seals across Windows, Linux, and Vercel environments without line-ending corruption.

---

## 3. Required Vercel Project Settings

In the **Vercel Dashboard > Project Settings > General**:

* **Framework Preset**: `Vite` (auto-detected via `vercel.json`)
* **Build Command**: `npm run build`
* **Output Directory**: `dist`
* **Install Command**: `npm install`
* **Node.js Version**: `20.x` or `22.x`

---

## 4. Required Environment Variables

Configure these in **Vercel Dashboard > Project Settings > Environment Variables** for **Production**, **Preview**, and **Development**:

| Variable Name | Environment | Description | Example / Target |
| :--- | :--- | :--- | :--- |
| `SUPABASE_URL` | Frontend (Build) | Public Supabase project URL | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Frontend (Build) | Public `anon` / publishable key | `sb_publishable_...` |
| `SCORING_SUPABASE_URL` | Backend (Runtime) | Server-side Supabase URL | `https://YOUR-PROJECT.supabase.co` |
| `SCORING_SUPABASE_SERVICE_KEY` | Backend (Runtime) | Privileged `service_role` secret | `sb_secret_...` |

> [!WARNING]
> Never prefix `SCORING_SUPABASE_SERVICE_KEY` with `VITE_` or embed it in frontend code. It is accessible only within the Python serverless function environment.

---

## 5. Vercel Serverless Function Constraints

1. **Payload Request Size**:
   * Vercel Serverless Functions enforce a strict **4.5 MB request body limit**.
   * Standard TripSense trips (10–20 minutes at 20–50 Hz, up to 30,000 readings) generate ~1.5–3.2 MB JSON payloads, operating safely below this limit.
   * If an unusually long recording exceeds 4.5 MB, Vercel edge will return HTTP 413 before reaching FastAPI.
2. **Execution Timeout**:
   * Serverless functions default to 15s (Hobby) or 15–300s (Pro).
   * `vercel.json` configures `maxDuration: 60`, which is more than sufficient for TripSense feature extraction (~100–300 ms).
3. **Stateless / Serverless Execution**:
   * Serverless containers are frozen between invocations. Scoring leases, state transitions, and retries are backed durably by PostgreSQL/Supabase rather than local memory.
4. **Filesystem**:
   * The serverless execution environment has a read-only root filesystem with a temporary `/tmp` partition (512 MB). TripSense operates purely in-memory and does not write to the local disk.

---

## 6. Local Development Workflow

Local development remains identical and does not require Vercel CLI:

1. **Backend**:
   ```powershell
   cd C:\Tripsense
   $env:SCORING_SUPABASE_URL = "https://YOUR-PROJECT.supabase.co"
   $env:SCORING_SUPABASE_SERVICE_KEY = "sb_secret_..."
   npm run dev:scoring
   ```
2. **Frontend**:
   ```powershell
   cd C:\Tripsense
   npm run dev
   ```
   * Vite proxies `/api` requests to `http://127.0.0.1:8000` automatically via `vite.config.js`.
