import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'

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

  const [texB64, setTexB64] = useState<string | null>(null)
  const [pdfB64, setPdfB64] = useState<string | null>(null)
  const [pdfAvailable, setPdfAvailable] = useState(false)
  const [bulletsEdited, setBulletsEdited] = useState<number | null>(null)
  const [keywordHints, setKeywordHints] = useState<string[]>([])
  const [coverLetterText, setCoverLetterText] = useState<string>('')
  const [pdfUrl, setPdfUrl] = useState<string>('')

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

  function resetOutputs() {
    setTexB64(null)
    setPdfB64(null)
    setPdfAvailable(false)
    setBulletsEdited(null)
    setKeywordHints([])
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
    setLoading(true)
    setGdocsStatus(null)
    resetOutputs()
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
        return
      }

      const form = new FormData()
      form.append('job_description', jobDescription)

      const res = await axios.post(`${BACKEND_URL}/optimize`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      })

      const { tex_base64, pdf_base64, pdf_available, bullets_edited, keyword_hints } = res.data
      setTexB64(tex_base64)
      setPdfB64(pdf_base64)
      setPdfAvailable(!!pdf_available)
      setBulletsEdited(bullets_edited ?? null)
      setKeywordHints(Array.isArray(keyword_hints) ? keyword_hints : [])
      setPdfUrl('')
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Something went wrong. Check backend logs.'
      setError(String(msg))
    } finally {
      setLoading(false)
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
      <div className="glow" />
      <div className="container">
        <div className="hero">
          <div className="eyebrow">Resume Tweaker AI</div>
          <div className="h1">Tweak your resume to the job in minutes.</div>
          <p className="p">
            Paste a job description, upload your LaTeX template, and get a tailored version that keeps the layout intact.
          </p>
        </div>

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
                {loading ? 'Optimizing…' : 'Optimize'}
              </button>
              {mode === 'latex' && (
                <>
                  <button className="btn" disabled={!texB64} onClick={handleDownloadTex}>
                    Download .tex
                  </button>
                  <button className="btn" disabled={!pdfB64} onClick={handleDownloadPdf}>
                    Download PDF
                  </button>
                </>
              )}
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

        <div className="panel preview-panel">
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
      </div>
    </div>
  )
}
