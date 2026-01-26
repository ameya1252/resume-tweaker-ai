import contextvars
import json
import logging
import os
import re
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple, Union
from urllib.parse import quote

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from openai import OpenAI
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session as OrmSession
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from db import Base, SessionLocal, engine
from models import DownloadedResume, GoogleCredential, GoogleOAuthState, Resume
from models import Session as SessionModel
from models import User

load_dotenv()

logger = logging.getLogger("resume-tweaker")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "").strip()
OPENAI_MODEL_RESUME = os.getenv("OPENAI_MODEL_RESUME", OPENAI_MODEL).strip()
OPENAI_MODEL_CHEAP = os.getenv("OPENAI_MODEL_CHEAP", OPENAI_MODEL).strip()
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

USE_LATEXMK = True

GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.readonly",
]
_request_cache: contextvars.ContextVar[Optional[Dict[str, object]]] = contextvars.ContextVar(
    "request_cache",
    default=None,
)


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


def _validate_latexmk_installed() -> None:
    global USE_LATEXMK
    try:
        result = subprocess.run(
            ["latexmk", "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
        )
    except FileNotFoundError:
        logger.warning("latexmk not found, falling back to pdflatex")
        USE_LATEXMK = False
        return
    except Exception:
        logger.warning("latexmk not found, falling back to pdflatex")
        USE_LATEXMK = False
        return

    if result.returncode != 0:
        logger.warning("latexmk not found, falling back to pdflatex")
        USE_LATEXMK = False


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


@app.on_event("startup")
def validate_database_url() -> None:
    if not os.getenv("DATABASE_URL", "").strip():
        raise RuntimeError("DATABASE_URL is not set. Configure it before starting the server.")
    _validate_latexmk_installed()
    Base.metadata.create_all(bind=engine)


_allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",     # future-proof
    "http://127.0.0.1:3000",
]
frontend_origin = os.getenv("FRONTEND_ORIGIN", "").strip()
if frontend_origin:
    _allowed_origins.append(frontend_origin)

EXPERIENCE_SECTION_NAMES = [
    "Experience",
    "Professional Experience",
    "Work Experience",
    "Industrial Experience",
    "Employment",
    "Professional History",
    "Work History",
]
SKILLS_SECTION_NAMES = [
    "Skills",
    "Technical Skills",
    "Core Skills",
    "Core Competencies",
    "Technologies",
    "Tech Stack",
    "Tools",
    "Skills & Tools",
    "Skills and Tools",
]
PROJECTS_SECTION_NAMES = [
    "Projects",
    "Personal Projects",
    "Academic Projects",
    "Project Experience",
    "Relevant Projects",
    "Selected Projects",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



class Slot(BaseModel):
    id: str
    text: str
    original_text: Optional[str] = None
    role_id: str
    slot_type: str = "bullet"
    max_chars: int = Field(ge=10, le=1200)
    keywords_required: List[str] = Field(default_factory=list)
    experience_id: Optional[str] = None


class OptimizeResult(BaseModel):
    id: str
    updated_text: str


class CoverLetterResult(BaseModel):
    cover_letter: str


class CompilationResult(BaseModel):
    success: bool
    pdf_bytes: Optional[bytes] = None
    log_content: Optional[str] = None
    warnings: List[str] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)
    latex_errors: List[Dict[str, Optional[Union[int, str]]]] = Field(default_factory=list)
    passes: int = 0


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
    risk_level: str = "balanced"


class CoverLetterRequest(BaseModel):
    job_description: str


class GoogleCoverLetterRequest(BaseModel):
    resume_doc_id: str
    cover_doc_id: str
    job_description: str


class GoogleCoverLetterPreviewRequest(BaseModel):
    resume_doc_id: str
    job_description: str


class GoogleDocTextRequest(BaseModel):
    doc_id: str


class OutreachPreviewRequest(BaseModel):
    job_description: str
    resume_text: str


class LatexTemplateRequest(BaseModel):
    latex_text: str


class DraftApplyItem(BaseModel):
    id: str
    text: str
    experience_id: Optional[str] = None
    project_id: Optional[str] = None


class DraftApplyRequest(BaseModel):
    titles: Optional[List[DraftApplyItem]] = None
    companies: Optional[List[DraftApplyItem]] = None
    bullets: Optional[List[DraftApplyItem]] = None
    project_titles: Optional[List[DraftApplyItem]] = None
    project_dates: Optional[List[DraftApplyItem]] = None
    project_bullets: Optional[List[DraftApplyItem]] = None
    skills: Optional[str] = None


class DownloadedResumeRequest(BaseModel):
    name: Optional[str] = None
    optimized_latex: str
    pdf_base64: str


class RegisterRequest(BaseModel):
    email: str
    password: str
    first_name: str
    last_name: str


class LoginRequest(BaseModel):
    email: str
    password: str


_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def hash_password(password: str) -> str:
    return _pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return _pwd_context.verify(password, password_hash)


def create_session_token() -> str:
    return str(uuid.uuid4())


def _get_user_for_token(token: str, db: OrmSession) -> User:
    if not token:
        raise HTTPException(status_code=401, detail="Invalid session token.")
    session = db.query(SessionModel).filter(SessionModel.token == token).first()
    if not session:
        raise HTTPException(status_code=401, detail="Session expired or invalid.")
    now = datetime.now(timezone.utc)
    expires_at = session.expires_at
    if expires_at is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid.")
    if expires_at.tzinfo is None:
        if expires_at <= datetime.utcnow():
            raise HTTPException(status_code=401, detail="Session expired or invalid.")
    elif expires_at <= now:
        raise HTTPException(status_code=401, detail="Session expired or invalid.")

    user = db.query(User).filter(User.id == session.user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid session.")
    return user


def get_current_user(
    authorization: Optional[str] = Header(None),
    db: OrmSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid authorization header.")
    return _get_user_for_token(token, db)


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


def _get_google_creds(user: User, db: OrmSession) -> Credentials:
    record = db.query(GoogleCredential).filter(GoogleCredential.user_id == user.id).first()
    if not record:
        raise HTTPException(status_code=401, detail="Google account not connected.")
    scopes = json.loads(record.scopes) if record.scopes else GOOGLE_SCOPES
    creds = Credentials(
        token=record.token,
        refresh_token=record.refresh_token,
        token_uri=record.token_uri,
        client_id=record.client_id,
        client_secret=record.client_secret,
        scopes=scopes,
    )
    if record.expiry:
        expiry = record.expiry
        if expiry.tzinfo is not None:
            expiry = expiry.astimezone(timezone.utc).replace(tzinfo=None)
        creds.expiry = expiry
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(GoogleRequest())
            except Exception as exc:
                raise HTTPException(
                    status_code=401,
                    detail="Google credentials expired. Reconnect your Google account.",
                ) from exc
            record.token = creds.token
            record.expiry = creds.expiry
            if creds.refresh_token:
                record.refresh_token = creds.refresh_token
            try:
                db.add(record)
                db.commit()
            except SQLAlchemyError as exc:
                db.rollback()
                logger.exception("Failed to refresh Google token: user_id=%s", user.id)
                raise HTTPException(status_code=500, detail="Could not refresh Google credentials.") from exc
        else:
            raise HTTPException(
                status_code=401,
                detail="Google credentials expired. Reconnect your Google account.",
            )
    return creds


def _google_doc_section_type(text: str) -> Optional[str]:
    normalized = text.strip().lower()
    if normalized in {name.lower() for name in EXPERIENCE_SECTION_NAMES}:
        return "experience"
    if normalized in {name.lower() for name in PROJECTS_SECTION_NAMES}:
        return "projects"
    if normalized in {name.lower() for name in SKILLS_SECTION_NAMES}:
        return "skills"
    return None


def _looks_like_section_heading(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    if len(stripped) > 60:
        return False
    letters = [ch for ch in stripped if ch.isalpha()]
    if letters and all(ch.isupper() for ch in letters):
        return True
    common = {
        "honors",
        "awards",
        "certifications",
        "publications",
        "achievements",
        "leadership",
        "activities",
        "education",
        "experience",
        "projects",
        "skills",
    }
    return stripped.lower() in common


def _extract_google_doc_slots(doc: dict, keyword_hint: List[str]) -> Tuple[List[Slot], List[Tuple[int, int]]]:
    slots: List[Slot] = []
    ranges: List[Tuple[int, int]] = []
    current_section: Optional[str] = None

    for element in doc.get("body", {}).get("content", []):
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

        if not para.get("bullet"):
            section_type = _google_doc_section_type(txt)
            if section_type:
                current_section = section_type
            continue

        if current_section == "projects":
            continue
        if current_section not in {"experience", "skills"}:
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
            original_text=txt,
            role_id=f"gdoc_role_{len(slots) // 10}",
            slot_type="bullet",
            max_chars=max_chars,
            keywords_required=keyword_hint[:6],
        )
        slots.append(slot)
        ranges.append((start_index, end_index))

    if not slots:
        raise HTTPException(status_code=400, detail="No bullet paragraphs found in this Google Doc.")

    return slots, ranges


def _extract_google_doc_skills_block(doc: dict) -> Optional[Tuple[str, int, int]]:
    current_section: Optional[str] = None
    buffer: List[str] = []
    start_index: Optional[int] = None
    end_index: Optional[int] = None

    for element in doc.get("body", {}).get("content", []):
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

        if not para.get("bullet"):
            section_type = _google_doc_section_type(txt)
            if section_type:
                if current_section == "skills" and buffer:
                    break
                current_section = section_type
                continue
            if current_section == "skills" and _looks_like_section_heading(txt):
                break

        if current_section != "skills":
            continue
        if para.get("bullet"):
            continue

        start = element.get("startIndex")
        end = element.get("endIndex")
        if start is None or end is None or end <= start:
            continue
        if start_index is None:
            start_index = start
        end_index = end
        buffer.append(txt)

    if not buffer or start_index is None or end_index is None:
        return None
    return ("\n".join(buffer).strip(), start_index, end_index)


def _parse_latex_resume_items(latex_text: str, keyword_hint: List[str]) -> List[Dict[str, object]]:
    """
    Parse \\resumeItem{...} blocks grouped by \\resumeSubheading.
    Each group includes experience metadata and its bullet entries with ranges.
    """
    section_range = _section_range_any_of(latex_text, EXPERIENCE_SECTION_NAMES)
    if not section_range:
        raise HTTPException(
            status_code=400,
            detail="No Experience section found (e.g., Experience, Professional Experience, Work Experience).",
        )
    section_start, section_end = section_range

    education_range = _latex_section_range(latex_text, "Education")
    subheadings, _ = _parse_latex_resume_subheadings(latex_text)
    if not subheadings:
        raise HTTPException(
            status_code=400,
            detail="No \\resumeSubheading{...} entries found in this LaTeX template.",
        )

    groups: List[Dict[str, object]] = []
    bullet_count = 0
    subheadings = [
        s for s in subheadings
        if section_start <= int(s.get("block_start", 0)) < section_end
    ]
    if not subheadings:
        raise HTTPException(
            status_code=400,
            detail="No \\resumeSubheading entries found inside the Experience section.",
        )

    for idx, sub in enumerate(subheadings):
        block_start = int(sub.get("block_start", 0))
        block_end = int(sub.get("block_end", block_start))
        next_sub_start = None
        if idx + 1 < len(subheadings):
            next_sub_start = int(subheadings[idx + 1].get("block_start", len(latex_text)))
        rest = latex_text[block_end:]
        m_section = re.search(r"\\section\*?\{", rest)
        next_section_start = block_end + m_section.start() if m_section else None

        boundary_candidates = [len(latex_text)]
        if next_sub_start is not None:
            boundary_candidates.append(next_sub_start)
        if next_section_start is not None:
            boundary_candidates.append(next_section_start)
        boundary = min(boundary_candidates)
        boundary = min(boundary, section_end)

        bullets: List[Dict[str, object]] = []
        scan_idx = block_end
        while scan_idx < boundary:
            start = latex_text.find("\\resumeItem{", scan_idx)
            if start == -1 or start >= boundary:
                break
            if education_range and education_range[0] <= start < education_range[1]:
                scan_idx = start + len("\\resumeItem{")
                continue
            content_start = start + len("\\resumeItem{")
            depth = 1
            i = content_start
            while i < len(latex_text) and depth > 0:
                ch = latex_text[i]
                if ch == "{" and latex_text[i - 1] != "\\":
                    depth += 1
                elif ch == "}" and latex_text[i - 1] != "\\":
                    depth -= 1
                i += 1
            if depth != 0:
                break
            content_end = i - 1
            if content_end > boundary:
                break
            txt = latex_text[content_start:content_end].strip()
            if txt:
                base_max = min(max(len(txt) + 6, 30), 140)
                max_chars = max(len(txt), base_max)
                slot = Slot(
                    id=f"li{bullet_count}",
                    text=txt,
                    original_text=txt,
                    role_id=f"latex_role_{bullet_count // 10}",
                    slot_type="bullet",
                    max_chars=max_chars,
                    keywords_required=keyword_hint[:6],
                    experience_id=str(sub.get("id", "")),
                )
                bullets.append(
                    {
                        "id": slot.id,
                        "text": txt,
                        "range": (content_start, content_end),
                        "slot": slot,
                    }
                )
                bullet_count += 1
            scan_idx = i

        groups.append(
            {
                "experience_id": str(sub.get("id", "")),
                "company": str(sub.get("company", "")),
                "title": str(sub.get("title", "")),
                "bullets": bullets,
            }
        )

    if bullet_count == 0:
        raise HTTPException(
            status_code=400,
            detail="No \\resumeItem{...} entries found in this LaTeX template.",
        )
    return groups


def _section_range_any(latex: str, section_name: str) -> Optional[Tuple[int, int]]:
    needle = f"\\section{{{section_name}}}"
    start = latex.find(needle)
    if start == -1:
        needle = f"\\section*{{{section_name}}}"
        start = latex.find(needle)
        if start == -1:
            return None
    body_start = start + len(needle)
    next_section = latex.find("\\section{", body_start)
    next_section_star = latex.find("\\section*{", body_start)
    candidates = [idx for idx in (next_section, next_section_star) if idx != -1]
    if not candidates:
        return (body_start, len(latex))
    return (body_start, min(candidates))


def _section_range_any_of(latex: str, section_names: List[str]) -> Optional[Tuple[int, int]]:
    for name in section_names:
        match = re.search(rf"\\section\*?\{{{re.escape(name)}\}}", latex, re.IGNORECASE)
        if not match:
            continue
        body_start = match.end()
        rest = latex[body_start:]
        next_section = re.search(r"\\section\*?\{", rest)
        if not next_section:
            return (body_start, len(latex))
        return (body_start, body_start + next_section.start())
    return None


def _scan_resume_items(latex_text: str, start: int, end: int) -> List[Dict[str, object]]:
    bullets: List[Dict[str, object]] = []
    scan_idx = start
    while scan_idx < end:
        item_start = latex_text.find("\\resumeItem{", scan_idx)
        if item_start == -1 or item_start >= end:
            break
        content_start = item_start + len("\\resumeItem{")
        depth = 1
        i = content_start
        while i < len(latex_text) and depth > 0:
            ch = latex_text[i]
            if ch == "{" and latex_text[i - 1] != "\\":
                depth += 1
            elif ch == "}" and latex_text[i - 1] != "\\":
                depth -= 1
            i += 1
        if depth != 0:
            break
        content_end = i - 1
        if content_end > end:
            break
        text = latex_text[content_start:content_end].strip()
        bullets.append(
            {
                "text": text,
                "range": (content_start, content_end),
            }
        )
        scan_idx = i
    return bullets


def _parse_experience_groups(latex_text: str) -> List[Dict[str, object]]:
    section_range = _section_range_any_of(latex_text, EXPERIENCE_SECTION_NAMES)
    if not section_range:
        raise HTTPException(
            status_code=400,
            detail="No Experience section found (e.g., Experience, Professional Experience, Work Experience).",
        )
    section_start, section_end = section_range
    subheadings, title_ranges = _parse_latex_resume_subheadings(latex_text)
    filtered = [
        (s, r)
        for s, r in zip(subheadings, title_ranges)
        if section_start <= int(s.get("block_start", 0)) < section_end
    ]
    if not filtered:
        raise HTTPException(
            status_code=400,
            detail="No \\resumeSubheading entries found inside the Experience section.",
        )

    groups: List[Dict[str, object]] = []
    bullet_count = 0
    for idx, (sub, title_range) in enumerate(filtered):
        block_end = int(sub.get("block_end", 0))
        next_start = None
        if idx + 1 < len(filtered):
            next_start = int(filtered[idx + 1][0].get("block_start", len(latex_text)))
        boundary = min(next_start or len(latex_text), section_end)

        bullets = []
        for b in _scan_resume_items(latex_text, block_end, boundary):
            bullets.append(
                {
                    "id": f"li{bullet_count}",
                    "text": b.get("text", ""),
                    "range": b.get("range", (0, 0)),
                }
            )
            bullet_count += 1

        groups.append(
            {
                "experience_id": str(sub.get("id", "")),
                "company": str(sub.get("company", "")),
                "title": str(sub.get("title", "")),
                "dates": str(sub.get("dates", "")),
                "title_range": title_range,
                "bullets": bullets,
            }
        )

    return groups


def _parse_project_groups(latex_text: str) -> List[Dict[str, object]]:
    section_range = _section_range_any_of(latex_text, PROJECTS_SECTION_NAMES)
    if not section_range:
        return []
    section_start, section_end = section_range

    headings: List[Dict[str, object]] = []
    idx = section_start
    needle = "\\resumeProjectHeading"
    while idx < section_end:
        start = latex_text.find(needle, idx)
        if start == -1 or start >= section_end:
            break
        i = start + len(needle)
        while i < len(latex_text) and latex_text[i].isspace():
            i += 1
        if i >= len(latex_text) or latex_text[i] != "{":
            idx = i
            continue
        fields: List[str] = []
        field_ranges: List[Tuple[int, int]] = []
        parse_failed = False
        for _ in range(2):
            if i >= len(latex_text) or latex_text[i] != "{":
                parse_failed = True
                break
            content_start = i + 1
            depth = 1
            j = content_start
            while j < len(latex_text) and depth > 0:
                ch = latex_text[j]
                if ch == "{" and latex_text[j - 1] != "\\":
                    depth += 1
                elif ch == "}" and latex_text[j - 1] != "\\":
                    depth -= 1
                j += 1
            if depth != 0:
                parse_failed = True
                break
            content_end = j - 1
            fields.append(latex_text[content_start:content_end].strip())
            field_ranges.append((content_start, content_end))
            i = j
            while i < len(latex_text) and latex_text[i].isspace():
                i += 1
        if not parse_failed and len(fields) == 2:
            headings.append(
                {
                    "name": fields[0],
                    "dates": fields[1],
                    "name_range": field_ranges[0],
                    "dates_range": field_ranges[1],
                    "block_start": start,
                    "block_end": i,
                }
            )
        idx = i if i > start else start + len(needle)

    if not headings:
        try:
            subheadings, _ = _parse_latex_resume_subheadings(latex_text)
        except HTTPException:
            subheadings = []
        for sub in subheadings:
            block_start = int(sub.get("block_start", 0))
            if section_start <= block_start < section_end:
                name = str(sub.get("company", "")).strip() or str(sub.get("title", "")).strip()
                headings.append(
                    {
                        "name": name,
                        "dates": str(sub.get("dates", "")),
                        "block_start": block_start,
                        "block_end": int(sub.get("block_end", 0)),
                    }
                )

    groups: List[Dict[str, object]] = []
    for idx, heading in enumerate(headings):
        block_end = int(heading.get("block_end", 0))
        next_start = None
        if idx + 1 < len(headings):
            next_start = int(headings[idx + 1].get("block_start", len(latex_text)))
        boundary = min(next_start or len(latex_text), section_end)
        bullets = []
        for b_idx, bullet in enumerate(_scan_resume_items(latex_text, block_end, boundary)):
            bullets.append(
                {
                    "id": f"pj{idx}_{b_idx}",
                    "text": bullet.get("text", ""),
                    "range": bullet.get("range", (0, 0)),
                }
            )
        groups.append(
            {
                "project_id": f"pj{idx}",
                "name": str(heading.get("name", "")),
                "dates": str(heading.get("dates", "")),
                "name_range": heading.get("name_range"),
                "dates_range": heading.get("dates_range"),
                "bullets": bullets,
            }
        )
    return groups


def _truncate_preserve_words(text: str, max_len: int) -> str:
    cleaned = text.strip()
    if len(cleaned) <= max_len:
        return cleaned
    truncated = cleaned[:max_len].rstrip()
    if " " not in truncated:
        return truncated
    return truncated.rsplit(" ", 1)[0].rstrip()


def _replace_unicode_artifacts(text: str) -> str:
    return (
        text.replace("Â¡", "under ")
        .replace("¡", "under ")
    )


def _strip_trailing_dashes(text: str) -> str:
    """Remove trailing em dashes, en dashes, hyphens, and pipes from skill lines."""
    cleaned = re.sub(r"\s*[—–\-|]+\s*$", "", text)
    cleaned = re.sub(r"\s*[—–\-|]\s*[—–\-|]*\s*$", "", cleaned)
    return cleaned.strip()


def _format_skills_headings(text: str) -> str:
    normalized = text.replace("\\\\", " ").replace("\n", " ")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    normalized = re.sub(r"\\textbf\{([^}]*)\}", r"\1", normalized)
    pattern = re.compile(r"([A-Za-z][A-Za-z0-9/&\-\s]*?:)")
    matches = list(pattern.finditer(normalized))
    if not matches:
        return _strip_trailing_dashes(text.strip())

    lines: List[str] = []
    prefix = normalized[:matches[0].start()].strip()
    if prefix:
        lines.append(_strip_trailing_dashes(prefix))
    for i, m in enumerate(matches):
        heading = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(normalized)
        content = normalized[start:end].strip()
        content = _strip_trailing_dashes(content)
        if not content:
            continue
        lines.append(f"\\textbf{{{heading}}} {content}")
    return " \\\\ ".join(lines).strip()


def _extract_resume_plain_text(latex_text: str) -> str:
    parts: List[str] = []
    experiences = _parse_experience_groups(latex_text)
    for exp in experiences:
        header = " | ".join(
            [exp.get("company", ""), exp.get("title", ""), exp.get("dates", "")]
        ).strip(" |")
        if header:
            parts.append(header)
        for b in exp.get("bullets", []):
            txt = str(b.get("text", "")).strip()
            if txt:
                parts.append(f"- {txt}")

    projects = _parse_project_groups(latex_text)
    if projects:
        parts.append("Projects")
    for proj in projects:
        name = str(proj.get("name", "")).strip()
        if name:
            parts.append(name)
        for b in proj.get("bullets", []):
            txt = str(b.get("text", "")).strip()
            if txt:
                parts.append(f"- {txt}")

    skills = _parse_latex_skills_section(latex_text)
    if skills:
        parts.append("Skills")
        parts.append(skills[2])

    return "\n".join([p for p in parts if p]).strip()

def _parse_latex_resume_subheadings(latex_text: str) -> Tuple[List[Dict[str, object]], List[Tuple[int, int]]]:
    """
    Deterministically parse \\resumeSubheading{...}{...}{...}{...} blocks using brace depth tracking.
    Returns subheading dicts and (start, end) indices for the title content only.
    """
    def _looks_like_date_range(text: str) -> bool:
        if not text:
            return False
        lowered = text.lower()
        months = [
            "jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "sept", "oct", "nov", "dec",
        ]
        if any(m in lowered for m in months):
            return True
        if any(token in lowered for token in ["present", "current"]):
            return True
        if re.search(r"\b(19|20)\d{2}\b", lowered) and re.search(r"[-–—]|to", lowered):
            return True
        return False

    subheadings: List[Dict[str, object]] = []
    ranges: List[Tuple[int, int]] = []
    idx = 0
    needle = "\\resumeSubheading"
    while idx < len(latex_text):
        start = latex_text.find(needle, idx)
        if start == -1:
            break
        i = start + len(needle)
        while i < len(latex_text) and latex_text[i].isspace():
            i += 1
        if i >= len(latex_text) or latex_text[i] != "{":
            idx = i
            continue

        fields: List[str] = []
        field_ranges: List[Tuple[int, int]] = []
        parse_failed = False
        for _ in range(4):
            if i >= len(latex_text) or latex_text[i] != "{":
                parse_failed = True
                break
            content_start = i + 1
            depth = 1
            j = content_start
            while j < len(latex_text) and depth > 0:
                ch = latex_text[j]
                if ch == "{" and latex_text[j - 1] != "\\":
                    depth += 1
                elif ch == "}" and latex_text[j - 1] != "\\":
                    depth -= 1
                j += 1
            if depth != 0:
                parse_failed = True
                break
            content_end = j - 1
            fields.append(latex_text[content_start:content_end].strip())
            field_ranges.append((content_start, content_end))
            i = j
            while i < len(latex_text) and latex_text[i].isspace():
                i += 1

        if not parse_failed and len(fields) == 4:
            title_field = fields[2]
            company_field = fields[0]
            dates_field = fields[3]
            location_field = fields[1]
            title_start, title_end = field_ranges[2]
            company_start, company_end = field_ranges[0]

            if _looks_like_date_range(fields[1]) and not _looks_like_date_range(fields[3]):
                # Handle templates that use {Title}{Dates}{Company}{Location}.
                title_field = fields[0]
                company_field = fields[2]
                dates_field = fields[1]
                location_field = fields[3]
                title_start, title_end = field_ranges[0]
                company_start, company_end = field_ranges[2]

            subheadings.append(
                {
                    "id": f"lhs{len(subheadings)}",
                    "company": company_field,
                    "location": location_field,
                    "title": title_field,
                    "dates": dates_field,
                    "title_range": [title_start, title_end],
                    "company_range": [company_start, company_end],
                    "block_start": start,
                    "block_end": i,
                }
            )
            ranges.append((title_start, title_end))

        idx = i if i > start else start + len(needle)

        if parse_failed and i == start + len(needle):
            break

    if not subheadings:
        raise HTTPException(
            status_code=400,
            detail="No \\resumeSubheading{...} entries found in this LaTeX template.",
        )
    return subheadings, ranges


def _parse_latex_skills_section(latex_text: str) -> Optional[Tuple[int, int, str]]:
    """
    Extract the technical skills section content inside the first \\item{...} within its itemize block.
    Returns (start, end, text) or None if not found.
    """
    section_range = _section_range_any_of(latex_text, SKILLS_SECTION_NAMES)
    if not section_range:
        return None
    section_start, section_end = section_range
    rest = latex_text[section_start:section_end]

    begin_itemize = re.search(r"\\begin\{itemize\}(?:\[[^\]]*\])?", rest)
    if begin_itemize:
        content_start = section_start + begin_itemize.end()
        after_begin = latex_text[content_start:section_end]
        end_itemize = re.search(r"\\end\{itemize\}", after_begin)
        if end_itemize:
            itemize_block = after_begin[:end_itemize.start()]
            item_start = itemize_block.find("\\item{")
            if item_start != -1:
                item_content_start = content_start + item_start + len("\\item{")
                depth = 1
                i = item_content_start
                while i < len(latex_text) and depth > 0:
                    ch = latex_text[i]
                    if ch == "{" and latex_text[i - 1] != "\\":
                        depth += 1
                    elif ch == "}" and latex_text[i - 1] != "\\":
                        depth -= 1
                    i += 1
                if depth == 0:
                    item_content_end = i - 1
                    text = latex_text[item_content_start:item_content_end].strip()
                    return (item_content_start, item_content_end, text)

    text = latex_text[section_start:section_end].strip()
    return (section_start, section_end, text)




def _escape_latex(text: str) -> str:
    # Escape characters that commonly break LaTeX compilation.
    replacements = {
        "%": r"\%",
        "$": r"\$",
        "&": r"\&",
        "_": r"\_",
        "#": r"\#",
        "{": r"\{",
        "}": r"\}",
    }
    out = []
    for ch in text:
        out.append(replacements.get(ch, ch))
    return "".join(out)


def _escape_latex_text_keep_commands(text: str) -> str:
    # Escape special chars but keep backslashes/braces for existing LaTeX commands.
    def _escape_char(match: re.Match) -> str:
        ch = match.group(0)
        return "\\" + ch

    return re.sub(r"(?<!\\)([%$&#_])", _escape_char, text)


def _sanitize_latex_bullet(candidate: str) -> str:
    """
    Ensure bullet content contains no LaTeX commands or backslashes.
    Bullets are plain text inside \\resumeItem{...}.
    """
    cleaned = re.sub(r"\\[A-Za-z]+", "", candidate)
    cleaned = cleaned.replace("\\", "")
    cleaned = re.sub(r"\bw/\b", "with", cleaned)
    # Replace < and its corrupted forms with "under"
    cleaned = cleaned.replace("Â¡", "under ")
    cleaned = cleaned.replace("¡", "under ")
    cleaned = re.sub(r'<\s*', 'under ', cleaned)
    # Also handle > while we're at it
    cleaned = re.sub(r'>\s*', 'over ', cleaned)
    return cleaned


def _sanitize_latex_content(original: str, candidate: str) -> str:
    """
    Prevent new LaTeX commands by stripping any backslash commands not present in original.
    This preserves formatting while avoiding compile-breaking commands.
    """
    allowed_cmds = set(re.findall(r"\\[A-Za-z]+", original))
    allowed_cmds.add("\\textbf")

    def _cmd_repl(match: re.Match) -> str:
        cmd = match.group(0)
        return cmd if cmd in allowed_cmds else cmd.lstrip("\\")

    cleaned = re.sub(r"\\[A-Za-z]+", _cmd_repl, candidate)
    return cleaned


def _validate_latex_template(content: str) -> None:
    begin_count = len(re.findall(r"\\begin\{document\}", content))
    end_count = len(re.findall(r"\\end\{document\}", content))
    if begin_count != 1 or end_count != 1:
        raise HTTPException(
            status_code=400,
            detail="LaTeX template must contain exactly one \\begin{document} and one \\end{document}.",
        )


def _apply_replacements(text: str, replacements: List[Tuple[int, int, str]]) -> str:
    # Apply replacements from back to front to keep indices stable.
    out = text
    for start, end, repl in sorted(replacements, key=lambda x: x[0], reverse=True):
        out = out[:start] + repl + out[end:]
    return out


def _format_title_replacement(original_raw: str, updated_title: str) -> str:
    """
    Preserve outer LaTeX formatting (e.g., \\textit{...}) when replacing a title.
    """
    leading = len(original_raw) - len(original_raw.lstrip())
    trailing = len(original_raw) - len(original_raw.rstrip())
    core = original_raw.strip()
    escaped_title = _escape_latex(updated_title.strip())

    if core.startswith("\\"):
        i = 1
        while i < len(core) and core[i].isalpha():
            i += 1
        cmd = core[:i]
        j = i
        while j < len(core) and core[j].isspace():
            j += 1
        if j < len(core) and core[j] == "{":
            depth = 1
            k = j + 1
            while k < len(core) and depth > 0:
                ch = core[k]
                if ch == "{" and core[k - 1] != "\\":
                    depth += 1
                elif ch == "}" and core[k - 1] != "\\":
                    depth -= 1
                k += 1
            if depth == 0 and core[k:].strip() == "":
                return (" " * leading) + cmd + "{" + escaped_title + "}" + (" " * trailing)

    return (" " * leading) + escaped_title + (" " * trailing)


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


def _latex_section_range(latex: str, section_name: str) -> Optional[Tuple[int, int]]:
    """
    Return the (start, end) indices for the body of a LaTeX section by name.
    """
    needle = f"\\section{{{section_name}}}"
    start = latex.find(needle)
    if start == -1:
        return None
    body_start = start + len(needle)
    next_section = latex.find("\\section{", body_start)
    if next_section == -1:
        return (body_start, len(latex))
    return (body_start, next_section)


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
        model=OPENAI_MODEL_CHEAP,
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
        model=OPENAI_MODEL_CHEAP,
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


def _call_openai_outreach_preview(job_description: str, resume_text: str) -> Dict[str, object]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")
    if not resume_text.strip():
        raise HTTPException(status_code=400, detail="Resume text is empty; cannot generate outreach preview.")

    job_title = _extract_job_title(job_description)
    target_roles = _build_target_roles(job_title, job_description)
    company = _extract_company_hint(job_description)
    team = _extract_team_hint(job_description)
    linkedin_searches = _call_openai_linkedin_queries(job_description, company, team)
    outreach_message = _call_openai_outreach_message(job_description, job_title, company, resume_text)

    return {
        "target_roles": target_roles,
        "linkedin_searches": linkedin_searches,
        "outreach_message": outreach_message,
    }


def _build_linkedin_searches(search_queries: List[str]) -> List[Dict[str, str]]:
    searches: List[Dict[str, str]] = []
    for query in search_queries:
        label = query.strip()
        if not label:
            continue
        url = f"https://www.linkedin.com/search/results/people/?keywords={quote(label)}"
        searches.append({"label": label, "url": url})
    return searches


def _call_openai_linkedin_queries(
    job_description: str,
    company: Optional[str],
    team: Optional[str],
) -> List[Dict[str, str]]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")
    instructions = (
        "You generate LinkedIn PEOPLE search queries for job outreach.\n"
        "\n"
        "Return JSON ONLY:\n"
        "{\n"
        "  \"queries\": [\n"
        "    { \"label\": \"...\", \"keywords\": \"...\" }\n"
        "  ]\n"
        "}\n"
        "\n"
        "Rules (STRICT):\n"
        "- Generate 4–6 queries\n"
        "- Queries must return REAL PEOPLE on LinkedIn\n"
        "- NO quotes\n"
        "- NO site: or Google-only operators\n"
        "- Max ~6 words per query\n"
        "- Prefer: job title + company and/or team\n"
        "- Do NOT over-specify technologies\n"
        "- Company name is optional but encouraged\n"
        "- If team/org is present in JD, include it"
    )
    payload = {
        "job_description": job_description,
        "company": company or "",
        "team": team or "",
    }
    resp = client.chat.completions.create(
        model=OPENAI_MODEL_CHEAP,
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
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    queries = data.get("queries")
    if not isinstance(queries, list):
        queries = []

    searches: List[Dict[str, str]] = []
    for entry in queries:
        if not isinstance(entry, dict):
            continue
        label = str(entry.get("label") or "").strip()
        keywords = str(entry.get("keywords") or "").strip()
        if not label or not keywords:
            continue
        url = f"https://www.linkedin.com/search/results/people/?keywords={quote(keywords)}"
        searches.append({"label": label, "url": url})
        if len(searches) >= 6:
            break

    if searches:
        return searches

    job_title = _extract_job_title(job_description)
    fallback_roles = _build_target_roles(job_title, job_description)[:4]
    fallback_queries = []
    for role in fallback_roles:
        parts = [company, role] if company else [role]
        query = " ".join([p for p in parts if p]).strip()
        if query:
            fallback_queries.append(query)
    return _build_linkedin_searches(fallback_queries)


def _extract_job_title(job_description: str) -> str:
    patterns = [
        r"(?im)^\s*(job\s*title|title|role|position)\s*[:\-]\s*(.+)$",
        r"(?im)^\s*([A-Z][A-Za-z0-9 /,&\-]{2,60}Engineer)\s*$",
    ]
    for pattern in patterns:
        m = re.search(pattern, job_description)
        if m:
            candidate = m.group(m.lastindex or 0).strip()
            candidate = re.sub(r"\s+", " ", candidate)
            if candidate:
                return candidate
    known_titles = [
        "Software Engineer",
        "Internal Tools Engineer",
        "Full Stack Engineer",
        "Platform Engineer",
        "Backend Engineer",
    ]
    for title in known_titles:
        if re.search(rf"(?i)\b{re.escape(title)}\b", job_description):
            return title
    return "Software Engineer"


def _extract_company_hint(job_description: str) -> Optional[str]:
    patterns = [
        r"(?im)^\s*company\s*[:\-]\s*(.+)$",
        r"(?im)^\s*about\s+([A-Z][\w&.,\- ]{2,60})$",
    ]
    for pattern in patterns:
        m = re.search(pattern, job_description)
        if m:
            candidate = re.sub(r"\s+", " ", m.group(1).strip())
            if 2 <= len(candidate) <= 60:
                return candidate
    m = re.search(r"(?i)\b(?:at|for)\s+([A-Z][A-Za-z0-9&.,\- ]{2,60})", job_description)
    if m:
        candidate = re.sub(r"\s+", " ", m.group(1).strip())
        return candidate[:60]
    return None


def _extract_team_hint(job_description: str) -> Optional[str]:
    patterns = [
        r"(?im)(?:join|on|within)\s+(?:the\s+)?([A-Z][A-Za-z0-9\s&-]{2,30})\s+team",
        r"(?im)([A-Z][A-Za-z0-9\s&-]{2,30})\s+(?:team|org|organization|group)",
    ]
    for pattern in patterns:
        m = re.search(pattern, job_description)
        if m:
            candidate = m.group(1).strip()
            candidate = re.sub(r"\s+", " ", candidate)
            return candidate
    return None


def _build_target_roles(job_title: str, job_description: str) -> List[str]:
    target_roles: List[str] = []
    if job_title:
        target_roles.append(job_title)

    jd_lower = job_description.lower()
    role_patterns = [
        ("internal tools", "Internal Tools Engineer"),
        ("platform", "Platform Engineer"),
        ("full stack", "Full Stack Engineer"),
        ("fullstack", "Full Stack Engineer"),
        ("backend", "Backend Engineer"),
        ("frontend", "Frontend Engineer"),
        ("data engineer", "Data Engineer"),
        ("devops", "DevOps Engineer"),
        ("sre", "Site Reliability Engineer"),
        ("infrastructure", "Infrastructure Engineer"),
    ]
    for keyword, role in role_patterns:
        if keyword in jd_lower and role not in target_roles:
            target_roles.append(role)
        if len(target_roles) >= 6:
            break

    fallback = ["Software Engineer", "Full Stack Engineer", "Backend Engineer"]
    for role in fallback:
        if role not in target_roles:
            target_roles.append(role)
        if len(target_roles) >= 6:
            break

    return target_roles[:6]


def _call_openai_outreach_message(
    job_description: str,
    job_title: str,
    company: Optional[str],
    resume_text: str,
) -> str:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")
    instructions = (
        "You write ONE concise LinkedIn outreach message.\n"
        "\n"
        "Return JSON ONLY:\n"
        "{ \"outreach_message\": \"...\" }\n"
        "\n"
        "Rules (STRICT):\n"
        "- 3-4 sentences max, under 70 words\n"
        "- Start with: \"Hi {Name} —\" (keep {Name} as placeholder)\n"
        "- Mention you applied for the specific role\n"
        "- Reference 1-2 relevant experiences from the resume that match the JD\n"
        "- Show genuine interest in the company/team (not generic)\n"
        "- End with low-pressure ask (\"Would love to chat\" or \"Happy to share more\")\n"
        "- No emojis, no fluff, no markdown, no bullet points\n"
        "- Sound human, not templated\n"
    )
    payload = {
        "job_description": job_description,
        "job_title": job_title,
        "company": company or "",
        "resume_text": resume_text,
    }
    resp = client.chat.completions.create(
        model=OPENAI_MODEL_CHEAP,
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
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    message = data.get("outreach_message")
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(status_code=500, detail="OpenAI returned invalid outreach_message.")
    return message.strip()


def _call_openai_rewrite_bullets_only(
    job_description: str,
    bullets: List[Dict[str, str]],
    risk_level: str = "maximum",
) -> Dict[str, str]:
    """
    AI only rewrites bullet TEXT. Returns {id: new_text}.
    Structure is NEVER touched.
    """
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    instructions = (
        "You are a resume bullet rewriting engine.\n"
        "Goal: tailor resume bullets to maximize interview selection for the job description.\n"
        "\n"
        "RISK LEVEL GUIDE:\n"
        "- conservative: Minor tweaks, add 1-2 keywords, keep original meaning\n"
        "- balanced: Moderate rewrite, add keywords, maintain core truth\n"
        "- aggressive: Heavy rewrite, maximize keywords, stretch/exaggerate accomplishments\n"
        "- maximum: Complete rewrite to match JD perfectly, invent plausible details if needed\n"
        "\n"
        f"Current risk_level: {risk_level}\n"
        "\n"
        "Rules (STRICT — MUST FOLLOW ALL):\n"
        "1) Return JSON ONLY in the exact format: {\"bullets\":[{\"id\":\"...\",\"text\":\"...\"}]}. No extra text.\n"
        "2) Return EXACTLY the same number of bullets with the SAME IDs in the SAME order.\n"
        "3) CRITICAL: Each bullet MUST be <= 130 characters. Count carefully. This is a HARD LIMIT.\n"
        "4) Aggressively reword to align with the job description, even if that means rewriting most of the bullet.\n"
        "5) Start each bullet with a strong past-tense action verb.\n"
        "6) Use Google XYZ resume style (Accomplished X by doing Y, resulting in Z).\n"
        "7) Include ALL major job-description keywords explicitly; prefer stronger keyword density over subtlety.\n"
        "8) Quantify results wherever plausible.\n"
        "9) Bullets should be story-driven but compact; remove filler to make room for keywords.\n"
        "10) Preserve the essence of each experience (e.g., lab/retail/marketplace/supply chain context).\n"
        "11) Return ONLY plain text - NO LaTeX commands, NO backslashes, NO special characters like \\textbf.\n"
        "12) Apply the requested risk_level to keyword density and reframing; do NOT change seniority.\n"
        "\n"
        "CRITICAL: You are ONLY rewriting bullet text. Do NOT return titles, companies, dates, or any structure.\n"
    )

    payload = {
        "job_description": job_description,
        "bullets": bullets,
        "risk_level": risk_level,
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL_RESUME,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.8,
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

    result: Dict[str, str] = {}
    for item in data.get("bullets", []):
        bid = str(item.get("id", "")).strip()
        new_text = str(item.get("text", "")).replace("\n", " ").strip()
        if bid and new_text:
            result[bid] = new_text

    return result


def _call_openai_rewrite_titles(
    job_description: str,
    titles: List[Dict[str, str]],
) -> Dict[str, str]:
    """
    AI rewrites job titles only. Returns {id: new_title}.
    """
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    instructions = (
        "You are a resume title optimization engine.\n"
        "Goal: adjust job titles to better align with the target job description while staying truthful.\n"
        "\n"
        "Rules (STRICT):\n"
        "1) Return JSON ONLY: {\"titles\":[{\"id\":\"...\",\"title\":\"...\"}]}\n"
        "2) Return EXACTLY the same number of titles with the SAME IDs.\n"
        "3) Each title MUST be <= 80 characters.\n"
        "4) Only adjust titles if it improves alignment - don't change for no reason.\n"
        "5) Keep titles realistic and truthful to the company/role context.\n"
        "6) Do NOT invent seniority (don't turn 'Engineer' into 'Senior Engineer').\n"
        "7) Return ONLY plain text - no LaTeX.\n"
    )

    payload = {
        "job_description": job_description,
        "titles": titles,
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL_RESUME,
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

    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    result: Dict[str, str] = {}
    for item in data.get("titles", []):
        tid = str(item.get("id", "")).strip()
        new_title = str(item.get("title", "")).replace("\n", " ").strip()
        if tid and new_title:
            result[tid] = new_title

    return result


def _call_openai_rewrite_skills(
    job_description: str,
    current_skills: str,
    max_chars: int = 1000,
) -> str:
    """
    AI rewrites skills section. Returns new skills text.
    """
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    # Count how many categories the original has
    original_categories = len(re.findall(r"\\textbf\{[^}]+\}", current_skills))
    if original_categories == 0:
        original_categories = len(re.findall(r"[A-Za-z][A-Za-z\s&/]+:", current_skills))

    instructions = (
        "You are a resume skills section optimizer.\n"
        "Goal: reorder and adjust skills to highlight those most relevant to the job description.\n"
        "\n"
        "Rules (STRICT):\n"
        "1) Return JSON ONLY: {\"skills\":\"...\"}\n"
        f"2) Skills text MUST be <= {max_chars} characters.\n"
        f"3) Use EXACTLY {max(original_categories, 3)} category lines.\n"
        "4) Format EACH category as: \\textbf{Category:} skill1, skill2, skill3\n"
        "5) Separate categories with ' \\\\\\\\ ' (that's 4 backslashes for LaTeX line break).\n"
        "6) Prioritize skills mentioned in the job description.\n"
        "7) NO trailing dashes, pipes, or em dashes.\n"
        "8) Each category name should NOT contain '&' - use 'and' instead.\n"
        "9) Keep category names SHORT (1-2 words max, like 'Languages', 'Backend', 'Cloud').\n"
        "\n"
        "Example output format:\n"
        "\\textbf{Languages:} Python, Java, SQL \\\\\\\\ \\textbf{Backend:} FastAPI, Redis \\\\\\\\ \\textbf{Cloud:} AWS, Docker\n"
    )

    payload = {
        "job_description": job_description,
        "current_skills": current_skills,
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL_RESUME,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    text = (resp.choices[0].message.content or "").strip()
    if not text:
        return current_skills

    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return current_skills
        data = json.loads(m.group(0))

    new_skills = str(data.get("skills", "")).strip()
    if not new_skills:
        return current_skills
    
    # Post-process: ensure proper line breaks
    # Replace "& " in category names with "and "
    new_skills = re.sub(r"\\textbf\{([^}]*?)&([^}]*?)\}", r"\\textbf{\1and\2}", new_skills)
    
    # Ensure \\ are present between categories
    # If AI forgot them, add them before each \textbf{ except the first
    if " \\\\ " not in new_skills and "\\textbf{" in new_skills:
        parts = re.split(r"(?=\\textbf\{)", new_skills)
        parts = [p.strip() for p in parts if p.strip()]
        new_skills = " \\\\ ".join(parts)
    
    return new_skills


def _call_openai_rewrite_skills_plain(
    job_description: str,
    current_skills: str,
    max_chars: int = 1000,
    target_lines: Optional[int] = None,
) -> str:
    """
    AI rewrites skills section in plain text (no LaTeX). Returns new skills text.
    """
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    line_rule = ""
    if target_lines:
        line_rule = f"3) Use EXACTLY {target_lines} lines, separated by newlines.\n"
    instructions = (
        "You are a resume skills section optimizer.\n"
        "Goal: reorder and adjust skills to highlight those most relevant to the job description.\n"
        "\n"
        "Rules (STRICT):\n"
        "1) Return JSON ONLY: {\"skills\":\"...\"}\n"
        f"2) Skills text MUST be <= {max_chars} characters.\n"
        f"{line_rule}"
        "4) Use clear category lines like: Category: skill1, skill2, skill3\n"
        "5) Keep content concise and relevant to the job description.\n"
        "6) No LaTeX commands or markdown.\n"
    )

    payload = {
        "job_description": job_description,
        "skills": current_skills,
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL_RESUME,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    text = (resp.choices[0].message.content or "").strip()
    if not text:
        return current_skills

    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return current_skills
        data = json.loads(m.group(0))

    new_skills = str(data.get("skills", "")).replace("\r", "").strip()
    if not new_skills:
        return current_skills
    if len(new_skills) > max_chars:
        new_skills = new_skills[:max_chars].rstrip()
    return new_skills


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
        model=OPENAI_MODEL_CHEAP,
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


def _call_openai(
    job_description: str,
    slots: List[Slot],
    role_context: Optional[Dict[str, str]] = None,
    risk_level: str = "balanced",
) -> List[OptimizeResult]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")

    instructions = (
        "You are a resume bullet rewriting engine.\n"
        "Goal: tailor resume bullets to maximize interview selection for the job description.\n"
        "\n"
        "Rules (STRICT — MUST FOLLOW ALL):\n"
        "1) Return JSON ONLY in the exact format: {\"results\":[{\"id\":...,\"updated_text\":...}]}. No extra text.\n"
        "2) updated_text MUST be a single line (no line breaks) and MUST be <= max_chars (max 130 chars).\n"
        "3) Aggressively reword to align with the job description, even if that means rewriting most of the bullet.\n"
        "4) Start each bullet with a strong past-tense action verb.\n"
        "5) Use Google XYZ resume style.\n"
        "6) Include ALL major job-description keywords explicitly; prefer stronger keyword density over subtlety.\n"
        "7) Quantify results wherever plausible.\n"
        "8) Bullets should be story-driven but compact; remove filler to make room for keywords.\n"
        "9) Preserve the essence of each experience (e.g., lab/retail/marketplace/supply chain context).\n"
        "10) You MAY change job titles as needed to improve alignment.\n"
        "11) Preserve ATS-safe formatting; avoid special characters or new LaTeX commands.\n"
        "12) Bullets must align with the provided role title and role summary.\n"
        "13) Apply the requested risk_level to keyword density and reframing; do NOT change seniority.\n"
    )

    payload = {
        "job_description": job_description,
        "resume_slots": [s.model_dump() for s in slots],
        "risk_level": risk_level,
    }
    if role_context:
        payload.update(role_context)

    # Use Chat Completions API for broad compatibility with installed SDK versions.
    resp = client.chat.completions.create(
        model=OPENAI_MODEL_RESUME,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.35,
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




def _extract_latex_text(latex_text: str) -> str:
    """
    Extract plain-ish text from LaTeX by pulling resume items + skills section content.
    """
    keyword_hint: List[str] = []
    parts: List[str] = []
    try:
        grouped = _parse_latex_resume_items(latex_text, keyword_hint)
        for group in grouped:
            for bullet in group.get("bullets", []):
                text = str(bullet.get("text", "")).strip()
                if text:
                    parts.append(text)
    except HTTPException:
        pass
    skills = _parse_latex_skills_section(latex_text)
    if skills:
        parts.append(skills[2])
    return "\n".join(parts).strip()


def _format_error_summary(compile_result: CompilationResult) -> str:
    if compile_result.latex_errors:
        lines = ["LaTeX compilation failed:"]
        for err in compile_result.latex_errors[:5]:
            line_num = err.get("line_number")
            msg = err.get("message", "Unknown error")
            error_type = err.get("error_type", "")
            if line_num:
                lines.append(f"  - Line {line_num} ({error_type}): {msg}")
            else:
                lines.append(f"  - {error_type}: {msg}")
        return "\n".join(lines)
    if compile_result.log_content:
        log_tail = compile_result.log_content[-1000:]
        return f"LaTeX compilation failed.\n\nLog excerpt:\n{log_tail}"
    return "LaTeX compilation failed. Please check your template syntax."


def _compile_latex_to_pdf_bytes(latex_text: str, strict: bool = False) -> CompilationResult:
    with tempfile.TemporaryDirectory() as td:
        td_path = os.path.abspath(td)
        tex_path = os.path.join(td_path, "resume.tex")
        with open(tex_path, "w", encoding="utf-8") as f:
            f.write(latex_text)

        def _read_log() -> str:
            log_path = os.path.join(td_path, "resume.log")
            if not os.path.exists(log_path):
                return ""
            try:
                with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                    return f.read()
            except OSError:
                return ""

        def _parse_log(log_content: str) -> Tuple[List[str], List[str], int]:
            if not log_content:
                return [], [], 0
            lines = log_content.splitlines()
            warnings = [line for line in lines if "Warning:" in line]
            errors = [line for line in lines if "Error:" in line or "!" in line]
            passes = log_content.count("Run number")
            return warnings, errors, passes

        def _parse_latex_errors(log_content: str) -> List[Dict[str, Optional[Union[int, str]]]]:
            if not log_content:
                return []
            lines = log_content.splitlines()
            results: List[Dict[str, Optional[Union[int, str]]]] = []
            line_re = re.compile(r"l\.(\d+)")
            package_re = re.compile(r"Package\s+(\S+)\s+Error:\s*(.*)")

            for idx, line in enumerate(lines):
                if not line.startswith("!"):
                    continue
                raw = line[1:].strip()
                error_type = "Unknown error"
                message = raw
                if raw.startswith("Undefined control sequence"):
                    error_type = "Undefined control sequence"
                elif raw.startswith("Missing $ inserted"):
                    error_type = "Missing $ inserted"
                elif raw.startswith("Missing character"):
                    error_type = "Missing character"
                elif raw.startswith("LaTeX Error:"):
                    error_type = "LaTeX Error"
                    message = raw.replace("LaTeX Error:", "", 1).strip() or raw
                elif raw.startswith("Package "):
                    match = package_re.match(raw)
                    error_type = "Package error"
                    if match:
                        pkg, detail = match.groups()
                        message = f"{pkg}: {detail}".strip(": ").strip()

                line_number = None
                for lookahead in range(0, 3):
                    if idx + lookahead >= len(lines):
                        break
                    match = line_re.search(lines[idx + lookahead])
                    if match:
                        line_number = int(match.group(1))
                        break

                results.append(
                    {
                        "line_number": line_number,
                        "message": message,
                        "error_type": error_type,
                    }
                )
            return results

        def _has_nontransient_error(log_content: str) -> bool:
            if not log_content:
                return False
            lowered = log_content.lower()
            nontransient_markers = [
                "undefined control sequence",
                "missing $ inserted",
                "missing } inserted",
                "extra }",
                "runaway argument",
                "file ended while scanning",
                "latex error",
                "emergency stop",
            ]
            return any(marker in lowered for marker in nontransient_markers)

        def _should_retry(log_content: str, timeout_related: bool) -> bool:
            if not timeout_related:
                return False
            if _has_nontransient_error(log_content):
                return False
            return True

        if USE_LATEXMK:
            command = ["latexmk", "-pdf", "-interaction=batchmode", "-f", "-cd", "resume.tex"]
            tool_name = "latexmk"
        else:
            command = ["pdflatex", "-interaction=nonstopmode", "resume.tex"]
            tool_name = "pdflatex"

        max_retries = 2 if USE_LATEXMK else 0
        timeout_seconds = 120
        attempt = 0
        last_log_content = ""
        while True:
            try:
                result = subprocess.run(
                    command,
                    cwd=td_path,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=timeout_seconds,
                )
                if not USE_LATEXMK:
                    subprocess.run(
                        command,
                        cwd=td_path,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=timeout_seconds,
                    )
                last_log_content = _read_log()
                timeout_related = result.returncode in {124, 137}
                if result.returncode != 0 and attempt < max_retries and _should_retry(
                    last_log_content, timeout_related=timeout_related
                ):
                    attempt += 1
                    time.sleep(1)
                    continue
                break
            except subprocess.TimeoutExpired:
                last_log_content = _read_log()
                if attempt < max_retries and _should_retry(last_log_content, timeout_related=True):
                    attempt += 1
                    time.sleep(1)
                    continue
                warnings, errors, passes = _parse_log(last_log_content)
                latex_errors = _parse_latex_errors(last_log_content)
                errors.append(f"LaTeX compilation timed out after {timeout_seconds} seconds.")
                return CompilationResult(
                    success=False,
                    log_content=last_log_content or None,
                    warnings=warnings,
                    errors=errors,
                    latex_errors=latex_errors,
                    passes=passes,
                )
            except Exception as exc:
                last_log_content = _read_log()
                warnings, errors, passes = _parse_log(last_log_content)
                latex_errors = _parse_latex_errors(last_log_content)
                errors.append(f"LaTeX compilation error: {exc}")
                return CompilationResult(
                    success=False,
                    log_content=last_log_content or None,
                    warnings=warnings,
                    errors=errors,
                    latex_errors=latex_errors,
                    passes=passes,
                )

        pdf_path = os.path.join(td_path, "resume.pdf")
        log_content = last_log_content or _read_log()
        warnings, errors, passes = _parse_log(log_content)
        latex_errors = _parse_latex_errors(log_content)
        pdf_bytes = None
        if os.path.exists(pdf_path):
            with open(pdf_path, "rb") as f:
                pdf_bytes = f.read()

        success = pdf_bytes is not None and (not strict or not latex_errors)
        if pdf_bytes is None:
            errors.append(f"PDF output not found after {tool_name}.")

        return CompilationResult(
            success=success,
            pdf_bytes=pdf_bytes,
            log_content=log_content or None,
            warnings=warnings,
            errors=errors,
            latex_errors=latex_errors,
            passes=passes,
        )


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": OPENAI_MODEL_RESUME,
        "model_resume": OPENAI_MODEL_RESUME,
        "model_cheap": OPENAI_MODEL_CHEAP,
        "has_key": bool(OPENAI_API_KEY),
    }


@app.post("/auth/register")
def register(payload: RegisterRequest, db: OrmSession = Depends(get_db)):
    email = payload.email.strip().lower()
    password = payload.password.strip()
    first_name = payload.first_name.strip()
    last_name = payload.last_name.strip()
    if not email or not password or not first_name or not last_name:
        raise HTTPException(status_code=400, detail="Email, password, first name, and last name are required.")
    if len(password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail="Password must be 72 bytes or fewer.")

    existing = db.query(User).filter(User.email == email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered.")

    user = User(
        email=email,
        password_hash=hash_password(password),
        first_name=first_name,
        last_name=last_name,
    )
    db.add(user)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Failed to register user for email=%s", email)
        raise HTTPException(status_code=500, detail="Could not create user.") from exc
    db.refresh(user)
    return {"user_id": user.id}


@app.post("/auth/login")
def login(payload: LoginRequest, db: OrmSession = Depends(get_db)):
    email = payload.email.strip().lower()
    password = payload.password.strip()
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password are required.")
    if len(password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail="Password must be 72 bytes or fewer.")

    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    token = create_session_token()
    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    session = SessionModel(user_id=user.id, token=token, expires_at=expires_at)
    db.add(session)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Failed to create session for user_id=%s", user.id)
        raise HTTPException(status_code=500, detail="Could not create session.") from exc
    logger.info("User logged in: user_id=%s", user.id)
    return {
        "session_token": token,
        "email": user.email,
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
    }


@app.get("/auth/me")
def auth_me(user: User = Depends(get_current_user)):
    return {
        "email": user.email,
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
    }


@app.get("/latex/template")
def get_latex_template(
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    resume = (
        db.query(Resume)
        .filter(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
        .first()
    )
    return {
        "has_template": bool(resume and resume.latex_template),
        "latex_template": resume.latex_template if resume and resume.latex_template else "",
        "name": resume.name if resume else "",
    }


@app.get("/latex/last")
def get_last_compiled_latex(
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    resume = (
        db.query(Resume)
        .filter(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
        .first()
    )
    if not resume or not resume.optimized_latex:
        raise HTTPException(status_code=404, detail="No compiled LaTeX available yet.")
    logger.info("Resume loaded: user_id=%s resume_id=%s", user.id, resume.id)
    return {"latex": resume.optimized_latex}

@app.post("/latex/template")
async def set_latex_template(
    latex_text: str = Form(None),
    template: UploadFile = File(None),
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    content = ""
    name = "Resume"
    if template is not None:
        if not template.filename.lower().endswith(".tex"):
            raise HTTPException(status_code=400, detail="Please upload a .tex LaTeX template.")
        name = os.path.splitext(template.filename)[0] or name
        content = (await template.read()).decode("utf-8", errors="ignore")
    elif latex_text is not None:
        content = latex_text

    if not content.strip():
        raise HTTPException(status_code=400, detail="LaTeX template content is empty.")

    _validate_latex_template(content)
    resume = Resume(
        user_id=user.id,
        name=name,
        latex_template=content,
        optimized_latex=None,
    )
    db.add(resume)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Failed to save resume: user_id=%s name=%s", user.id, name)
        raise HTTPException(status_code=500, detail="Could not save resume.") from exc
    logger.info("Resume saved: user_id=%s resume_id=%s", user.id, resume.id)
    return {"ok": True, "message": "LaTeX template saved."}

@app.get("/auth/google")
def auth_google(session_token: str, db: OrmSession = Depends(get_db)):
    user = _get_user_for_token(session_token, db)
    flow = _google_flow()
    state = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=10)
    db.query(GoogleOAuthState).filter(GoogleOAuthState.expires_at < now).delete()
    db.add(GoogleOAuthState(user_id=user.id, state=state, expires_at=expires_at))
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Failed to store Google OAuth state: user_id=%s", user.id)
        raise HTTPException(status_code=500, detail="Could not start Google OAuth.") from exc
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
        state=state,
    )
    return RedirectResponse(auth_url)


@app.get("/auth/google/callback")
def auth_google_callback(request: Request, code: str, state: str, db: OrmSession = Depends(get_db)):
    record = db.query(GoogleOAuthState).filter(GoogleOAuthState.state == state).first()
    if not record:
        raise HTTPException(status_code=400, detail="Invalid OAuth state.")
    now = datetime.now(timezone.utc)
    expires_at = record.expires_at
    expired = False
    if expires_at.tzinfo is None:
        expired = expires_at <= datetime.utcnow()
    else:
        expired = expires_at <= now
    if expired:
        db.delete(record)
        db.commit()
        raise HTTPException(status_code=400, detail="OAuth state expired. Please try again.")
    user_id = record.user_id
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
    existing = db.query(GoogleCredential).filter(GoogleCredential.user_id == user_id).first()
    refresh_token = creds.refresh_token or (existing.refresh_token if existing else None)
    scopes = json.dumps(creds.scopes or GOOGLE_SCOPES)
    if existing:
        existing.token = creds.token
        existing.refresh_token = refresh_token
        existing.token_uri = creds.token_uri
        existing.client_id = creds.client_id
        existing.client_secret = creds.client_secret
        existing.scopes = scopes
        existing.expiry = creds.expiry
        db.add(existing)
    else:
        db.add(GoogleCredential(
            user_id=user_id,
            token=creds.token,
            refresh_token=refresh_token,
            token_uri=creds.token_uri,
            client_id=creds.client_id,
            client_secret=creds.client_secret,
            scopes=scopes,
            expiry=creds.expiry,
        ))
    db.delete(record)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Failed to store Google credentials: user_id=%s", user_id)
        raise HTTPException(status_code=500, detail="Could not save Google credentials.") from exc
    html = (
        "<!doctype html>"
        "<html><head><meta charset=\"utf-8\">"
        "<title>Google Docs connected</title></head>"
        "<body>"
        "<script>"
        "if (window.opener) {"
        "window.opener.postMessage({ type: 'google-auth-success' }, '*');"
        "}"
        "window.close();"
        "setTimeout(function(){"
        "document.body.innerHTML = '<p>Google Docs connected. You can close this tab.</p>';"
        "}, 200);"
        "</script>"
        "</body></html>"
    )
    return HTMLResponse(content=html)


@app.get("/google/docs")
def list_google_docs(user: User = Depends(get_current_user), db: OrmSession = Depends(get_db)):
    creds = _get_google_creds(user, db)
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
def optimize_google_doc(
    payload: GoogleDocOptimizeRequest,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    creds = _get_google_creds(user, db)
    docs = build("docs", "v1", credentials=creds)

    doc = docs.documents().get(documentId=payload.doc_id).execute()
    keyword_hint = _extract_keywords_from_jd(payload.job_description)
    slots, ranges = _extract_google_doc_slots(doc, keyword_hint)
    skills_block = _extract_google_doc_skills_block(doc)

    bullets_for_ai: List[Dict[str, str]] = []
    for slot in slots:
        bullets_for_ai.append(
            {
                "id": slot.id,
                "text": slot.text,
                "context": "",
                "max_chars": slot.max_chars,
            }
        )

    rewritten_bullets = _call_openai_rewrite_bullets_only(
        payload.job_description,
        bullets_for_ai,
        risk_level=payload.risk_level or "balanced",
    )

    replacements: List[Tuple[int, int, str, Optional[List[Tuple[int, int]]]]] = []
    for slot, (start_idx, end_idx) in zip(slots, ranges):
        new_text = rewritten_bullets.get(slot.id, slot.text)
        if not new_text:
            continue
        replacements.append((start_idx, end_idx, new_text, None))

    if skills_block:
        skills_text, skills_start, skills_end = skills_block
        line_count = len([line for line in skills_text.splitlines() if line.strip()])
        rewritten_skills = _call_openai_rewrite_skills_plain(
            payload.job_description,
            skills_text,
            target_lines=line_count if line_count else None,
        )
        if rewritten_skills:
            heading_ranges: List[Tuple[int, int]] = []
            offset = 0
            for line in rewritten_skills.splitlines():
                colon_idx = line.find(":")
                if colon_idx > 0:
                    heading_ranges.append((offset, offset + colon_idx + 1))
                offset += len(line) + 1
            replacements.append((skills_start, skills_end, rewritten_skills, heading_ranges))

    requests = []
    for start_idx, end_idx, new_text, heading_ranges in sorted(replacements, key=lambda x: x[0], reverse=True):
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
        if heading_ranges is not None:
            skills_end_idx = start_idx + len(new_text)
            requests.append({
                "updateTextStyle": {
                    "range": {"startIndex": start_idx, "endIndex": skills_end_idx},
                    "textStyle": {"bold": False},
                    "fields": "bold",
                }
            })
            for rel_start, rel_end in heading_ranges:
                if rel_start >= rel_end:
                    continue
                requests.append({
                    "updateTextStyle": {
                        "range": {
                            "startIndex": start_idx + rel_start,
                            "endIndex": start_idx + rel_end,
                        },
                        "textStyle": {"bold": True},
                        "fields": "bold",
                    }
                })

    if requests:
        docs.documents().batchUpdate(documentId=payload.doc_id, body={"requests": requests}).execute()

    return {"ok": True, "bullets_edited": len(rewritten_bullets), "keyword_hints": keyword_hint}


@app.post("/google/coverletter")
def coverletter_google_doc(
    payload: GoogleCoverLetterRequest,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    creds = _get_google_creds(user, db)
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


@app.post("/google/coverletter/preview")
def coverletter_google_preview(
    payload: GoogleCoverLetterPreviewRequest,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    creds = _get_google_creds(user, db)
    docs = build("docs", "v1", credentials=creds)

    resume_doc = docs.documents().get(documentId=payload.resume_doc_id).execute()
    resume_text = _extract_google_doc_text(resume_doc)
    cover_letter = _call_openai_cover_letter(payload.job_description, resume_text)
    return {"cover_letter": cover_letter}


@app.post("/google/docs/text")
def google_doc_text(
    payload: GoogleDocTextRequest,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    creds = _get_google_creds(user, db)
    docs = build("docs", "v1", credentials=creds)
    resume_doc = docs.documents().get(documentId=payload.doc_id).execute()
    resume_text = _extract_google_doc_text(resume_doc)
    return {"text": resume_text}


@app.post("/optimize")
async def optimize(
    job_description: str = Form(...),
    risk_level: str = Form("balanced"),
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    resume = (
        db.query(Resume)
        .filter(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
        .first()
    )
    if not resume or not resume.latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")
    logger.info("Resume loaded: user_id=%s resume_id=%s", user.id, resume.id)
    _validate_latex_template(resume.latex_template)

    cache_token = _request_cache.set({})
    try:
        baseline = resume.latex_template
        experiences = _parse_experience_groups(baseline)
        projects = _parse_project_groups(baseline)
        skills_parsed = _parse_latex_skills_section(baseline)

        bullets_for_ai: List[Dict[str, str]] = []
        bullet_ranges: Dict[str, Tuple[int, int]] = {}
        for exp in experiences:
            context = f"{exp.get('company', '')} - {exp.get('title', '')}"
            for bullet in exp.get("bullets", []):
                bid = str(bullet.get("id", ""))
                text = str(bullet.get("text", ""))
                ai_text = _sanitize_latex_bullet(text).replace("{", "").replace("}", "").strip()
                if not ai_text:
                    ai_text = re.sub(r"[{}]", "", text).strip()
                bullets_for_ai.append(
                    {
                        "id": bid,
                        "text": ai_text,
                        "context": context,
                        "max_chars": min(135, max(len(text) + 10, 80)),
                    }
                )
                bullet_ranges[bid] = bullet.get("range", (0, 0))

        titles_for_ai: List[Dict[str, str]] = []
        for exp in experiences:
            exp_id = str(exp.get("experience_id", ""))
            bullet_summary = "; ".join([str(b.get("text", ""))[:50] for b in exp.get("bullets", [])[:3]])
            titles_for_ai.append(
                {
                    "id": exp_id,
                    "title": str(exp.get("title", "")),
                    "company": str(exp.get("company", "")),
                    "context": bullet_summary,
                }
            )

        rewritten_bullets = _call_openai_rewrite_bullets_only(job_description, bullets_for_ai, risk_level)
        rewritten_titles = _call_openai_rewrite_titles(job_description, titles_for_ai)

        rewritten_skills = ""
        if skills_parsed:
            rewritten_skills = _call_openai_rewrite_skills(job_description, skills_parsed[2])

        replacements: List[Tuple[int, int, str]] = []
        bullets_edited = 0
        updated_title_meta: List[Dict[str, str]] = []

        for bid, (start, end) in bullet_ranges.items():
            original = baseline[start:end]
            new_text = rewritten_bullets.get(bid, original)
            new_text = _sanitize_latex_bullet(new_text)
            new_text = _escape_latex(new_text)
            new_text = _truncate_preserve_words(new_text, 135)
            if new_text != original:
                bullets_edited += 1
            replacements.append((start, end, new_text))

        for exp in experiences:
            exp_id = str(exp.get("experience_id", ""))
            t_start, t_end = exp.get("title_range", (0, 0))
            original_raw = baseline[t_start:t_end]
            original_title = str(exp.get("title", ""))
            new_title = rewritten_titles.get(exp_id, original_title)[:80]
            replacements.append((t_start, t_end, _format_title_replacement(original_raw, new_title)))
            updated_title_meta.append(
                {
                    "id": exp_id,
                    "company": str(exp.get("company", "")),
                    "original_title": original_title,
                    "updated_title": new_title,
                }
            )

        if skills_parsed and rewritten_skills:
            s_start, s_end, s_original = skills_parsed
            # Skip _format_skills_headings - AI formats correctly now
            #formatted = _format_skills_headings(rewritten_skills)
            #sanitized = _sanitize_latex_content(s_original, formatted)
            escaped = _escape_latex_text_keep_commands(rewritten_skills)
            replacements.append((s_start, s_end, escaped))

        sorted_replacements = sorted(replacements, key=lambda x: x[0])
        for i in range(len(sorted_replacements) - 1):
            if sorted_replacements[i][1] > sorted_replacements[i + 1][0]:
                raise HTTPException(status_code=500, detail="Internal error: overlapping replacements")

        updated_latex = _apply_replacements(baseline, sorted_replacements)
        try:
            updated_experiences = _parse_experience_groups(updated_latex)
        except HTTPException:
            updated_experiences = experiences
        try:
            updated_projects = _parse_project_groups(updated_latex)
        except HTTPException:
            updated_projects = []
        resume.optimized_latex = updated_latex
        try:
            db.commit()
        except SQLAlchemyError as exc:
            db.rollback()
            logger.exception("Failed to save optimized resume: user_id=%s resume_id=%s", user.id, resume.id)
            raise HTTPException(status_code=500, detail="Could not save optimized resume.") from exc
        compile_result = _compile_latex_to_pdf_bytes(updated_latex)
        if not compile_result.pdf_bytes:
            raise HTTPException(status_code=400, detail=_format_error_summary(compile_result))
        pdf_bytes = compile_result.pdf_bytes

        import base64
        draft_bullets: List[Dict[str, str]] = []
        for exp in updated_experiences:
            exp_id = str(exp.get("experience_id", ""))
            for bullet in exp.get("bullets", []):
                draft_bullets.append(
                    {
                        "id": str(bullet.get("id", "")),
                        "text": str(bullet.get("text", "")).strip(),
                        "experience_id": exp_id,
                    }
                )
        draft_project_titles: List[Dict[str, str]] = []
        draft_project_dates: List[Dict[str, str]] = []
        draft_project_bullets: List[Dict[str, str]] = []
        for proj in updated_projects:
            proj_id = str(proj.get("project_id", ""))
            draft_project_titles.append(
                {
                    "id": proj_id,
                    "text": str(proj.get("name", "")).strip(),
                }
            )
            draft_project_dates.append(
                {
                    "id": proj_id,
                    "text": str(proj.get("dates", "")).strip(),
                }
            )
            for bullet in proj.get("bullets", []):
                draft_project_bullets.append(
                    {
                        "id": str(bullet.get("id", "")),
                        "text": str(bullet.get("text", "")).strip(),
                        "project_id": proj_id,
                    }
                )
        payload = {
            "tex_base64": base64.b64encode(updated_latex.encode("utf-8")).decode("utf-8"),
            "pdf_base64": base64.b64encode(pdf_bytes).decode("utf-8"),
            "pdf_available": True,
            "bullets_edited": bullets_edited,
            "keyword_hints": _extract_keywords_from_jd(job_description),
            "updated_titles": updated_title_meta,
            "compilation": {
                "has_warnings": bool(compile_result.warnings),
                "has_errors": bool(compile_result.latex_errors),
                "warnings": compile_result.warnings[:10],
                "errors": compile_result.latex_errors[:10],
                "passes": compile_result.passes,
            },
            "draft": {
                "titles": [{"id": t.get("id", ""), "text": t.get("updated_title", "")} for t in updated_title_meta],
                "companies": [{"id": t.get("id", ""), "text": t.get("company", "")} for t in updated_title_meta],
                "bullets": draft_bullets,
                "project_titles": draft_project_titles,
                "project_dates": draft_project_dates,
                "project_bullets": draft_project_bullets,
                "skills": rewritten_skills or (skills_parsed[2] if skills_parsed else ""),
            },
        }
        return JSONResponse(payload)
    finally:
        _request_cache.reset(cache_token)


@app.post("/draft/apply")
async def apply_draft_edits(
    payload: DraftApplyRequest,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    resume = (
        db.query(Resume)
        .filter(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
        .first()
    )
    if not resume or not resume.latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")
    logger.info("Resume loaded: user_id=%s resume_id=%s", user.id, resume.id)
    _validate_latex_template(resume.latex_template)

    title_edits = {t.id: t.text for t in (payload.titles or [])}
    company_edits = {c.id: c.text for c in (payload.companies or [])}
    bullet_edits = {b.id: b for b in (payload.bullets or [])}
    project_title_edits = {t.id: t.text for t in (payload.project_titles or [])}
    project_date_edits = {d.id: d.text for d in (payload.project_dates or [])}
    project_bullet_edits = {b.id: b for b in (payload.project_bullets or [])}
    skills_edit = payload.skills

    if (
        not title_edits
        and not company_edits
        and not bullet_edits
        and not project_title_edits
        and not project_date_edits
        and not project_bullet_edits
        and skills_edit is None
    ):
        raise HTTPException(status_code=400, detail="No draft edits provided.")

    title_map: Dict[str, Tuple[Dict[str, object], Tuple[int, int]]] = {}
    baseline = resume.optimized_latex or resume.latex_template

    if title_edits or company_edits:
        subheadings, title_ranges = _parse_latex_resume_subheadings(baseline)
        title_map = {s.get("id", ""): (s, r) for s, r in zip(subheadings, title_ranges)}
        education_range = _latex_section_range(baseline, "Education")
        if education_range:
            for tid in list(title_edits.keys()) + list(company_edits.keys()):
                sub, _ = title_map.get(tid, ({}, (0, 0)))
                start_idx = int(sub.get("block_start", 0)) if isinstance(sub, dict) else 0
                if education_range[0] <= start_idx < education_range[1]:
                    raise HTTPException(
                        status_code=400,
                        detail="Education section is locked and cannot be edited.",
                    )
    bullet_ranges: Dict[str, Tuple[int, int, Optional[str]]] = {}
    if bullet_edits:
        try:
            experiences = _parse_experience_groups(baseline)
        except HTTPException:
            experiences = []
        for exp in experiences:
            exp_id = str(exp.get("experience_id", ""))
            for bullet in exp.get("bullets", []):
                bid = str(bullet.get("id", ""))
                start, end = bullet.get("range", (0, 0))
                bullet_ranges[bid] = (start, end, exp_id)
        if not bullet_ranges:
            raise HTTPException(status_code=400, detail="No stored bullet ranges. Re-run optimize.")
    project_title_ranges: Dict[str, Tuple[int, int]] = {}
    project_date_ranges: Dict[str, Tuple[int, int]] = {}
    project_bullet_ranges: Dict[str, Tuple[int, int, Optional[str]]] = {}
    if project_title_edits or project_date_edits or project_bullet_edits:
        projects = _parse_project_groups(baseline)
        if not projects:
            raise HTTPException(status_code=400, detail="No Projects section found in this LaTeX template.")
        for proj in projects:
            proj_id = str(proj.get("project_id", ""))
            name_range = proj.get("name_range")
            dates_range = proj.get("dates_range")
            if isinstance(name_range, (list, tuple)) and len(name_range) == 2:
                project_title_ranges[proj_id] = (int(name_range[0]), int(name_range[1]))
            if isinstance(dates_range, (list, tuple)) and len(dates_range) == 2:
                project_date_ranges[proj_id] = (int(dates_range[0]), int(dates_range[1]))
            for bullet in proj.get("bullets", []):
                bid = str(bullet.get("id", ""))
                start, end = bullet.get("range", (0, 0))
                project_bullet_ranges[bid] = (start, end, proj_id)
    skills = _parse_latex_skills_section(baseline)

    unknown_titles = [tid for tid in title_edits if tid not in title_map]
    unknown_companies = [cid for cid in company_edits if cid not in title_map]
    unknown_bullets = [bid for bid in bullet_edits if bid not in bullet_ranges]
    unknown_project_titles = [pid for pid in project_title_edits if pid not in project_title_ranges]
    unknown_project_dates = [pid for pid in project_date_edits if pid not in project_date_ranges]
    unknown_project_bullets = [bid for bid in project_bullet_edits if bid not in project_bullet_ranges]
    if (
        unknown_titles
        or unknown_companies
        or unknown_bullets
        or unknown_project_titles
        or unknown_project_dates
        or unknown_project_bullets
    ):
        missing = ", ".join(
            unknown_titles
            + unknown_companies
            + unknown_bullets
            + unknown_project_titles
            + unknown_project_dates
            + unknown_project_bullets
        )
        raise HTTPException(status_code=400, detail=f"Unknown draft ids: {missing}")

    replacements: List[Tuple[int, int, str]] = []

    for tid, text in title_edits.items():
        cleaned = text.replace("\n", " ").strip()
        if len(cleaned) > 200:
            raise HTTPException(status_code=400, detail="Title edits must be <= 200 characters.")
        _, (start, end) = title_map[tid]
        original_raw = baseline[start:end]
        replacements.append((start, end, _format_title_replacement(original_raw, cleaned)))

    for cid, text in company_edits.items():
        cleaned = text.replace("\n", " ").strip()
        if len(cleaned) > 200:
            raise HTTPException(status_code=400, detail="Company edits must be <= 200 characters.")
        sub, _ = title_map[cid]
        company_range = sub.get("company_range", [0, 0]) if isinstance(sub, dict) else [0, 0]
        start, end = int(company_range[0]), int(company_range[1])
        if start >= end:
            raise HTTPException(status_code=400, detail="Could not locate company range for edit.")
        original_raw = baseline[start:end]
        replacements.append((start, end, _format_title_replacement(original_raw, cleaned)))

    for bid, edit in bullet_edits.items():
        exp_id = (edit.experience_id or "").strip()
        start, end, stored_exp = bullet_ranges[bid]
        if not exp_id:
            raise HTTPException(status_code=400, detail="Bullet edits must include experience_id.")
        if stored_exp and exp_id != stored_exp:
            raise HTTPException(status_code=400, detail=f"Bullet experience_id mismatch for {bid}.")
        text = edit.text
        cleaned = text.replace("\n", " ").strip()
        cleaned = _replace_unicode_artifacts(cleaned)
        if len(cleaned) > 180:
            raise HTTPException(status_code=400, detail="Bullet edits must be <= 180 characters.")
        sanitized = _sanitize_latex_bullet(cleaned)
        escaped = _escape_latex(sanitized if sanitized.strip() else cleaned)
        replacements.append((start, end, escaped))

    for pid, text in project_title_edits.items():
        cleaned = text.replace("\n", " ").strip()
        if len(cleaned) > 200:
            raise HTTPException(status_code=400, detail="Project title edits must be <= 200 characters.")
        start, end = project_title_ranges[pid]
        original_raw = baseline[start:end]
        replacements.append((start, end, _format_title_replacement(original_raw, cleaned)))

    for pid, text in project_date_edits.items():
        cleaned = text.replace("\n", " ").strip()
        if len(cleaned) > 200:
            raise HTTPException(status_code=400, detail="Project date edits must be <= 200 characters.")
        start, end = project_date_ranges[pid]
        original_raw = baseline[start:end]
        replacements.append((start, end, _format_title_replacement(original_raw, cleaned)))

    for bid, edit in project_bullet_edits.items():
        proj_id = (edit.project_id or "").strip()
        start, end, stored_proj = project_bullet_ranges[bid]
        if not proj_id:
            raise HTTPException(status_code=400, detail="Project bullet edits must include project_id.")
        if stored_proj and proj_id != stored_proj:
            raise HTTPException(status_code=400, detail=f"Project bullet project_id mismatch for {bid}.")
        text = edit.text
        cleaned = text.replace("\n", " ").strip()
        cleaned = _replace_unicode_artifacts(cleaned)
        sanitized = _sanitize_latex_bullet(cleaned)
        escaped = _escape_latex(sanitized if sanitized.strip() else cleaned)
        replacements.append((start, end, escaped))

    if skills_edit is not None:
        if not skills:
            raise HTTPException(status_code=400, detail="Skills section not found in this LaTeX template.")
        s_start, s_end, s_text = skills
        candidate = skills_edit.replace("\n", " ").strip()
        candidate = _format_skills_headings(candidate)
        sanitized = _sanitize_latex_content(s_text, candidate)
        escaped = _escape_latex_text_keep_commands(sanitized)
        replacements.append((s_start, s_end, escaped))

    updated_latex = _apply_replacements(baseline, replacements)
    resume.optimized_latex = updated_latex
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Failed to save optimized resume: user_id=%s resume_id=%s", user.id, resume.id)
        raise HTTPException(status_code=500, detail="Could not save optimized resume.") from exc
    compile_result = _compile_latex_to_pdf_bytes(updated_latex)
    if not compile_result.pdf_bytes:
        raise HTTPException(status_code=400, detail=_format_error_summary(compile_result))
    pdf_bytes = compile_result.pdf_bytes

    import base64
    return {
        "pdf_base64": base64.b64encode(pdf_bytes).decode("utf-8"),
        "pdf_available": True,
        "compilation": {
            "has_warnings": bool(compile_result.warnings),
            "has_errors": bool(compile_result.latex_errors),
            "warnings": compile_result.warnings[:10],
            "errors": compile_result.latex_errors[:10],
            "passes": compile_result.passes,
        },
    }


@app.get("/resumes/downloaded")
def list_downloaded_resumes(
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    items = (
        db.query(DownloadedResume)
        .filter(DownloadedResume.user_id == user.id)
        .order_by(DownloadedResume.created_at.desc())
        .all()
    )
    return {
        "resumes": [
            {"id": r.id, "name": r.name, "created_at": r.created_at.isoformat()}
            for r in items
        ]
    }


@app.get("/resumes/downloaded/{resume_id}")
def get_downloaded_resume(
    resume_id: str,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    resume = (
        db.query(DownloadedResume)
        .filter(DownloadedResume.user_id == user.id, DownloadedResume.id == resume_id)
        .first()
    )
    if not resume:
        raise HTTPException(status_code=404, detail="Saved resume not found.")
    logger.info("Downloaded resume loaded: user_id=%s resume_id=%s", user.id, resume.id)
    return {
        "id": resume.id,
        "name": resume.name,
        "latex_template": resume.latex_template,
        "optimized_latex": resume.optimized_latex,
        "pdf_base64": resume.pdf_base64,
        "created_at": resume.created_at.isoformat(),
    }


@app.post("/resumes/downloaded")
def save_downloaded_resume(
    payload: DownloadedResumeRequest,
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    optimized_latex = payload.optimized_latex.strip()
    pdf_base64 = payload.pdf_base64.strip()
    if not optimized_latex or not pdf_base64:
        raise HTTPException(status_code=400, detail="optimized_latex and pdf_base64 are required.")

    template = (
        db.query(Resume)
        .filter(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
        .first()
    )
    if not template or not template.latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")

    name = (payload.name or "").strip()
    if not name:
        name = f"Downloaded {datetime.utcnow().strftime('%Y-%m-%d %H:%M')}"

    saved = DownloadedResume(
        user_id=user.id,
        name=name,
        latex_template=template.latex_template,
        optimized_latex=optimized_latex,
        pdf_base64=pdf_base64,
    )
    db.add(saved)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Failed to save downloaded resume: user_id=%s", user.id)
        raise HTTPException(status_code=500, detail="Could not save downloaded resume.") from exc
    logger.info("Downloaded resume saved: user_id=%s resume_id=%s", user.id, saved.id)
    return {"id": saved.id}


@app.post("/coverletter")
async def coverletter(
    job_description: str = Form(...),
    user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    resume = (
        db.query(Resume)
        .filter(Resume.user_id == user.id)
        .order_by(Resume.created_at.desc())
        .first()
    )
    if not resume or not resume.latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")
    resume_text = _extract_latex_text(resume.latex_template)
    cover_letter = _call_openai_cover_letter(job_description, resume_text)
    return {"cover_letter": cover_letter}


@app.post("/outreach/preview")
def outreach_preview(req: OutreachPreviewRequest):
    preview = _call_openai_outreach_preview(req.job_description, req.resume_text)
    return preview
