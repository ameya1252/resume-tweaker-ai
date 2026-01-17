import React, { useMemo, useState } from 'react'
import axios from 'axios'
import mammoth from 'mammoth'

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
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'docx' | 'gdocs'>('docx')
  const [googleDocs, setGoogleDocs] = useState<GoogleDoc[]>([])
  const [selectedDocId, setSelectedDocId] = useState('')
  const [coverDocId, setCoverDocId] = useState('')
  const [gdocsStatus, setGdocsStatus] = useState<string | null>(null)
  const [coverLetterStatus, setCoverLetterStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [coverLoading, setCoverLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [docxB64, setDocxB64] = useState<string | null>(null)
  const [pdfB64, setPdfB64] = useState<string | null>(null)
  const [pdfAvailable, setPdfAvailable] = useState(false)
  const [bulletsEdited, setBulletsEdited] = useState<number | null>(null)
  const [keywordHints, setKeywordHints] = useState<string[]>([])
  const [previewHtml, setPreviewHtml] = useState<string>('')
  const [coverLetterText, setCoverLetterText] = useState<string>('')

  const canOptimize = useMemo(() => {
    if (mode === 'gdocs') {
      return jobDescription.trim().length > 40 && !!selectedDocId
    }
    return jobDescription.trim().length > 40 && !!file
  }, [jobDescription, file, mode, selectedDocId])

  const canGenerateCover = useMemo(() => {
    if (mode === 'gdocs') {
      return jobDescription.trim().length > 40 && !!selectedDocId && !!coverDocId
    }
    return jobDescription.trim().length > 40 && !!file
  }, [jobDescription, file, mode, selectedDocId, coverDocId])

  function resetOutputs() {
    setDocxB64(null)
    setPdfB64(null)
    setPdfAvailable(false)
    setPreviewHtml('')
    setBulletsEdited(null)
    setKeywordHints([])
  }

  function resetCoverLetter() {
    setCoverLetterText('')
    setCoverLetterStatus(null)
  }

  function handleModeChange(nextMode: 'docx' | 'gdocs') {
    setMode(nextMode)
    setError(null)
    setGdocsStatus(null)
    resetOutputs()
    resetCoverLetter()
  }

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
        setPreviewHtml('<div style="opacity:.6">Preview not available for Google Docs.</div>')
        return
      }

      const form = new FormData()
      form.append('job_description', jobDescription)
      form.append('resume', file!)

      const res = await axios.post(`${BACKEND_URL}/optimize`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      })

      const { docx_base64, pdf_base64, pdf_available, bullets_edited, keyword_hints } = res.data
      setDocxB64(docx_base64)
      setPdfB64(pdf_base64)
      setPdfAvailable(!!pdf_available)
      setBulletsEdited(bullets_edited ?? null)
      setKeywordHints(Array.isArray(keyword_hints) ? keyword_hints : [])

      // Render preview (DOCX -> HTML) in browser
      const bytes = b64ToUint8Array(docx_base64)
      const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer })
      setPreviewHtml(result.value || '')
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
      form.append('resume', file!)

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

  function handleDownloadDocx() {
    if (!docxB64) return
    const bytes = b64ToUint8Array(docxB64)
    downloadBytes(bytes, 'resume_optimized.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
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
            Paste a job description, upload your DOCX, and get a tailored version that keeps the layout intact.
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
              <button className={`chip ${mode === 'docx' ? 'active' : ''}`} onClick={() => handleModeChange('docx')}>
                Upload DOCX
              </button>
              <button className={`chip ${mode === 'gdocs' ? 'active' : ''}`} onClick={() => handleModeChange('gdocs')}>
                Google Docs
              </button>
            </div>

            {mode === 'docx' ? (
              <>
                <div className="label" style={{ marginTop: 10 }}>Base resume (DOCX)</div>
                <input
                  className="input"
                  type="file"
                  accept=".docx"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
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
              {mode === 'docx' && (
                <>
                  <button className="btn" disabled={!docxB64} onClick={handleDownloadDocx}>
                    Download DOCX
                  </button>
                  <button className="btn" disabled={!pdfB64} onClick={handleDownloadPdf}>
                    Download PDF
                  </button>
                </>
              )}
            </div>

            <div className="status-row">
              {mode === 'docx' ? (
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

            {!pdfAvailable && docxB64 && mode === 'docx' && (
              <div className="small subtle">
                PDF export needs LibreOffice (<code>soffice</code>) on your PATH. You can still download DOCX.
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
            {mode === 'docx' && (
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
              {mode === 'docx' ? 'DOCX → HTML preview (layout may vary slightly).' : 'Preview not available for Google Docs.'}
            </div>
          </div>
          <div
            className="preview"
            dangerouslySetInnerHTML={{ __html: previewHtml || '<div style="opacity:.6">No preview yet.</div>' }}
          />
        </div>
      </div>
    </div>
  )
}
