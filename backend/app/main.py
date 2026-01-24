import contextvars
import json
import logging
import os
import re
import subprocess
import tempfile
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from openai import OpenAI
from pydantic import BaseModel, Field
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
_latex_template: Optional[str] = None
_last_compiled_latex: Optional[str] = None
_last_optimized_latex: Optional[str] = None
_last_bullet_ranges: Dict[str, Tuple[int, int, Optional[str]]] = {}
_last_template_fingerprint: Optional[int] = None
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

_allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",     # future-proof
    "http://127.0.0.1:3000",
]
frontend_origin = os.getenv("FRONTEND_ORIGIN", "").strip()
if frontend_origin:
    _allowed_origins.append(frontend_origin)

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


class RoleFrame(BaseModel):
    experience_id: str
    original_title: str
    updated_title: str = Field(max_length=80)
    role_summary: str = Field(max_length=200)

FULL_RESUME_REWRITE_PROMPT = (
    "what do i tweak in my resume to guarentee an interview at this job description.\n"
    "make sure all the keywords are included. i am experimenting a personal project to see how well gpt performs.\n"
    "so you can make up stuff as well if needed.\n"
    "make sure the bullets are about the same size like the prev ones or they wont fit in there (max 135 chars).\n"
    "make sure its in google xyz format.\n"
    "also each line does not need to have data and more of a story of my project.\n"
    "change the job titles as needed.\n"
    "make sure to quantify the results as well in the bullets where needed.\n"
    "\n"
    "also make sure you dont forget the essence of each exp\n"
    "like dahl lab was ultrasound lab,\n"
    "tractor supply is a retail company,\n"
    "campusx is a student marketplace,\n"
    "p&g is retail and supply chain."
)

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


class OutreachPreviewRequest(BaseModel):
    job_description: str
    resume_text: str


class LatexTemplateRequest(BaseModel):
    latex_text: str


class DraftApplyItem(BaseModel):
    id: str
    text: str
    experience_id: Optional[str] = None


class DraftApplyRequest(BaseModel):
    titles: Optional[List[DraftApplyItem]] = None
    bullets: Optional[List[DraftApplyItem]] = None
    skills: Optional[str] = None


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


def _parse_latex_resume_items(latex_text: str, keyword_hint: List[str]) -> List[Dict[str, object]]:
    """
    Parse \\resumeItem{...} blocks grouped by \\resumeSubheading.
    Each group includes experience metadata and its bullet entries with ranges.
    """
    section_match = re.search(r"\\section\*?\{Experience\}", latex_text, re.IGNORECASE)
    if not section_match:
        raise HTTPException(
            status_code=400,
            detail="No \\section{Experience} found in this LaTeX template.",
        )
    section_start = section_match.start()
    rest = latex_text[section_match.end():]
    next_section = re.search(r"\\section\*?\{", rest)
    section_end = section_match.end() + (next_section.start() if next_section else len(rest))

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
    section_range = _section_range_any(latex_text, "Experience")
    if not section_range:
        raise HTTPException(
            status_code=400,
            detail="No \\section{Experience} found in this LaTeX template.",
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
    section_range = _section_range_any(latex_text, "Projects")
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
            i = j
            while i < len(latex_text) and latex_text[i].isspace():
                i += 1
        if not parse_failed and len(fields) == 2:
            headings.append(
                {
                    "name": fields[0],
                    "dates": fields[1],
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
        bullets = _scan_resume_items(latex_text, block_end, boundary)
        groups.append(
            {
                "name": str(heading.get("name", "")),
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
            title_start, title_end = field_ranges[2]
            subheadings.append(
                {
                    "id": f"lhs{len(subheadings)}",
                    "company": fields[0],
                    "location": fields[1],
                    "title": fields[2],
                    "dates": fields[3],
                    "title_range": [title_start, title_end],
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
    m = re.search(r"\\section\*?\{(Technical Skills|Skills)\}", latex_text)
    if not m:
        return None
    section_start = m.end()
    rest = latex_text[section_start:]

    begin_itemize = re.search(r"\\begin\{itemize\}(?:\[[^\]]*\])?", rest)
    if begin_itemize:
        content_start = section_start + begin_itemize.end()
        after_begin = latex_text[content_start:]
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

    next_section = re.search(r"\\section\*?\{", rest)
    end_doc = re.search(r"\\end\{document\}", rest)
    if next_section:
        section_end = section_start + next_section.start()
    elif end_doc:
        section_end = section_start + end_doc.start()
    else:
        section_end = section_start + len(rest)
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


def _call_openai_full_resume_rewrite(job_description: str, resume_text: str) -> Dict[str, object]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")
    if not resume_text.strip():
        raise HTTPException(status_code=400, detail="Resume text is empty; cannot optimize.")

    instructions = (
        "You rewrite an entire resume based on a job description.\n"
        "Return JSON ONLY in this format:\n"
        "{\n"
        "  \"experiences\": [\n"
        "    {\"company\":\"...\",\"title\":\"...\",\"dates\":\"...\",\"bullets\":[\"...\"]}\n"
        "  ],\n"
        "  \"projects\": [\n"
        "    {\"name\":\"...\",\"bullets\":[\"...\"]}\n"
        "  ],\n"
        "  \"skills\": \"...\"\n"
        "}\n"
        "No extra keys. No markdown.\n"
        "\n"
        "SKILLS RULES (STRICT):\n"
        "- Format skills as 3-5 lines maximum\n"
        "- Use format: Category: item1, item2, item3\n"
        "- NO trailing dashes, pipes, or em dashes after items\n"
        "- NO '—' or '|' at the end of any line\n"
        "- Separate categories with ' \\\\ ' (LaTeX line break)\n"
    )

    user_content = (
        f"{FULL_RESUME_REWRITE_PROMPT}\n\n"
        "RESUME:\n"
        f"{resume_text}\n\n"
        "JOB DESCRIPTION:\n"
        f"{job_description}"
    )

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": user_content},
        ],
        response_format={"type": "json_object"},
        temperature=0.4,
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

    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid resume output.")

    experiences = data.get("experiences", [])
    projects = data.get("projects", [])
    skills = data.get("skills", "")

    if not isinstance(experiences, list):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid experiences list.")
    if not isinstance(projects, list):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid projects list.")
    if not isinstance(skills, str):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid skills text.")

    return {
        "experiences": experiences,
        "projects": projects,
        "skills": skills.strip(),
    }

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
        "2) updated_text MUST be a single line (no line breaks) and MUST be <= max_chars (max 135 chars).\n"
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
        model=OPENAI_MODEL,
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


def _compile_latex_to_pdf_bytes(latex_text: str) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        td_path = os.path.abspath(td)
        tex_path = os.path.join(td_path, "resume.tex")
        with open(tex_path, "w", encoding="utf-8") as f:
            f.write(latex_text)

        try:
            result = subprocess.run(
                ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "resume.tex"],
                cwd=td_path,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
            )
        except subprocess.CalledProcessError as exc:
            err = exc.stdout.decode("utf-8", errors="ignore") + "\n" + exc.stderr.decode("utf-8", errors="ignore")
            raise HTTPException(status_code=400, detail=f"LaTeX compilation failed:\n{err[-1200:]}")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"LaTeX compilation error: {exc}")

        pdf_path = os.path.join(td_path, "resume.pdf")
        if not os.path.exists(pdf_path):
            raise HTTPException(status_code=500, detail="PDF output not found after pdflatex.")
        with open(pdf_path, "rb") as f:
            return f.read()


@app.get("/health")
def health():
    return {"ok": True, "model": OPENAI_MODEL, "has_key": bool(OPENAI_API_KEY)}


@app.get("/latex/template")
def get_latex_template():
    return {"has_template": bool(_latex_template)}


@app.get("/latex/last")
def get_last_compiled_latex():
    if not _last_compiled_latex:
        raise HTTPException(status_code=404, detail="No compiled LaTeX available yet.")
    return {"latex": _last_compiled_latex}

@app.post("/latex/template")
async def set_latex_template(
    latex_text: str = Form(None),
    template: UploadFile = File(None),
):
    global _latex_template
    content = ""
    if template is not None:
        if not template.filename.lower().endswith(".tex"):
            raise HTTPException(status_code=400, detail="Please upload a .tex LaTeX template.")
        content = (await template.read()).decode("utf-8", errors="ignore")
    elif latex_text is not None:
        content = latex_text

    if not content.strip():
        raise HTTPException(status_code=400, detail="LaTeX template content is empty.")

    _validate_latex_template(content)
    _latex_template = content
    return {"ok": True, "message": "LaTeX template saved."}

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
    risk_level: str = Form("balanced"),
):
    global _last_compiled_latex, _last_optimized_latex, _last_bullet_ranges, _last_template_fingerprint
    if not _latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")
    _validate_latex_template(_latex_template)

    cache_token = _request_cache.set({})
    try:
        baseline = _latex_template
        resume_text = _extract_resume_plain_text(baseline)
        rewritten = _call_openai_full_resume_rewrite(job_description, resume_text)

        experiences = _parse_experience_groups(baseline)
        projects = _parse_project_groups(baseline)

        replacements: List[Tuple[int, int, str]] = []
        updated_title_meta: List[Dict[str, str]] = []
        bullets_edited = 0

        rewritten_experiences = rewritten.get("experiences", [])
        if not isinstance(rewritten_experiences, list):
            rewritten_experiences = []

        for idx, exp in enumerate(experiences):
            updated_exp = rewritten_experiences[idx] if idx < len(rewritten_experiences) else {}
            updated_title = str(updated_exp.get("title", "")).strip() or str(exp.get("title", "")).strip()
            t_start, t_end = exp.get("title_range", (0, 0))
            original_raw = baseline[t_start:t_end]
            replacements.append((t_start, t_end, _format_title_replacement(original_raw, updated_title)))
            updated_title_meta.append(
                {
                    "id": str(exp.get("experience_id", "")),
                    "company": str(exp.get("company", "")),
                    "original_title": str(exp.get("title", "")),
                    "updated_title": updated_title,
                    "role_summary": "",
                }
            )

            updated_bullets = updated_exp.get("bullets", [])
            if not isinstance(updated_bullets, list):
                updated_bullets = []
            for b_idx, bullet in enumerate(exp.get("bullets", [])):
                start, end = bullet.get("range", (0, 0))
                original = str(bullet.get("text", "")).strip()
                candidate = original
                if b_idx < len(updated_bullets) and isinstance(updated_bullets[b_idx], str):
                    cleaned = updated_bullets[b_idx].replace("\n", " ").strip()
                    cleaned = _replace_unicode_artifacts(cleaned)
                    cleaned = _truncate_preserve_words(cleaned, 135)
                    sanitized = _sanitize_latex_bullet(cleaned)
                    candidate = sanitized if sanitized.strip() else original
                escaped = _escape_latex(candidate)
                replacements.append((start, end, escaped))
                bullets_edited += 1

        rewritten_projects = rewritten.get("projects", [])
        if not isinstance(rewritten_projects, list):
            rewritten_projects = []
        for idx, proj in enumerate(projects):
            updated_proj = rewritten_projects[idx] if idx < len(rewritten_projects) else {}
            updated_bullets = updated_proj.get("bullets", [])
            if not isinstance(updated_bullets, list):
                updated_bullets = []
            for b_idx, bullet in enumerate(proj.get("bullets", [])):
                start, end = bullet.get("range", (0, 0))
                original = str(bullet.get("text", "")).strip()
                candidate = original
                if b_idx < len(updated_bullets) and isinstance(updated_bullets[b_idx], str):
                    cleaned = updated_bullets[b_idx].replace("\n", " ").strip()
                    cleaned = _replace_unicode_artifacts(cleaned)
                    cleaned = _truncate_preserve_words(cleaned, 135)
                    sanitized = _sanitize_latex_bullet(cleaned)
                    candidate = sanitized if sanitized.strip() else original
                escaped = _escape_latex(candidate)
                replacements.append((start, end, escaped))
                bullets_edited += 1

        skills = _parse_latex_skills_section(baseline)
        skills_updated = False
        audit_skills_text = ""
        skills_text = str(rewritten.get("skills", "") or "").strip()
        if skills:
            s_start, s_end, s_text = skills
            candidate = skills_text
            candidate = candidate.replace("\n", " ").strip()
            candidate = _format_skills_headings(candidate)
            sanitized = _sanitize_latex_content(s_text, candidate)
            escaped = _escape_latex_text_keep_commands(sanitized)
            replacements.append((s_start, s_end, escaped))
            skills_updated = True
            audit_skills_text = escaped

        updated_latex = _apply_replacements(baseline, replacements)
        _last_compiled_latex = updated_latex
        _last_optimized_latex = updated_latex
        try:
            updated_experiences = _parse_experience_groups(updated_latex)
        except HTTPException:
            updated_experiences = experiences
        _last_bullet_ranges = {}
        for exp in updated_experiences:
            for bullet in exp.get("bullets", []):
                bid = str(bullet.get("id", ""))
                start, end = bullet.get("range", (0, 0))
                _last_bullet_ranges[bid] = (start, end, str(exp.get("experience_id", "")))
        _last_template_fingerprint = hash(updated_latex)
        pdf_bytes = _compile_latex_to_pdf_bytes(updated_latex)

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
        payload = {
            "tex_base64": base64.b64encode(updated_latex.encode("utf-8")).decode("utf-8"),
            "pdf_base64": base64.b64encode(pdf_bytes).decode("utf-8"),
            "pdf_available": True,
            "bullets_edited": bullets_edited,
            "keyword_hints": [],
            "skills_updated": skills_updated,
            "updated_titles": updated_title_meta,
            "locked_sections": ["Education"],
            "draft": {
                "titles": [{"id": t.get("id", ""), "text": t.get("updated_title", "")} for t in updated_title_meta],
                "bullets": draft_bullets,
                "skills": audit_skills_text,
            },
        }
        return JSONResponse(payload)
    finally:
        _request_cache.reset(cache_token)


@app.post("/draft/apply")
async def apply_draft_edits(payload: DraftApplyRequest):
    global _last_compiled_latex, _last_optimized_latex
    if not _latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")
    _validate_latex_template(_latex_template)

    title_edits = {t.id: t.text for t in (payload.titles or [])}
    bullet_edits = {b.id: b for b in (payload.bullets or [])}
    skills_edit = payload.skills

    if not title_edits and not bullet_edits and skills_edit is None:
        raise HTTPException(status_code=400, detail="No draft edits provided.")

    title_map: Dict[str, Tuple[Dict[str, object], Tuple[int, int]]] = {}
    baseline = _last_optimized_latex or _latex_template

    if title_edits:
        subheadings, title_ranges = _parse_latex_resume_subheadings(baseline)
        title_map = {s.get("id", ""): (s, r) for s, r in zip(subheadings, title_ranges)}
        education_range = _latex_section_range(baseline, "Education")
        if education_range:
            for tid in title_edits:
                sub, _ = title_map.get(tid, ({}, (0, 0)))
                start_idx = int(sub.get("block_start", 0)) if isinstance(sub, dict) else 0
                if education_range[0] <= start_idx < education_range[1]:
                    raise HTTPException(
                        status_code=400,
                        detail="Education section is locked and cannot be edited.",
                    )
    if bullet_edits:
        if _last_template_fingerprint is None or _last_template_fingerprint != hash(baseline):
            raise HTTPException(status_code=400, detail="Bullet ranges are out of date. Re-run optimize.")
        if not _last_bullet_ranges:
            raise HTTPException(status_code=400, detail="No stored bullet ranges. Re-run optimize.")
    skills = _parse_latex_skills_section(baseline)

    unknown_titles = [tid for tid in title_edits if tid not in title_map]
    unknown_bullets = [bid for bid in bullet_edits if bid not in _last_bullet_ranges]
    if unknown_titles or unknown_bullets:
        missing = ", ".join(unknown_titles + unknown_bullets)
        raise HTTPException(status_code=400, detail=f"Unknown draft ids: {missing}")

    replacements: List[Tuple[int, int, str]] = []

    for tid, text in title_edits.items():
        cleaned = text.replace("\n", " ").strip()
        if len(cleaned) > 200:
            raise HTTPException(status_code=400, detail="Title edits must be <= 200 characters.")
        _, (start, end) = title_map[tid]
        original_raw = baseline[start:end]
        replacements.append((start, end, _format_title_replacement(original_raw, cleaned)))

    for bid, edit in bullet_edits.items():
        exp_id = (edit.experience_id or "").strip()
        start, end, stored_exp = _last_bullet_ranges[bid]
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
    _last_compiled_latex = updated_latex
    _last_optimized_latex = updated_latex
    pdf_bytes = _compile_latex_to_pdf_bytes(updated_latex)

    import base64
    return {
        "pdf_base64": base64.b64encode(pdf_bytes).decode("utf-8"),
        "pdf_available": True,
    }


@app.post("/coverletter")
async def coverletter(
    job_description: str = Form(...),
):
    if not _latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")
    resume_text = _extract_latex_text(_latex_template)
    cover_letter = _call_openai_cover_letter(job_description, resume_text)
    return {"cover_letter": cover_letter}


@app.post("/outreach/preview")
def outreach_preview(req: OutreachPreviewRequest):
    preview = _call_openai_outreach_preview(req.job_description, req.resume_text)
    return preview
