# Resume Tweaker AI (Personal)

A personal tool that:
- Takes **Job Description** + your **base resume template (.tex)**
- Uses the OpenAI API to tailor your resume **without changing layout** (edits only specified LaTeX content)
- Shows a PDF preview in the browser
- Lets you download the updated **.tex** and **PDF** (via `pdflatex`)

## Why LaTeX?
LaTeX is deterministic and layout-stable. We only replace content inside specific commands like `\resumeItem{...}` and the Technical Skills section.

---

## Prereqs
- Node.js 18+
- Python 3.10+
- An OpenAI API key

Optional (for PDF export):
- **TeX Live** installed and `pdflatex` available on PATH

---

## 1) Setup (Backend)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env to add OPENAI_API_KEY
uvicorn app.main:app --reload --port 8000
```

Backend will run at: http://localhost:8000

---

## 2) Setup (Frontend)

```bash
cd frontend
npm install
npm run dev
```

Optional: point the frontend at a non-default backend URL:

```bash
VITE_BACKEND_URL=http://localhost:8000 npm run dev
```

Frontend will run at: http://localhost:5173

---

## One-command dev (optional)

From the repo root:

```bash
npm run dev
```

This starts the backend (port 8000) and frontend (port 5173) together.

---

## Usage
1. Open the frontend
2. Paste a job description
3. Upload or paste your LaTeX template, then **Save Template**
4. Click **Optimize**
5. Preview the updated resume (LaTeX mode only)
6. Download `.tex` and PDF
7. Use **Cover Letter** to generate a separate cover letter

---

## PDF Export Notes
The backend compiles LaTeX → PDF via `pdflatex -interaction=nonstopmode`.

Ensure TeX Live is installed and `pdflatex` is on your PATH, then restart the backend.

---

## Google Docs Mode (optional)
1. Set Google OAuth env vars in `backend/.env`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback`
   - `GOOGLE_CLIENT_TYPE=web` (use `installed` if your OAuth client is a Desktop app)
2. Start the backend and frontend
3. In the UI, switch to **Google Docs** and click **Connect Google Docs**
4. Select a doc and click **Optimize**
5. Select a separate doc for **Cover Letter** and click **Generate Cover Letter**

PDF export is handled directly from Google Docs: **File → Download**.

---

## Security
This is intended as a **personal tool**. Do not deploy publicly without adding:
- Auth
- Rate limiting
- File size limits
- Logging / redaction
