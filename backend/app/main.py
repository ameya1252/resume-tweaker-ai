import contextvars
import json
import logging
import os
import re
import subprocess
import tempfile
from typing import Dict, List, Optional, Tuple

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


def _flatten_latex_bullets(grouped: List[Dict[str, object]]) -> Tuple[List[Slot], List[Tuple[int, int]]]:
    slots: List[Slot] = []
    ranges: List[Tuple[int, int]] = []
    for group in grouped:
        bullets = group.get("bullets", [])
        for b in bullets:
            slot = b.get("slot")
            if isinstance(slot, Slot):
                slots.append(slot)
            else:
                txt = str(b.get("text", "")).strip()
                if not txt:
                    continue
                base_max = min(max(len(txt) + 6, 30), 140)
                max_chars = max(len(txt), base_max)
                slot = Slot(
                    id=str(b.get("id", f"li{len(slots)}")),
                    text=txt,
                    original_text=txt,
                    role_id=f"latex_role_{len(slots) // 10}",
                    slot_type="bullet",
                    max_chars=max_chars,
                    keywords_required=[],
                    experience_id=str(group.get("experience_id", "")),
                )
                slots.append(slot)
            rng = b.get("range")
            if isinstance(rng, tuple) and len(rng) == 2:
                ranges.append((int(rng[0]), int(rng[1])))
    return slots, ranges


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
    return cleaned


def _sanitize_latex_content(original: str, candidate: str) -> str:
    """
    Prevent new LaTeX commands by stripping any backslash commands not present in original.
    This preserves formatting while avoiding compile-breaking commands.
    """
    allowed_cmds = set(re.findall(r"\\[A-Za-z]+", original))

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


def _call_openai_skills(job_description: str, skills_text: str) -> str:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")
    if not skills_text.strip():
        return skills_text

    instructions = (
        "You are a resume skills section optimizer.\n"
        "Goal: update the skills section to better match the job description.\n"
        "Rules (STRICT):\n"
        "1) Return JSON ONLY: {\"skills_text\":\"...\"}\n"
        "2) You MAY add missing skills and keywords aggressively when relevant.\n"
        "3) Preserve the existing structure (labels and separators) but you can reorder within each label.\n"
        "4) Do NOT introduce new LaTeX commands.\n"
        "5) Keep it concise and ATS-friendly.\n"
        "6) Ensure proper LaTeX escaping for special characters.\n"
    )

    payload = {
        "job_description": job_description,
        "skills_text": skills_text,
    }

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(payload)},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
    )

    text = (resp.choices[0].message.content or "").strip()
    if not text:
        return skills_text

    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return skills_text
        data = json.loads(m.group(0))

    updated = data.get("skills_text")
    if not isinstance(updated, str) or not updated.strip():
        return skills_text
    return updated.strip()


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


def _call_openai_role_frame(
    job_description: str,
    job_analysis: Dict[str, object],
    company: str,
    original_title: str,
    existing_bullets: List[str],
    risk_level: str,
) -> Dict[str, str]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")

    instructions = (
        "You create a role frame for a resume experience.\n"
        "Return JSON ONLY: {\"updated_title\":\"...\",\"role_summary\":\"...\"}\n"
        "Rules (STRICT):\n"
        "1) Do NOT inflate seniority; keep level realistic for the role.\n"
        "2) Preserve the truth of the role.\n"
        "3) Optimize title for ATS + recruiter clarity.\n"
        "4) Use job archetype keywords when relevant.\n"
        "5) updated_title must remain realistic (no \"Senior\" if intern).\n"
        "6) role_summary describes scope, not achievements.\n"
        "7) role_summary must be <= 200 characters.\n"
        "8) Apply the requested risk_level to title changes and reframing; do NOT change seniority.\n"
    )
    payload = {
        "job_description": job_description,
        "job_analysis": job_analysis,
        "company": company,
        "original_title": original_title,
        "existing_bullets": existing_bullets,
        "risk_level": risk_level,
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

    updated_title = data.get("updated_title")
    role_summary = data.get("role_summary")

    if not isinstance(role_summary, str) or not role_summary.strip():
        raise HTTPException(status_code=500, detail="OpenAI returned invalid role_summary.")
    role_summary = role_summary.strip()
    if len(role_summary) > 200:
        truncated = role_summary[:200]
        role_summary = truncated.rsplit(" ", 1)[0] or truncated

    updated_title_valid = isinstance(updated_title, str) and updated_title.strip()
    if updated_title_valid:
        updated_title = updated_title.strip()
        if len(updated_title) > 80:
            updated_title_valid = False
        else:
            seniority = str(job_analysis.get("seniority", "")).strip().lower()
            lowered = updated_title.lower()
            if seniority in {"intern", "entry"} and any(
                kw in lowered for kw in ["senior", "lead", "principal", "staff", "manager", "director", "vp", "head"]
            ):
                updated_title_valid = False

    if not updated_title_valid:
        updated_title = original_title.strip()

    return {
        "updated_title": updated_title,
        "role_summary": role_summary,
    }


def _call_openai_audit(
    updated_title: str,
    rewritten_bullets: List[str],
    skills_section: str,
) -> Dict[str, List[str]]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")

    instructions = (
        "You audit resume content for risks and gaps.\n"
        "Return JSON ONLY: {\"warnings\":[...],\"suggestions\":[...]}\n"
        "Rules (STRICT):\n"
        "1) No rewriting of bullets or skills.\n"
        "2) No creativity beyond analysis of the provided text.\n"
        "3) Warnings only if high confidence.\n"
        "4) Suggestions must be actionable and specific (e.g., \"Add fraud signal to CampusX\").\n"
        "5) Keep lists concise.\n"
    )
    payload = {
        "updated_title": updated_title,
        "rewritten_bullets": rewritten_bullets,
        "skills_section": skills_section,
    }

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
        raise HTTPException(status_code=500, detail="OpenAI returned empty output.")
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    warnings = data.get("warnings")
    suggestions = data.get("suggestions")

    if not isinstance(warnings, list) or not all(isinstance(x, str) for x in warnings):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid warnings list.")
    if not isinstance(suggestions, list) or not all(isinstance(x, str) for x in suggestions):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid suggestions list.")

    return {
        "warnings": [w.strip() for w in warnings if w.strip()],
        "suggestions": [s.strip() for s in suggestions if s.strip()],
    }


def _analyze_job_description(job_description: str) -> Dict[str, object]:
    if client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set in backend/.env")

    cache = _request_cache.get()
    if cache is None:
        cache = {}
        _request_cache.set(cache)
    cache_key = f"job_analysis:{job_description}"
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return cached

    instructions = (
        "You analyze a job description and return a compact hiring-signal frame.\n"
        "Return JSON ONLY with keys:\n"
        "role_archetype (string), seniority (\"intern\"|\"entry\"|\"mid\"|\"senior\"),\n"
        "primary_axes (string[]), must_signal (string[]), nice_to_signal (string[]).\n"
        "No extra keys. No markdown. No commentary."
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
        raise HTTPException(status_code=500, detail="OpenAI returned empty output.")
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=500, detail=f"Could not parse OpenAI JSON output. Raw: {text[:400]}")
        data = json.loads(m.group(0))

    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid analysis output.")

    role_archetype = data.get("role_archetype")
    seniority = data.get("seniority")
    primary_axes = data.get("primary_axes")
    must_signal = data.get("must_signal")
    nice_to_signal = data.get("nice_to_signal")

    if not isinstance(role_archetype, str) or not role_archetype.strip():
        raise HTTPException(status_code=500, detail="OpenAI returned invalid role_archetype.")
    if seniority not in {"intern", "entry", "mid", "senior"}:
        raise HTTPException(status_code=500, detail="OpenAI returned invalid seniority.")
    if not isinstance(primary_axes, list) or not all(isinstance(x, str) for x in primary_axes):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid primary_axes.")
    if not isinstance(must_signal, list) or not all(isinstance(x, str) for x in must_signal):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid must_signal.")
    if not isinstance(nice_to_signal, list) or not all(isinstance(x, str) for x in nice_to_signal):
        raise HTTPException(status_code=500, detail="OpenAI returned invalid nice_to_signal.")

    result = {
        "role_archetype": role_archetype.strip(),
        "seniority": seniority,
        "primary_axes": [x.strip() for x in primary_axes if x.strip()],
        "must_signal": [x.strip() for x in must_signal if x.strip()],
        "nice_to_signal": [x.strip() for x in nice_to_signal if x.strip()],
    }
    cache[cache_key] = result
    return result


def _extract_latex_text(latex_text: str) -> str:
    """
    Extract plain-ish text from LaTeX by pulling resume items + skills section content.
    """
    keyword_hint: List[str] = []
    parts: List[str] = []
    try:
        grouped = _parse_latex_resume_items(latex_text, keyword_hint)
        slots, _ = _flatten_latex_bullets(grouped)
        parts.extend([s.text for s in slots])
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
    if not _latex_template:
        raise HTTPException(status_code=400, detail="LaTeX template not set. Upload or paste a .tex template first.")
    _validate_latex_template(_latex_template)

    cache_token = _request_cache.set({})
    try:
        risk_level = risk_level.strip().lower()
        if risk_level not in {"conservative", "balanced", "aggressive"}:
            raise HTTPException(status_code=400, detail="risk_level must be conservative, balanced, or aggressive.")

        job_analysis = _analyze_job_description(job_description)
        subheadings, title_ranges = _parse_latex_resume_subheadings(_latex_template)
        education_range = _latex_section_range(_latex_template, "Education")
        keyword_hint = _extract_keywords_from_jd(job_description)
        grouped = _parse_latex_resume_items(_latex_template, keyword_hint)
        slots, ranges = _flatten_latex_bullets(grouped)
        existing_bullets = [s.text for s in slots]
        updated_title_meta: List[Dict[str, str]] = []
        title_replacements: List[Tuple[int, int, str]] = []

        for subheading, (t_start, t_end) in zip(subheadings, title_ranges):
            start_idx = int(subheading.get("block_start", 0))
            if education_range and education_range[0] <= start_idx < education_range[1]:
                continue
            original_title = str(subheading.get("title", ""))
            company = str(subheading.get("company", ""))
            role_frame = _call_openai_role_frame(
                job_description=job_description,
                job_analysis=job_analysis,
                company=company,
                original_title=original_title,
                existing_bullets=existing_bullets,
                risk_level=risk_level,
            )
            updated_title = role_frame.get("updated_title", original_title).strip()
            original_raw = _latex_template[t_start:t_end]
            replaced_title = _format_title_replacement(original_raw, updated_title)
            updated_title_meta.append(
                {
                    "id": str(subheading.get("id", "")),
                    "company": company,
                    "original_title": original_title,
                    "updated_title": updated_title,
                    "role_summary": role_frame.get("role_summary", "").strip(),
                }
            )
            title_replacements.append((t_start, t_end, replaced_title))

        role_context: Optional[Dict[str, str]] = None
        if updated_title_meta:
            first = updated_title_meta[0]
            role_context = {
                "updated_title": first.get("updated_title", ""),
                "role_summary": first.get("role_summary", ""),
                "job_archetype": str(job_analysis.get("role_archetype", "")).strip(),
            }
        results = _call_openai(job_description, slots, role_context=role_context, risk_level=risk_level)
        slot_by_id = {s.id: s for s in slots}
        res_by_id = {}
        for r in results:
            original = slot_by_id.get(r.id).text if r.id in slot_by_id else r.updated_text
            sanitized = _sanitize_latex_bullet(r.updated_text)
            res_by_id[r.id] = _escape_latex(sanitized if sanitized.strip() else original)

        replacements: List[Tuple[int, int, str]] = []
        replacements.extend(title_replacements)
        for slot, (start, end) in zip(slots, ranges):
            new_text = res_by_id.get(slot.id, slot.text)
            replacements.append((start, end, new_text))

        skills = _parse_latex_skills_section(_latex_template)
        skills_updated = False
        audit_skills_text = ""
        if skills:
            s_start, s_end, s_text = skills
            updated_skills_raw = _call_openai_skills(job_description, s_text)
            updated_skills = _escape_latex_text_keep_commands(_sanitize_latex_content(s_text, updated_skills_raw))
            replacements.append((s_start, s_end, updated_skills))
            skills_updated = True
            audit_skills_text = updated_skills
        elif skills is None:
            audit_skills_text = ""

        audit_title = role_context.get("updated_title", "") if role_context else ""
        rewritten_bullets = [res_by_id.get(s.id, s.text) for s in slots]
        audit = _call_openai_audit(audit_title, rewritten_bullets, audit_skills_text)

        updated_latex = _apply_replacements(_latex_template, replacements)
        global _last_compiled_latex, _last_optimized_latex
        _last_compiled_latex = updated_latex
        _last_optimized_latex = updated_latex
        global _last_bullet_ranges, _last_template_fingerprint
        try:
            updated_grouped = _parse_latex_resume_items(updated_latex, keyword_hint)
            updated_slots, updated_ranges = _flatten_latex_bullets(updated_grouped)
        except HTTPException:
            updated_slots, updated_ranges = slots, ranges
        _last_bullet_ranges = {
            s.id: (r[0], r[1], s.experience_id) for s, r in zip(updated_slots, updated_ranges)
        }
        _last_template_fingerprint = hash(updated_latex)
        pdf_bytes = _compile_latex_to_pdf_bytes(updated_latex)

        import base64
        payload = {
            "tex_base64": base64.b64encode(updated_latex.encode("utf-8")).decode("utf-8"),
            "pdf_base64": base64.b64encode(pdf_bytes).decode("utf-8"),
            "pdf_available": True,
            "bullets_edited": len(results),
            "keyword_hints": keyword_hint,
            "skills_updated": skills_updated,
            "updated_titles": updated_title_meta,
            "audit": audit,
            "locked_sections": ["Education"],
            "draft": {
                "titles": [{"id": t.get("id", ""), "text": t.get("updated_title", "")} for t in updated_title_meta],
                "bullets": [
                    {
                        "id": s.id,
                        "text": res_by_id.get(s.id, s.text),
                        "experience_id": s.experience_id,
                    }
                    for s in slots
                ],
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
