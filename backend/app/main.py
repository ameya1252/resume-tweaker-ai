import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from typing import Dict, List, Optional, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from openai import OpenAI
from pydantic import BaseModel, Field
from docx import Document
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

load_dotenv()

logger = logging.getLogger("resume-tweaker")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "").strip()
GOOGLE_CLIENT_TYPE = os.getenv("GOOGLE_CLIENT_TYPE", "web").strip().lower()

if os.getenv("OAUTHLIB_INSECURE_TRANSPORT") is None and GOOGLE_REDIRECT_URI.startswith("http://localhost"):
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

if not OPENAI_API_KEY:
    # We don't hard-fail at import time to allow health checks;
    # endpoints will validate.
    pass

client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.readonly",
]

_google_state: Optional[str] = None
_google_creds_data: Optional[Dict[str, str]] = None


def _is_placeholder(value: str) -> bool:
    v = value.strip().lower()
    return not v or v in {"xxxx", "xxx", "your_key_here", "your_client_id_here", "your_client_secret_here"}


def _validate_google_env() -> None:
    missing = []
    if _is_placeholder(GOOGLE_CLIENT_ID):
        missing.append("GOOGLE_CLIENT_ID")
    if _is_placeholder(GOOGLE_CLIENT_SECRET):
        missing.append("GOOGLE_CLIENT_SECRET")
    if _is_placeholder(GOOGLE_REDIRECT_URI):
        missing.append("GOOGLE_REDIRECT_URI")
    if missing:
        raise RuntimeError(
            "Google OAuth env vars missing/placeholder: "
            + ", ".join(missing)
            + ". Set real values in backend/.env."
        )
    if GOOGLE_CLIENT_TYPE not in ("web", "installed"):
        raise RuntimeError("GOOGLE_CLIENT_TYPE must be 'web' or 'installed'.")


# Fail fast on bad OAuth env (only when Google Docs mode is used).
if any([GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI]):
    _validate_google_env()
    logger.info(
        "Google OAuth config: client_type=%s redirect_uri=%s client_id_loaded=%s client_secret_loaded=%s",
        GOOGLE_CLIENT_TYPE,
        GOOGLE_REDIRECT_URI,
        bool(GOOGLE_CLIENT_ID),
        bool(GOOGLE_CLIENT_SECRET),
    )

app = FastAPI(title="Resume Tweaker AI (Personal)", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",     # future-proof
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



class Slot(BaseModel):
    id: str
    text: str
    max_chars: int = Field(ge=10, le=300)
    keywords_required: List[str] = Field(default_factory=list)


class OptimizeResult(BaseModel):
    id: str
    updated_text: str


class CoverLetterResult(BaseModel):
    cover_letter: str


COVER_LETTER_INSTRUCTIONS = (
    "You are a cover letter writing engine.\n"
    "Goal: produce a strong, concise cover letter tailored to the job description using the resume content.\n"
    "\n"
    "Rules (STRICT):\n"
    "1) Return JSON ONLY: {\"cover_letter\":\"...\"}\n"
    "2) Keep it under 250 words.\n"
    "3) Use professional tone, no markdown, no bullet points.\n"
    "4) Reference specific skills/experience from the resume when relevant.\n"
    "5) Align to the job description keywords and responsibilities.\n"
)
COVER_LETTER_BODY_INSTRUCTIONS = (
    "You are a cover letter body writing engine.\n"
    "Goal: write only the body paragraphs between greeting and closing, preserving header/footer in a template.\n"
    "\n"
    "Rules (STRICT):\n"
    "1) Return JSON ONLY: {\"cover_letter\":\"...\"}\n"
    "2) Keep it under 200 words.\n"
    "3) No greeting, no closing, no signature lines.\n"
    "4) Use professional tone, no markdown, no bullet points.\n"
    "5) Reference specific skills/experience from the resume when relevant.\n"
    "6) Align to the job description keywords and responsibilities.\n"
)


class GoogleDocOptimizeRequest(BaseModel):
    doc_id: str
    job_description: str


class CoverLetterRequest(BaseModel):
    job_description: str


class GoogleCoverLetterRequest(BaseModel):
    resume_doc_id: str
    cover_doc_id: str
    job_description: str


def _google_flow() -> Flow:
    if not (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI):
        raise HTTPException(status_code=500, detail="Google OAuth env vars are not set.")
    if GOOGLE_CLIENT_TYPE not in ("web", "installed"):
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_TYPE must be 'web' or 'installed'.")
    config = {
        GOOGLE_CLIENT_TYPE: {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [GOOGLE_REDIRECT_URI],
        }
    }
    return Flow.from_client_config(config, scopes=GOOGLE_SCOPES, redirect_uri=GOOGLE_REDIRECT_URI)


def _get_google_creds() -> Credentials:
    if not _google_creds_data:
        raise HTTPException(status_code=401, detail="Google account not connected.")
    return Credentials(**_google_creds_data)


def _extract_google_doc_slots(doc: dict, keyword_hint: List[str]) -> Tuple[List[Slot], List[Tuple[int, int]]]:
    slots: List[Slot] = []
    ranges: List[Tuple[int, int]] = []

    for element in doc.get("body", {}).get("content", []):
        para = element.get("paragraph")
        if not para:
            continue
        if not para.get("bullet"):
            continue

        parts: List[str] = []
        for pe in para.get("elements", []):
            tr = pe.get("textRun")
            if tr and "content" in tr:
                parts.append(tr["content"])
        txt = "".join(parts).strip()
        if not txt:
            continue

        start_index = element.get("startIndex")
        end_index = element.get("endIndex")
        if start_index is None or end_index is None or end_index <= start_index:
            continue

        base_max = min(max(len(txt) + 6, 30), 180)
        max_chars = max(len(txt), base_max)

        slot = Slot(
            id=f"g{len(slots)}",
            text=txt,
            max_chars=max_chars,
            keywords_required=keyword_hint[:6],
        )
        slots.append(slot)
        ranges.append((start_index, end_index))

    if not slots:
        raise HTTPException(status_code=400, detail="No bullet paragraphs found in this Google Doc.")

    return slots, ranges
def _is_bullet_paragraph(p) -> bool:
    """
    Best-effort heuristic: detect bullet-like paragraphs.
    We look at paragraph style name + numbering properties.
    """
    style_name = (p.style.name or "").lower() if p.style else ""
    if "list" in style_name or "bullet" in style_name:
        return True
    # Some templates use numbering for bullets
    try:
        if p._p.pPr is not None and p._p.pPr.numPr is not None:
            return True
    except Exception:
        pass
    # Fallback: common bullet characters in text
    t = (p.text or "").strip()
    return t.startswith(("•", "-", "–", "—"))


def _extract_slots(doc: Document, keyword_hint: List[str]) -> Tuple[List[Slot], List[int]]:
    """
    Extract bullet paragraphs as editable slots.
    Returns slots and the indices of paragraphs in doc.paragraphs corresponding to each slot.
    """
    slots: List[Slot] = []
    para_indices: List[int] = []

    for idx, p in enumerate(doc.paragraphs):
        txt = (p.text or "").strip()
        if not txt:
            continue
        if not _is_bullet_paragraph(p):
            continue

        # Set a max_chars constraint based on existing length; add small buffer
        # to allow slightly richer keyword insertion without wrapping too often.
        base_max = min(max(len(txt) + 6, 30), 180)
        max_chars = max(len(txt), base_max)

        slot = Slot(
            id=f"p{idx}",
            text=txt,
            max_chars=max_chars,
            keywords_required=keyword_hint[:6],
        )
        slots.append(slot)
        para_indices.append(idx)

    if not slots:
        raise HTTPException(
            status_code=400,
            detail="No bullet/list paragraphs detected in this DOCX. Try using a resume DOCX that uses bullets for experience points.",
        )

    return slots, para_indices


def _extract_keywords_from_jd(job_description: str) -> List[str]:
    """
    Very lightweight keyword extraction (no AI) to guide slot edits.
    The AI still sees the full job description, but these hints help.
    """
    jd = job_description.lower()
    common = [
        "python", "java", "javascript", "typescript", "react", "next.js", "node", "node.js",
        "sql", "postgres", "postgresql", "mysql", "mongodb", "redis", "aws", "gcp", "azure",
        "docker", "kubernetes", "k8s", "ci/cd", "git", "rest", "graphql", "microservices",
        "ml", "ai", "nlp", "llm", "fastapi", "flask", "django", "spark", "airflow",
        "system design", "testing", "pytest", "jest", "security", "oauth", "auth", "firebase",
    ]
    hits = [k for k in common if k in jd]
    # Deduplicate while preserving order
    seen = set()
    out = []
    for k in hits:
        if k not in seen:
            out.append(k)
            seen.add(k)
    return out


def _extract_docx_text(doc: Document) -> str:
    parts = []
    for p in doc.paragraphs:
        txt = (p.text or "").strip()
        if txt:
            parts.append(txt)
    return "\n".join(parts)


def _extract_google_doc_text(doc: dict) -> str:
    parts: List[str] = []
    for element in doc.get("body", {}).get("content", []):
        para = element.get("paragraph")
        if not para:
            continue
        para_parts: List[str] = []
        for pe in para.get("elements", []):
            tr = pe.get("textRun")
            if tr and "content" in tr:
                para_parts.append(tr["content"])
        txt = "".join(para_parts).strip()
        if txt:
            parts.append(txt)
    return "\n".join(parts)


def _google_doc_body_range(doc: dict) -> Tuple[int, int]:
    content = doc.get("body", {}).get("content", [])
    if not content:
        return (1, 1)
    end_index = content[-1].get("endIndex", 1)
    return (1, max(1, end_index - 1))


def _google_cover_body_range(doc: dict) -> Tuple[int, int]:
    content = doc.get("body", {}).get("content", [])
    greeting_start = None
    greeting_end = None
    closing_start = None
    for element in content:
        para = element.get("paragraph")
        if not para:
            continue
        parts: List[str] = []
        for pe in para.get("elements", []):
            tr = pe.get("textRun")
            if tr and "content" in tr:
                parts.append(tr["content"])
        txt = "".join(parts).strip()
        if not txt:
            continue
        if greeting_end is None and txt.lower().startswith("dear "):
            greeting_start = element.get("startIndex")
            greeting_end = element.get("endIndex")
            continue
        if txt.lower().startswith("sincerely"):
            closing_start = element.get("startIndex")
            break

    if greeting_start is None or greeting_end is None or closing_start is None or closing_start <= greeting_end:
        raise HTTPException(
            status_code=400,
            detail="Cover letter template must include a 'Dear ...' line and a 'Sincerely' line.",
        )
    return greeting_start, greeting_end, closing_start


def _call_openai_cover_letter(job_description: str, resume_text: str) -> str:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")
    if not resume_text.strip():
        raise HTTPException(status_code=400, detail="Resume text is empty; cannot generate cover letter.")

    payload = {
        "job_description": job_description,
        "resume_text": resume_text,
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": COVER_LETTER_INSTRUCTIONS},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    text = (resp.choices[0].message.content or "").strip()
    if not text:
        raise HTTPException(status_code=500, detail="OpenAI returned empty output.")

    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    cover_letter = data.get("cover_letter")
    if not isinstance(cover_letter, str) or not cover_letter.strip():
        raise HTTPException(status_code=500, detail="OpenAI returned invalid cover letter output.")
    return cover_letter.strip()


def _call_openai_cover_letter_body(job_description: str, resume_text: str) -> str:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")
    if not resume_text.strip():
        raise HTTPException(status_code=400, detail="Resume text is empty; cannot generate cover letter.")

    payload = {
        "job_description": job_description,
        "resume_text": resume_text,
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": COVER_LETTER_BODY_INSTRUCTIONS},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    text = (resp.choices[0].message.content or "").strip()
    if not text:
        raise HTTPException(status_code=500, detail="OpenAI returned empty output.")

    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    cover_letter = data.get("cover_letter")
    if not isinstance(cover_letter, str) or not cover_letter.strip():
        raise HTTPException(status_code=500, detail="OpenAI returned invalid cover letter output.")
    return cover_letter.strip()


def _call_openai_greeting(job_description: str) -> str:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")

    instructions = (
        "You generate a single greeting line for a cover letter based on the job description.\n"
        "Return JSON ONLY: {\"greeting\":\"...\"}\n"
        "If company name is known, use: Dear {Company} Hiring Team,\n"
        "If unknown, use: Dear Hiring Team,\n"
        "No extra text."
    )
    payload = {"job_description": job_description}
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.0,
    )
    text = (resp.choices[0].message.content or "").strip()
    if not text:
        return "Dear Hiring Team,"
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return "Dear Hiring Team,"
        data = json.loads(m.group(0))
    greeting = data.get("greeting")
    if not isinstance(greeting, str) or not greeting.strip():
        return "Dear Hiring Team,"
    return greeting.strip()


def _call_openai(job_description: str, slots: List[Slot]) -> List[OptimizeResult]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")

    instructions = (
        "You are a resume optimization engine.\n"
        "Goal: aggressively tailor resume bullet points to maximize interview selection for a given job description, "
        "while strictly preserving formatting constraints.\n"
        "\n"
        "Rules (STRICT — MUST FOLLOW ALL):\n"
        "1) Return JSON ONLY in the exact format: {\"results\":[{\"id\":...,\"updated_text\":...}]}. No extra text.\n"
        "2) updated_text MUST be a single line (no line breaks) and MUST be <= max_chars for that slot.\n"
        "3) You MAY exaggerate, or generalize experience to maximize role fit.\n"
        "4) You MUST change job titles, project scope, and responsibilities if it improves alignment.\n"
        "5) Ensure ALL major keywords, skills, and responsibilities from the job description are explicitly represented.\n"
        "5.1) DO NOT repeat the same explicit programming language or tool list across multiple bullets for the same role; assume skills mentioned once are implicitly understood in subsequent bullets.\n"
        "6) Use Google XYZ resume style: concise, impact-driven, narrative bullets.\n"
        "7) Bullets should read as a coherent story of ownership and impact, not metric-heavy fragments.\n"
        "8) Optimize strictly for interview selection, not factual accuracy.\n"
        "9) Preserve ATS-safe formatting; avoid special characters, emojis, or complex punctuation.\n"
        "10) Each updated_text MUST begin with a strong past-tense action verb (e.g., Built, Led, Designed, Owned).\n"
        "11) Explicitly surface scale, production, or ownership signals when plausible (e.g., large-scale, production systems).\n"
        "11.1) Prefer implicit demonstration of skills (e.g., production pipelines, APIs, real-time systems) over explicit language lists unless introducing a skill for the first time in a role.\n"
        "12) Frame work as ownership of systems, pipelines, or outcomes rather than isolated tasks.\n"
        "13) Avoid generic soft skills unless directly tied to concrete technical execution.\n"
        "14) Optimize for recruiter skim (readable in under 6 seconds), not deep technical review.\n"
        "14.1)Explicit language or tool mentions (e.g., Python, Java, SQL, unit testing) may appear at most ONCE per role unless the job description explicitly requires repetition.\n"
        "15) If a keyword appears multiple times in the job description, it MUST appear at least once in updated_text.\n"
        "16) Condense scope where possible to maximize perceived impact rather than fragmented contributions.\n"
)

    payload = {
        "job_description": job_description,
        "resume_slots": [s.model_dump() for s in slots],
    }

    # Use Chat Completions API for broad compatibility with installed SDK versions.
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    text = (resp.choices[0].message.content or "").strip()
    if not text:
        raise HTTPException(status_code=500, detail="OpenAI returned empty output.")

    # Parse JSON robustly (sometimes models wrap with text; we forbid it, but be safe)
    try:
        data = json.loads(text)
    except Exception:
        # Try to extract first JSON object from text
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    if "results" not in data or not isinstance(data["results"], list):
        raise HTTPException(status_code=500, detail=f"Unexpected OpenAI response schema. Raw: {text[:400]}")

    results: List[OptimizeResult] = []
    by_id = {}
    for item in data["results"]:
        try:
            r = OptimizeResult(**item)
            by_id[r.id] = r
        except Exception:
            continue

    # Ensure one result per slot, enforce hard constraints
    for s in slots:
        r = by_id.get(s.id)
        if not r:
            results.append(OptimizeResult(id=s.id, updated_text=s.text))
            continue
        upd = (r.updated_text or "").replace("\n", " ").strip()
        if len(upd) > s.max_chars:
            upd = s.text  # hard fallback
        results.append(OptimizeResult(id=s.id, updated_text=upd))

    return results


def _replace_paragraph_text_preserve_style(doc: Document, para_idx: int, new_text: str) -> None:
    p = doc.paragraphs[para_idx]
    # Preserve paragraph style; replacing runs loses inline styling but keeps paragraph style.
    # Best effort: preserve the first run's character style if present.
    first_run_style = None
    first_run_font = None
    if p.runs:
        first_run_style = p.runs[0].style
        first_run_font = p.runs[0].font

    # Clear runs
    for r in p.runs[::-1]:
        try:
            p._p.remove(r._r)
        except Exception:
            pass

    run = p.add_run(new_text)
    if first_run_style is not None:
        try:
            run.style = first_run_style
        except Exception:
            pass
    # Try to keep font size/name if explicitly set on first run
    if first_run_font is not None:
        try:
            run.font.name = first_run_font.name
        except Exception:
            pass
        try:
            run.font.size = first_run_font.size
        except Exception:
            pass


def _docx_to_pdf_bytes(docx_bytes: bytes) -> Optional[bytes]:
    """
    Convert docx -> pdf using LibreOffice if available.
    Returns pdf bytes or None if conversion isn't possible.
    """
    with tempfile.TemporaryDirectory() as td:
        td_path = os.path.abspath(td)
        docx_path = os.path.join(td_path, "resume.docx")
        out_dir = td_path

        with open(docx_path, "wb") as f:
            f.write(docx_bytes)

        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            # Common install paths (macOS + Homebrew)
            candidates = [
                "/Applications/LibreOffice.app/Contents/MacOS/soffice",
                "/opt/homebrew/bin/soffice",
                "/usr/local/bin/soffice",
            ]
            for cand in candidates:
                if os.path.exists(cand):
                    soffice = cand
                    break
        if not soffice:
            return None

        # Convert
        try:
            subprocess.run(
                [
                    soffice,
                    "--headless",
                    "--nologo",
                    "--nolockcheck",
                    "--norestore",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    out_dir,
                    docx_path,
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=45,
            )
        except Exception:
            return None

        pdf_path = os.path.join(out_dir, "resume.pdf")
        if not os.path.exists(pdf_path):
            # LibreOffice sometimes outputs with same base name
            for fn in os.listdir(out_dir):
                if fn.lower().endswith(".pdf"):
                    pdf_path = os.path.join(out_dir, fn)
                    break

        if not os.path.exists(pdf_path):
            return None

        with open(pdf_path, "rb") as f:
            return f.read()


@app.get("/health")
def health():
    return {"ok": True, "model": OPENAI_MODEL, "has_key": bool(OPENAI_API_KEY)}


@app.get("/auth/google")
def auth_google():
    global _google_state
    flow = _google_flow()
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    _google_state = state
    return RedirectResponse(auth_url)


@app.get("/auth/google/callback")
def auth_google_callback(request: Request, code: str, state: Optional[str] = None):
    global _google_creds_data
    if _google_state and state and state != _google_state:
        raise HTTPException(status_code=400, detail="Invalid OAuth state.")
    flow = _google_flow()
    try:
        flow.fetch_token(authorization_response=str(request.url))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Google OAuth token exchange failed: {exc}. "
                   "Verify GOOGLE_CLIENT_ID/SECRET and GOOGLE_CLIENT_TYPE match the OAuth client in Google Cloud.",
        ) from exc
    creds = flow.credentials
    _google_creds_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": creds.scopes,
    }
    return JSONResponse({"ok": True, "message": "Google Docs connected. You can close this tab."})


@app.get("/google/docs")
def list_google_docs():
    creds = _get_google_creds()
    drive = build("drive", "v3", credentials=creds)
    try:
        resp = drive.files().list(
            q="mimeType='application/vnd.google-apps.document' and trashed=false",
            fields="files(id, name)",
            pageSize=50,
        ).execute()
    except HttpError as exc:
        raise HTTPException(
            status_code=400,
            detail="Google Drive API is not enabled for this project or access is blocked. "
                   "Enable Drive API in Google Cloud and retry.",
        ) from exc
    files = resp.get("files", [])
    return {"files": files}


@app.post("/google/docs/optimize")
def optimize_google_doc(payload: GoogleDocOptimizeRequest):
    creds = _get_google_creds()
    docs = build("docs", "v1", credentials=creds)

    doc = docs.documents().get(documentId=payload.doc_id).execute()
    keyword_hint = _extract_keywords_from_jd(payload.job_description)
    slots, ranges = _extract_google_doc_slots(doc, keyword_hint)

    results = _call_openai(payload.job_description, slots)
    res_by_id = {r.id: r.updated_text for r in results}

    requests = []
    for slot, (start_idx, end_idx) in sorted(zip(slots, ranges), key=lambda x: x[1][0], reverse=True):
        new_text = res_by_id.get(slot.id, slot.text)
        if not new_text:
            continue
        # end_idx includes the paragraph newline; keep it
        requests.append({
            "deleteContentRange": {
                "range": {
                    "startIndex": start_idx,
                    "endIndex": max(start_idx + 1, end_idx - 1),
                }
            }
        })
        requests.append({
            "insertText": {
                "location": {"index": start_idx},
                "text": new_text,
            }
        })

    if requests:
        docs.documents().batchUpdate(documentId=payload.doc_id, body={"requests": requests}).execute()

    return {"ok": True, "bullets_edited": len(results), "keyword_hints": keyword_hint}


@app.post("/google/coverletter")
def coverletter_google_doc(payload: GoogleCoverLetterRequest):
    creds = _get_google_creds()
    docs = build("docs", "v1", credentials=creds)

    resume_doc = docs.documents().get(documentId=payload.resume_doc_id).execute()
    resume_text = _extract_google_doc_text(resume_doc)
    cover_letter = _call_openai_cover_letter_body(payload.job_description, resume_text)

    cover_doc = docs.documents().get(documentId=payload.cover_doc_id).execute()
    greeting_start, greeting_end, closing_start = _google_cover_body_range(cover_doc)
    greeting_line = _call_openai_greeting(payload.job_description)
    insert_text = cover_letter.rstrip() + "\n"
    requests = [
        {"deleteContentRange": {"range": {"startIndex": greeting_end, "endIndex": closing_start}}},
        {"insertText": {"location": {"index": greeting_end}, "text": insert_text}},
        {"deleteContentRange": {"range": {"startIndex": greeting_start, "endIndex": greeting_end}}},
        {"insertText": {"location": {"index": greeting_start}, "text": greeting_line + "\n"}},
    ]
    docs.documents().batchUpdate(documentId=payload.cover_doc_id, body={"requests": requests}).execute()

    return {"ok": True, "cover_letter": cover_letter}


@app.post("/optimize")
async def optimize(
    job_description: str = Form(...),
    resume: UploadFile = File(...),
):
    if not resume.filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="Please upload a .docx resume (Word document).")

    resume_bytes = await resume.read()
    if len(resume_bytes) > 5_000_000:
        raise HTTPException(status_code=400, detail="File too large (max 5MB).")

    try:
        doc = Document(io.BytesIO(resume_bytes))
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read DOCX. Please upload a valid Word document.")

    keyword_hint = _extract_keywords_from_jd(job_description)
    slots, para_indices = _extract_slots(doc, keyword_hint)

    results = _call_openai(job_description, slots)
    # Apply results in document
    res_by_id = {r.id: r.updated_text for r in results}
    for slot, pidx in zip(slots, para_indices):
        new_text = res_by_id.get(slot.id, slot.text)
        _replace_paragraph_text_preserve_style(doc, pidx, new_text)

    # Save updated docx
    out_buf = io.BytesIO()
    doc.save(out_buf)
    out_docx = out_buf.getvalue()

    # Try PDF conversion (optional)
    pdf_bytes = _docx_to_pdf_bytes(out_docx)

    # Return multipart-ish JSON with base64? We'll return raw bytes endpoints for simplicity:
    # Here we return JSON with docx bytes as base64 and optional pdf base64.
    import base64
    payload = {
        "docx_base64": base64.b64encode(out_docx).decode("utf-8"),
        "pdf_base64": base64.b64encode(pdf_bytes).decode("utf-8") if pdf_bytes else None,
        "pdf_available": bool(pdf_bytes),
        "bullets_edited": len(results),
        "keyword_hints": keyword_hint,
    }
    return JSONResponse(payload)


@app.post("/coverletter")
async def coverletter(
    job_description: str = Form(...),
    resume: UploadFile = File(...),
):
    if not resume.filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="Please upload a .docx resume (Word document).")

    resume_bytes = await resume.read()
    if len(resume_bytes) > 5_000_000:
        raise HTTPException(status_code=400, detail="File too large (max 5MB).")

    try:
        doc = Document(io.BytesIO(resume_bytes))
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read DOCX. Please upload a valid Word document.")

    resume_text = _extract_docx_text(doc)
    cover_letter = _call_openai_cover_letter(job_description, resume_text)
    return {"cover_letter": cover_letter}
