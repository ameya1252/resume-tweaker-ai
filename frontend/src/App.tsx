import React, { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import ResumeEditorStructured from './components/ResumeEditorStructured'
import OptimizeProgressOverlay from './components/OptimizeProgressOverlay'
import { estimateVisualLines } from './utils/formatting'
import { buildDraftExperiences, Draft, DraftApplyRequest, DraftExperience } from './utils/draft'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'

type GoogleDoc = { id: string; name: string }
function b64ToUint8Array(b64: string) {
  const binary = atob(b64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function downloadBytes(bytes: Uint8Array, filename: string, mime: string) {
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [jobDescription, setJobDescription] = useState('')
  const [latexFile, setLatexFile] = useState<File | null>(null)
  const [latexText, setLatexText] = useState('')
  const [hasTemplate, setHasTemplate] = useState(false)
  const [mode, setMode] = useState<'latex' | 'gdocs'>('latex')
  const [googleDocs, setGoogleDocs] = useState<GoogleDoc[]>([])
  const [selectedDocId, setSelectedDocId] = useState('')
  const [coverDocId, setCoverDocId] = useState('')
  const [gdocsStatus, setGdocsStatus] = useState<string | null>(null)
  const [coverLetterStatus, setCoverLetterStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [coverLoading, setCoverLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uiStep, setUiStep] = useState<'input' | 'edit' | 'outreach' | 'export'>('input')
  const editPanelRef = useRef<HTMLDivElement | null>(null)

  const [texB64, setTexB64] = useState<string | null>(null)
  const [pdfB64, setPdfB64] = useState<string | null>(null)
  const [pdfAvailable, setPdfAvailable] = useState(false)
  const [bulletsEdited, setBulletsEdited] = useState<number | null>(null)
  const [keywordHints, setKeywordHints] = useState<string[]>([])
  const [coverLetterText, setCoverLetterText] = useState<string>('')
  const [pdfUrl, setPdfUrl] = useState<string>('')
  const [outreachPreview, setOutreachPreview] = useState<{
    target_roles: string[]
    linkedin_searches: Array<{ label: string; url: string }>
    outreach_message: string
  } | null>(null)
  const [outreachLoading, setOutreachLoading] = useState(false)
  const [outreachError, setOutreachError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [updatedTitles, setUpdatedTitles] = useState<Array<{ id: string; company?: string }>>([])
  const previewRef = useRef<HTMLDivElement | null>(null)
  const outreachKeyRef = useRef<string>('')

  const canOptimize = useMemo(() => {
    if (mode === 'gdocs') {
      return jobDescription.trim().length > 40 && !!selectedDocId
    }
    return jobDescription.trim().length > 40 && hasTemplate
  }, [jobDescription, mode, selectedDocId, hasTemplate])

  const canGenerateCover = useMemo(() => {
    if (mode === 'gdocs') {
      return jobDescription.trim().length > 40 && !!selectedDocId && !!coverDocId
    }
    return jobDescription.trim().length > 40 && hasTemplate
  }, [jobDescription, mode, selectedDocId, coverDocId, hasTemplate])

  const longBulletCount = useMemo(() => {
    if (!draft?.bullets?.length) return 0
    return draft.bullets.filter((b) => estimateVisualLines(b.text) > 1).length
  }, [draft])

  const skillsTooLong = useMemo(() => {
    if (!draft?.skills) return false
    return estimateVisualLines(draft.skills) > 3
  }, [draft])

  const companyByTitleId = useMemo(() => {
    const out: Record<string, string> = {}
    for (const t of updatedTitles) {
      if (t.id) out[t.id] = t.company || ''
    }
    return out
  }, [updatedTitles])

  const draftExperiences: DraftExperience[] = useMemo(() => {
    if (!draft) return []
    return buildDraftExperiences(draft.titles || [], draft.bullets || [], companyByTitleId)
  }, [draft, companyByTitleId])

  const resumeText = useMemo(() => {
    if (!draft) return ''
    const parts: string[] = []
    for (const exp of draftExperiences) {
      const title = exp.title ? ` - ${exp.title}` : ''
      parts.push(`${exp.company || 'Company'}${title}`)
      for (const b of exp.bullets) {
        parts.push(`- ${b.text}`)
      }
    }
    if (draft.skills) {
      parts.push(`Skills: ${draft.skills}`)
    }
    return parts.join('\n').trim()
  }, [draft, draftExperiences])


  const estimatedPdfPages = useMemo(() => {
    if (!pdfB64) return 0
    try {
      const binary = atob(pdfB64)
      const matches = binary.match(/\/Type\s*\/Page\b/g)
      return matches ? matches.length : 0
    } catch {
      return 0
    }
  }, [pdfB64])

  useEffect(() => {
    if (uiStep !== 'edit' || !draft) return
    const id = window.setTimeout(() => {
      editPanelRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, 0)
    return () => window.clearTimeout(id)
  }, [uiStep, draft])

  useEffect(() => {
    if (uiStep !== 'outreach' || !draft) return
    if (!jobDescription.trim() || !resumeText.trim()) return
    const key = `${jobDescription.trim()}::${resumeText.trim()}`
    if (outreachKeyRef.current === key && outreachPreview) return

    outreachKeyRef.current = key
    setOutreachLoading(true)
    setOutreachError(null)
    axios.post(`${BACKEND_URL}/outreach/preview`, {
      job_description: jobDescription,
      resume_text: resumeText,
    }).then((res) => {
      setOutreachPreview(res.data)
    }).catch((e: any) => {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not generate outreach preview.'
      setOutreachError(String(msg))
    }).finally(() => {
      setOutreachLoading(false)
    })
  }, [uiStep, draft, jobDescription, resumeText])


  async function handleApplyDraft(
    changes: DraftApplyRequest,
    nextDraft: Draft,
  ) {
    setError(null)
    try {
      const res = await axios.post(`${BACKEND_URL}/draft/apply`, changes)
      const { pdf_base64, pdf_available } = res.data || {}
      if (pdf_base64) {
        setPdfB64(pdf_base64)
        setPdfAvailable(!!pdf_available)
        setDraft(nextDraft)
        setPdfUrl('')
        setUiStep('edit')
      }
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not apply draft edits.'
      setError(String(msg))
    }
  }

  async function handleApplyChanges(changes: DraftApplyRequest) {
    if (!draft) return
    const titleById = new Map((changes.titles || []).map((t) => [t.id, t.text]))
    const bulletById = new Map((changes.bullets || []).map((b) => [b.id, b.text]))
    const nextDraft: Draft = {
      titles: draft.titles.map((t) => ({
        ...t,
        text: titleById.has(t.id) ? String(titleById.get(t.id)) : t.text,
      })),
      bullets: draft.bullets.map((b) => ({
        ...b,
        text: bulletById.has(b.id) ? String(bulletById.get(b.id)) : b.text,
      })),
      skills: typeof changes.skills === 'string' ? changes.skills : draft.skills,
    }
    await handleApplyDraft(changes, nextDraft)
  }

  function resetOutputs() {
    setTexB64(null)
    setPdfB64(null)
    setPdfAvailable(false)
    setBulletsEdited(null)
    setKeywordHints([])
    setDraft(null)
    setUpdatedTitles([])
    setUiStep('input')
  }

  function resetCoverLetter() {
    setCoverLetterText('')
    setCoverLetterStatus(null)
  }

  function handleModeChange(nextMode: 'latex' | 'gdocs') {
    setMode(nextMode)
    setError(null)
    setGdocsStatus(null)
    resetOutputs()
    resetCoverLetter()
    setUiStep('input')
  }

  useEffect(() => {
    let active = true
    axios.get(`${BACKEND_URL}/latex/template`).then((res) => {
      if (!active) return
      setHasTemplate(!!res.data?.has_template)
    }).catch(() => {
      if (!active) return
      setHasTemplate(false)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!pdfB64) {
      setPdfUrl('')
      return
    }
    const bytes = b64ToUint8Array(pdfB64)
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    setPdfUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pdfB64])

  function openGoogleAuth() {
    window.open(`${BACKEND_URL}/auth/google`, '_blank', 'width=520,height=720')
  }

  async function loadGoogleDocs() {
    setError(null)
    try {
      const res = await axios.get(`${BACKEND_URL}/google/docs`)
      const files = Array.isArray(res.data?.files) ? res.data.files : []
      setGoogleDocs(files)
      if (!selectedDocId && files.length > 0) {
        setSelectedDocId(files[0].id)
      }
      if (!coverDocId && files.length > 0) {
        setCoverDocId(selectedDocId || files[0].id)
      }
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not load Google Docs. Please connect your account.'
      setError(String(msg))
    }
  }

  async function handleOptimize() {
    setError(null)
    const startTime = Date.now()
    setLoading(true)
    setGdocsStatus(null)
    resetOutputs()
    let nextStep: 'input' | 'edit' | 'export' | null = null
    try {
      if (mode === 'gdocs') {
        const res = await axios.post(`${BACKEND_URL}/google/docs/optimize`, {
          doc_id: selectedDocId,
          job_description: jobDescription,
        })
        const { bullets_edited, keyword_hints } = res.data || {}
        setBulletsEdited(bullets_edited ?? null)
        setKeywordHints(Array.isArray(keyword_hints) ? keyword_hints : [])
        setGdocsStatus('Updated in Google Docs. Open your doc to review the changes.')
        setPdfUrl('')
        setDraft(null)
        nextStep = 'input'
        return
      }

      const form = new FormData()
      form.append('job_description', jobDescription)

      const res = await axios.post(`${BACKEND_URL}/optimize`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      })

      const { tex_base64, pdf_base64, pdf_available, bullets_edited, keyword_hints, draft } = res.data
      setTexB64(tex_base64)
      setPdfB64(pdf_base64)
      setPdfAvailable(!!pdf_available)
      setBulletsEdited(bullets_edited ?? null)
      setKeywordHints(Array.isArray(keyword_hints) ? keyword_hints : [])
      setDraft(draft ?? null)
      setUpdatedTitles(Array.isArray(res.data?.updated_titles) ? res.data.updated_titles : [])
      setPdfUrl('')
      if (draft && pdf_base64) {
        nextStep = 'edit'
      }
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Something went wrong. Check backend logs.'
      setError(String(msg))
    } finally {
      const elapsed = Date.now() - startTime
      const remaining = Math.max(0, 800 - elapsed)
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
      setLoading(false)
      if (nextStep) {
        setUiStep(nextStep)
      }
    }
  }

  async function handleGenerateCoverLetter() {
    setError(null)
    setCoverLoading(true)
    setCoverLetterStatus(null)
    setCoverLetterText('')
    try {
      if (mode === 'gdocs') {
        const res = await axios.post(`${BACKEND_URL}/google/coverletter`, {
          resume_doc_id: selectedDocId,
          cover_doc_id: coverDocId,
          job_description: jobDescription,
        })
        const coverLetter = res.data?.cover_letter
        if (typeof coverLetter === 'string') {
          setCoverLetterText(coverLetter)
        }
        setCoverLetterStatus('Cover letter updated in Google Docs.')
        return
      }

      const form = new FormData()
      form.append('job_description', jobDescription)

      const res = await axios.post(`${BACKEND_URL}/coverletter`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      })
      const coverLetter = res.data?.cover_letter
      setCoverLetterText(typeof coverLetter === 'string' ? coverLetter : '')
      setCoverLetterStatus('Cover letter generated.')
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Something went wrong. Check backend logs.'
      setError(String(msg))
    } finally {
      setCoverLoading(false)
    }
  }

  async function handleSaveTemplate() {
    setError(null)
    try {
      const form = new FormData()
      if (latexFile) {
        form.append('template', latexFile)
      } else {
        form.append('latex_text', latexText)
      }
      const res = await axios.post(`${BACKEND_URL}/latex/template`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setHasTemplate(true)
      setGdocsStatus(res.data?.message || 'Template saved.')
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not save LaTeX template.'
      setError(String(msg))
    }
  }

  function handleDownloadTex() {
    if (!texB64) return
    const bytes = b64ToUint8Array(texB64)
    downloadBytes(bytes, 'resume_optimized.tex', 'application/x-tex')
  }

  function handleDownloadPdf() {
    if (!pdfB64) return
    const bytes = b64ToUint8Array(pdfB64)
    downloadBytes(bytes, 'resume_optimized.pdf', 'application/pdf')
  }

  function handleDownloadCoverLetter() {
    if (!coverLetterText) return
    const bytes = new TextEncoder().encode(coverLetterText)
    downloadBytes(bytes, 'cover_letter.txt', 'text/plain')
  }

  return (
    <div className="page">
      <OptimizeProgressOverlay active={loading} />
      <div className="glow" />
      <div className="container">
        <header className="topbar">
          <div className="brand">
            <div className="logo">
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <path
                  d="M10 36c0-12 8-22 22-22h22v8H32c-9 0-14 6-14 14s5 14 14 14h22v8H32c-14 0-22-10-22-22Z"
                  fill="currentColor"
                />
                <path
                  d="M40 14h14v14h-14z"
                  fill="currentColor"
                  opacity="0.6"
                />
              </svg>
            </div>
            <div>
              <div className="brand-name">Tweakly</div>
              <div className="brand-tag">Latency: ~30s resume tune-up</div>
            </div>
          </div>
          <div className="step-tabs">
            <button
              className={`chip ${uiStep === 'input' ? 'active' : ''}`}
              onClick={() => setUiStep('input')}
            >
              Job Brief
            </button>
            <button
              className={`chip ${uiStep === 'edit' ? 'active' : ''}`}
              onClick={() => setUiStep('edit')}
              disabled={!draft}
            >
              Tune & Edit
            </button>
            <button
              className={`chip ${uiStep === 'outreach' ? 'active' : ''}`}
              onClick={() => setUiStep('outreach')}
              disabled={!draft}
            >
              Outreach
            </button>
          </div>
        </header>
        <div className="hero">
          <div className="eyebrow">Nerdy. Precise. Fast.</div>
          <div className="h1">Tune your resume in ~30 seconds, minus the fluff.</div>
          <p className="p">
            Feed it a job description, point it at your template, and ship a tuned version with your layout preserved.
          </p>
        </div>

        {uiStep === 'input' && (
          <div className="grid grid-2">
            <div className="panel">
              <div className="label">Job description</div>
              <textarea
                className="ta"
                placeholder="Paste the job description here..."
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
              />
              <div className="small subtle">
                Tip: include responsibilities + requirements. Minimum ~40 chars.
              </div>
            </div>

            <div className="panel">
              <div className="label">Resume source</div>
              <div className="mode-toggle">
                <button className={`chip ${mode === 'latex' ? 'active' : ''}`} onClick={() => handleModeChange('latex')}>
                  LaTeX Template
                </button>
                <button className={`chip ${mode === 'gdocs' ? 'active' : ''}`} onClick={() => handleModeChange('gdocs')}>
                  Google Docs
                </button>
              </div>

              {mode === 'latex' ? (
                <>
                  <div className="label" style={{ marginTop: 10 }}>Base resume template (.tex)</div>
                  <input
                    className="input"
                    type="file"
                    accept=".tex"
                    onChange={(e) => setLatexFile(e.target.files?.[0] ?? null)}
                  />
                  <textarea
                    className="ta"
                    placeholder="Or paste your LaTeX template here..."
                    value={latexText}
                    onChange={(e) => setLatexText(e.target.value)}
                  />
                  <div className="actions">
                    <button className="btn" onClick={handleSaveTemplate}>
                      Save Template
                    </button>
                    {hasTemplate ? <span className="badge ok">Template saved</span> : <span className="badge">No template</span>}
                  </div>
                </>
              ) : (
                <>
                  <div className="gdocs-actions">
                    <button className="btn" onClick={openGoogleAuth}>
                      Connect Google Docs
                    </button>
                    <button className="btn" onClick={loadGoogleDocs}>
                      Refresh Docs
                    </button>
                  </div>
                  <select
                    className="input"
                    value={selectedDocId}
                    onChange={(e) => setSelectedDocId(e.target.value)}
                  >
                    <option value="">Select a Google Doc…</option>
                    {googleDocs.map((doc) => (
                      <option key={doc.id} value={doc.id}>{doc.name}</option>
                    ))}
                  </select>
                  <div className="small subtle">Export PDF from Google Docs → File → Download.</div>
                </>
              )}

              <div className="actions">
                <button className="btn primary" disabled={!canOptimize || loading} onClick={handleOptimize}>
                  {loading ? 'Tuning…' : 'Tweak in 30s'}
                </button>
              </div>

              <div className="status-row">
                {mode === 'latex' ? (
                  pdfAvailable ? <span className="badge ok">PDF ready</span> : <span className="badge">PDF optional</span>
                ) : (
                  <span className="badge">Google Docs</span>
                )}
                {bulletsEdited !== null && (
                  <span className="small">
                    Edited bullets: <b>{bulletsEdited}</b>
                    {keywordHints.length > 0 ? (
                      <>
                        {' '}• keyword hints: <b>{keywordHints.join(', ')}</b>
                      </>
                    ) : null}
                  </span>
                )}
                {mode === 'latex' && longBulletCount > 0 && (
                  <span className="badge warn">Bullets &gt;1 line: {longBulletCount}</span>
                )}
                {mode === 'latex' && skillsTooLong && (
                  <span className="badge warn">Skills &gt;3 lines</span>
                )}
              </div>

              {!pdfAvailable && texB64 && mode === 'latex' && (
                <div className="small subtle">
                  PDF export needs pdflatex available on your PATH.
                </div>
              )}

              {gdocsStatus && (
                <div className="small subtle">
                  {gdocsStatus}
                </div>
              )}

              {error && (
                <div className="error">
                  <b>Error:</b> {error}
                </div>
              )}
            </div>
          </div>
        )}

        {mode === 'latex' && draft && (uiStep === 'edit' || uiStep === 'export') && (
          <div className="edit-layout" ref={editPanelRef}>
            <div className="edit-col">
              <div className="panel preview-panel edit-preview" ref={previewRef}>
                <div className="preview-head">
                  <div className="h2">Preview</div>
                  <div className="small subtle">
                    {mode === 'latex' ? 'PDF preview (compiled from LaTeX).' : 'Preview not available for Google Docs.'}
                  </div>
                </div>
                {mode === 'latex' ? (
                  pdfUrl ? (
                    <iframe className="preview-frame" src={pdfUrl} title="Resume PDF preview" />
                  ) : (
                    <div className="preview">No preview yet.</div>
                  )
                ) : (
                  <div className="preview">Preview not available for Google Docs.</div>
                )}
              </div>
              <div className="panel edit-downloads">
                <div className="actions">
                  {mode === 'latex' && (
                    <>
                      <button className="btn" disabled={!texB64} onClick={handleDownloadTex}>
                        Download .tex
                      </button>
                      <button className="btn primary" disabled={!pdfB64} onClick={handleDownloadPdf}>
                        Download PDF
                      </button>
                    </>
                  )}
                </div>
                {estimatedPdfPages > 1 && (
                  <div className="status-row">
                    <span className="badge warn">Estimate: Likely 2 pages</span>
                  </div>
                )}
              </div>
            </div>
            <div className="edit-col">
              <div className="edit-editor">
                <ResumeEditorStructured
                  draftExperiences={draftExperiences}
                  skillsText={draft.skills || ''}
                  onApply={handleApplyChanges}
                />
              </div>
            </div>
          </div>
        )}

        {uiStep === 'edit' && (
          <div className="panel cover-panel">
            <div className="preview-head">
              <div className="h2">Cover Letter</div>
              <div className="small subtle">Generate a separate cover letter from your resume and job description.</div>
            </div>

            {mode === 'gdocs' && (
              <>
                <div className="label">Cover letter Google Doc</div>
                <select
                  className="input"
                  value={coverDocId}
                  onChange={(e) => setCoverDocId(e.target.value)}
                >
                  <option value="">Select a Google Doc…</option>
                  {googleDocs.map((doc) => (
                    <option key={doc.id} value={doc.id}>{doc.name}</option>
                  ))}
                </select>
                <div className="small subtle">This doc will be overwritten with the generated cover letter.</div>
              </>
            )}

            <div className="actions">
              <button className="btn primary" disabled={!canGenerateCover || coverLoading} onClick={handleGenerateCoverLetter}>
                {coverLoading ? 'Generating…' : 'Generate Cover Letter'}
              </button>
              {mode === 'latex' && (
                <button className="btn" disabled={!coverLetterText} onClick={handleDownloadCoverLetter}>
                  Download Cover Letter
                </button>
              )}
            </div>

            {coverLetterStatus && (
              <div className="small subtle">
                {coverLetterStatus}
              </div>
            )}

            <textarea
              className="ta ta-cover"
              placeholder="Your generated cover letter will appear here..."
              value={coverLetterText}
              onChange={(e) => setCoverLetterText(e.target.value)}
            />
          </div>
        )}

        {uiStep === 'outreach' && (
          <div className="panel cover-panel">
            <div className="preview-head">
              <div className="h2">Outreach Intelligence</div>
              <div className="small subtle">
                Identify who to reach out to and what to say based on this job.
              </div>
            </div>
            {outreachLoading && (
              <div className="small subtle">Generating outreach ideas…</div>
            )}
            {outreachError && (
              <div className="error">
                <b>Error:</b> {outreachError}
              </div>
            )}
            {!outreachLoading && !outreachError && outreachPreview && (
              <div className="outreach-grid">
                <div className="outreach-card">
                  <div className="h3">Who to reach out to</div>
                  <ul className="outreach-list">
                    {outreachPreview.target_roles.map((role, idx) => (
                      <li key={`${role}-${idx}`}>{role}</li>
                    ))}
                  </ul>
                </div>
                <div className="outreach-card">
                <div className="h3">How to find them</div>
                  <ul className="outreach-list">
                    {outreachPreview.linkedin_searches.map((search, idx) => (
                      <li key={`${search.url}-${idx}`}>
                        <a href={search.url} target="_blank" rel="noreferrer">
                          {search.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="outreach-card">
                <div className="h3">What to say</div>
                  <div className="outreach-messages">
                    <div className="outreach-message">
                      {outreachPreview.outreach_message}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {!outreachLoading && !outreachError && !outreachPreview && (
              <div className="muted-box">
                Coming next: target roles, LinkedIn search hints, and outreach messages.
              </div>
            )}
          </div>
        )}

        <footer className="footer">
          <div className="footer-title">Built for people who geek out on clean signal.</div>
          <div className="footer-copy">
            Tweakly is your resume co-processor: fast iterations, minimal noise, maximal clarity.
          </div>
        </footer>
      </div>
    </div>
  )
}
