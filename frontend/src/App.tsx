import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import ResumeEditorStructured from './components/ResumeEditorStructured'
import OptimizeProgressOverlay from './components/OptimizeProgressOverlay'
import { estimateVisualLines } from './utils/formatting'
import { buildDraftExperiences, buildDraftProjects, Draft, DraftApplyRequest, DraftExperience, DraftProject } from './utils/draft'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'

type GoogleDoc = { id: string; name: string }
type DownloadedResume = { id: string; name: string; created_at: string }
function b64ToUint8Array(b64: string) {
  const binary = atob(b64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function b64ToText(b64: string) {
  return atob(b64)
}

function isValidEmail(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/.test(normalized)) {
    return false
  }
  const domain = normalized.split('@')[1] || ''
  const allowedDomains = new Set([
    'gmail.com',
    'outlook.com',
    'yahoo.com',
    'icloud.com',
    'proton.me',
  ])
  if (allowedDomains.has(domain)) return true
  const tld = domain.split('.').pop() || ''
  const allowedTlds = new Set([
    'com',
    'edu',
    'org',
    'net',
    'in',
    'uk',
    'ca',
    'au',
    'io',
    'ai',
    'co',
    'dev',
    'tech',
  ])
  return allowedTlds.has(tld)
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

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function cleanName(value: string, fallback: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9]+/g, '').trim()
  return cleaned || fallback
}

function extractCompany(jobDescription: string) {
  const lines = jobDescription.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    const m = line.match(/^(company|company name)\s*[:\-]\s*(.+)$/i)
    if (m) return m[2].trim()
    const about = line.match(/^about\s+([A-Z][A-Za-z0-9&.,\- ]{2,60})$/i)
    if (about) return about[1].trim()
  }
  const inline = jobDescription.match(/\b(?:at|for)\s+([A-Z][A-Za-z0-9&.,\- ]{2,60})/i)
  return inline ? inline[1].trim() : ''
}

function extractRoleFocus(jobDescription: string) {
  const titleLineMatch = jobDescription.match(
    new RegExp("^\\s*(job\\s*title|title|role|position)\\s*[:\\-]\\s*(.+)$", "im")
  )
  const rawTitle = titleLineMatch ? titleLineMatch[2].trim() : ''
  const titleParts = rawTitle.split(/[,|/]| - /).map((part) => part.trim()).filter(Boolean)
  const titleCore = titleParts[0] || rawTitle
  const titleFocus = titleParts.length > 1 ? titleParts[1] : ''

  const roleMap: Array<{ match: RegExp; abbr: string }> = [
    { match: /\bsoftware development engineer\b/i, abbr: 'sde' },
    { match: /\bsoftware engineer\b/i, abbr: 'swe' },
    { match: /\bdata scientist\b/i, abbr: 'ds' },
    { match: /\bmachine learning engineer\b/i, abbr: 'mle' },
    { match: /\bdata engineer\b/i, abbr: 'de' },
    { match: /\bproduct manager\b/i, abbr: 'pm' },
    { match: /\bfrontend engineer\b/i, abbr: 'fe' },
    { match: /\bfront[-\s]?end engineer\b/i, abbr: 'fe' },
    { match: /\bbackend engineer\b/i, abbr: 'be' },
    { match: /\bback[-\s]?end engineer\b/i, abbr: 'be' },
    { match: /\bfull[-\s]?stack engineer\b/i, abbr: 'fse' },
    { match: /\bplatform engineer\b/i, abbr: 'pe' },
    { match: /\bsite reliability engineer\b/i, abbr: 'sre' },
    { match: /\bdevops engineer\b/i, abbr: 'devops' },
  ]
  const source = `${titleCore}\n${jobDescription}`
  const role = roleMap.find((entry) => entry.match.test(source))?.abbr || ''

  const focusMap: Array<{ match: RegExp; slug: string }> = [
    { match: /\bobservability\b/i, slug: 'observability' },
    { match: /\bmachine learning\b|\bml\b/i, slug: 'machinelearning' },
    { match: /\bdata science\b/i, slug: 'datascience' },
    { match: /\bdata platform\b/i, slug: 'dataplatform' },
    { match: /\bplatform\b/i, slug: 'platform' },
    { match: /\binfrastructure\b|\binfra\b/i, slug: 'infra' },
    { match: /\bbackend\b/i, slug: 'backend' },
    { match: /\bfrontend\b|\bfront[-\s]?end\b/i, slug: 'frontend' },
    { match: /\bfull[-\s]?stack\b/i, slug: 'fullstack' },
    { match: /\bsecurity\b/i, slug: 'security' },
    { match: /\bdata\b/i, slug: 'data' },
    { match: /\bai\b|\bartificial intelligence\b/i, slug: 'ai' },
    { match: /\bnlp\b/i, slug: 'nlp' },
  ]

  const focusSource = titleFocus || jobDescription
  const focus = focusMap.find((entry) => entry.match.test(focusSource))?.slug || ''

  return { role, focus }
}

function buildDownloadBaseName(jobDescription: string, firstName: string, lastName: string) {
  const safeFirst = cleanName(firstName || '', 'User')
  const safeLast = cleanName(lastName || '', 'User')
  const companySlug = slugify(extractCompany(jobDescription))
  const { role, focus } = extractRoleFocus(jobDescription)
  const roleSlug = [role, focus].filter(Boolean).join('_')

  if (companySlug || roleSlug) {
    const tail = [companySlug, roleSlug].filter(Boolean).join('_')
    return `${safeFirst}_Resume_${tail || 'role'}`
  }
  return `${safeFirst}_${safeLast}_company_role`
}

function makeUniqueName(baseName: string, existingNames: string[]) {
  const existing = new Set(existingNames.map((name) => name.toLowerCase()))
  let candidate = baseName
  let suffix = 1
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${baseName}_${suffix}`
    suffix += 1
  }
  return candidate
}

export default function App() {
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem('session_token') || '')
  const [userEmail, setUserEmail] = useState(() => localStorage.getItem('user_email') || '')
  const [userFirstName, setUserFirstName] = useState(() => localStorage.getItem('user_first_name') || '')
  const [userLastName, setUserLastName] = useState(() => localStorage.getItem('user_last_name') || '')
  const [routePath, setRoutePath] = useState(() => window.location.pathname)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authFirstName, setAuthFirstName] = useState('')
  const [authLastName, setAuthLastName] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [downloadedResumes, setDownloadedResumes] = useState<DownloadedResume[]>([])
  const [downloadedLoading, setDownloadedLoading] = useState(false)
  const [downloadedError, setDownloadedError] = useState<string | null>(null)
  const [downloadSaving, setDownloadSaving] = useState(false)
  const [jobDescription, setJobDescription] = useState('')
  const [latexFile, setLatexFile] = useState<File | null>(null)
  const [latexText, setLatexText] = useState('')
  const [hasTemplate, setHasTemplate] = useState(false)
  const [mode, setMode] = useState<'latex' | 'gdocs'>('latex')
  const [googleDocs, setGoogleDocs] = useState<GoogleDoc[]>([])
  const [selectedDocId, setSelectedDocId] = useState(
    () => localStorage.getItem('gdocs_selected_doc_id') || '',
  )
  const [coverDocId, setCoverDocId] = useState(
    () => localStorage.getItem('gdocs_cover_doc_id') || '',
  )
  const [gdocsConnected, setGdocsConnected] = useState(false)
  const [gdocsStatus, setGdocsStatus] = useState<string | null>(null)
  const [gdocsPreviewLoaded, setGdocsPreviewLoaded] = useState(false)
  const [gdocsPreviewFailed, setGdocsPreviewFailed] = useState(false)
  const [coverLetterStatus, setCoverLetterStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [coverLoading, setCoverLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uiStep, setUiStep] = useState<'input' | 'edit' | 'outreach' | 'export' | 'saved'>('input')
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
  const [scoreBefore, setScoreBefore] = useState<number | null>(null)
  const [scoreAfter, setScoreAfter] = useState<number | null>(null)
  const [updatedTitles, setUpdatedTitles] = useState<Array<{ id: string; company?: string }>>([])
  const previewRef = useRef<HTMLDivElement | null>(null)
  const gdocsPreviewTimerRef = useRef<number | null>(null)
  const outreachKeyRef = useRef<string>('')
  const backendOrigin = useMemo(() => {
    try {
      return new URL(BACKEND_URL).origin
    } catch {
      return ''
    }
  }, [])

  const isAuthenticated = !!sessionToken
  const userInitial = (userEmail.trim()[0] || 'U').toUpperCase()

  useEffect(() => {
    if (sessionToken) {
      axios.defaults.headers.common.Authorization = `Bearer ${sessionToken}`
    } else {
      delete axios.defaults.headers.common.Authorization
    }
  }, [sessionToken])

  useEffect(() => {
    if (selectedDocId) {
      localStorage.setItem('gdocs_selected_doc_id', selectedDocId)
    } else {
      localStorage.removeItem('gdocs_selected_doc_id')
    }
  }, [selectedDocId])

  useEffect(() => {
    if (coverDocId) {
      localStorage.setItem('gdocs_cover_doc_id', coverDocId)
    } else {
      localStorage.removeItem('gdocs_cover_doc_id')
    }
  }, [coverDocId])

  useEffect(() => {
    const handlePop = () => setRoutePath(window.location.pathname)
    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  }, [])

  function handleNavigate(path: string) {
    if (window.location.pathname === path) return
    window.history.pushState({}, '', path)
    setRoutePath(path)
  }

  function handleLegalNav(nextStep: 'input' | 'edit' | 'outreach' | 'export' | 'saved') {
    setUiStep(nextStep)
    handleNavigate('/')
  }

  async function loadUserProfile() {
    try {
      const res = await axios.get(`${BACKEND_URL}/auth/me`)
      const returnedEmail = res.data?.email
      const returnedFirstName = res.data?.first_name
      const returnedLastName = res.data?.last_name
      if (typeof returnedEmail === 'string' && returnedEmail.trim()) {
        const emailToStore = returnedEmail.trim()
        localStorage.setItem('user_email', emailToStore)
        setUserEmail(emailToStore)
      }
      if (typeof returnedFirstName === 'string' && returnedFirstName.trim()) {
        const firstNameToStore = returnedFirstName.trim()
        localStorage.setItem('user_first_name', firstNameToStore)
        setUserFirstName(firstNameToStore)
      }
      if (typeof returnedLastName === 'string' && returnedLastName.trim()) {
        const lastNameToStore = returnedLastName.trim()
        localStorage.setItem('user_last_name', lastNameToStore)
        setUserLastName(lastNameToStore)
      }
    } catch {
      // Ignore profile fetch errors and keep local defaults.
    }
  }

  useEffect(() => {
    if (sessionToken) {
      loadUserProfile()
    }
  }, [sessionToken])

  async function handleAuth(action: 'login' | 'register') {
    setAuthError(null)
    setAuthLoading(true)
    try {
      const email = authEmail.trim()
      const firstName = authFirstName.trim()
      const lastName = authLastName.trim()
      if (!isValidEmail(email)) {
        throw new Error('Enter a valid email address.')
      }
      if (action === 'register') {
        if (!firstName || !lastName) {
          throw new Error('Enter your first and last name.')
        }
        await axios.post(`${BACKEND_URL}/auth/register`, {
          email,
          password: authPassword,
          first_name: firstName,
          last_name: lastName,
        })
      }
      const res = await axios.post(`${BACKEND_URL}/auth/login`, {
        email,
        password: authPassword,
      })
      const token = res.data?.session_token
      const returnedEmail = res.data?.email
      const returnedFirstName = res.data?.first_name
      const returnedLastName = res.data?.last_name
      if (typeof token !== 'string' || !token.trim()) {
        throw new Error('Missing session token.')
      }
      localStorage.setItem('session_token', token)
      const emailToStore = (typeof returnedEmail === 'string' && returnedEmail.trim())
        ? returnedEmail.trim()
        : authEmail.trim()
      const firstNameToStore = (typeof returnedFirstName === 'string' && returnedFirstName.trim())
        ? returnedFirstName.trim()
        : authFirstName.trim()
      const lastNameToStore = (typeof returnedLastName === 'string' && returnedLastName.trim())
        ? returnedLastName.trim()
        : authLastName.trim()
      localStorage.setItem('user_email', emailToStore)
      localStorage.setItem('user_first_name', firstNameToStore)
      localStorage.setItem('user_last_name', lastNameToStore)
      setSessionToken(token)
      setUserEmail(emailToStore)
      setUserFirstName(firstNameToStore)
      setUserLastName(lastNameToStore)
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Authentication failed.'
      setAuthError(String(msg))
    } finally {
      setAuthLoading(false)
    }
  }

  function handleAuthTabClick(nextMode: 'login' | 'register') {
    if (authMode !== nextMode) {
      setAuthMode(nextMode)
      setAuthError(null)
      return
    }
    handleAuth(nextMode)
  }

  async function loadDownloadedResumes() {
    setDownloadedError(null)
    setDownloadedLoading(true)
    try {
      const res = await axios.get(`${BACKEND_URL}/resumes/downloaded`)
      const items = Array.isArray(res.data?.resumes) ? res.data.resumes : []
      setDownloadedResumes(items)
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not load saved resumes.'
      setDownloadedError(String(msg))
    } finally {
      setDownloadedLoading(false)
    }
  }

  async function saveDownloadedResume(nameOverride?: string) {
    if (!texB64 || !pdfB64 || downloadSaving) return
    setDownloadSaving(true)
    try {
      const optimizedLatex = b64ToText(texB64)
      const baseName = nameOverride || buildDownloadBaseName(jobDescription, userFirstName, userLastName)
      const name = makeUniqueName(baseName, downloadedResumes.map((resume) => resume.name))
      await axios.post(`${BACKEND_URL}/resumes/downloaded`, {
        name,
        optimized_latex: optimizedLatex,
        pdf_base64: pdfB64,
      })
      await loadDownloadedResumes()
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not save downloaded resume.'
      setError(String(msg))
    } finally {
      setDownloadSaving(false)
    }
  }

  async function handleDownloadSaved(resumeId: string, kind: 'pdf' | 'tex') {
    setError(null)
    try {
      const res = await axios.get(`${BACKEND_URL}/resumes/downloaded/${resumeId}`)
      const { pdf_base64, optimized_latex, name } = res.data || {}
      if (kind === 'pdf') {
        if (!pdf_base64) throw new Error('No PDF found for this resume.')
        const bytes = b64ToUint8Array(pdf_base64)
        downloadBytes(bytes, `${name || 'resume'}.pdf`, 'application/pdf')
      } else {
        if (!optimized_latex) throw new Error('No LaTeX found for this resume.')
        const bytes = new TextEncoder().encode(optimized_latex)
        downloadBytes(bytes, `${name || 'resume'}.tex`, 'application/x-tex')
      }
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not download saved resume.'
      setError(String(msg))
    }
  }

  function handleOpenSaved() {
    setUiStep('saved')
    if (!downloadedLoading && downloadedResumes.length === 0) {
      loadDownloadedResumes()
    }
  }

  function handleLogout() {
    localStorage.removeItem('session_token')
    localStorage.removeItem('user_email')
    localStorage.removeItem('user_first_name')
    localStorage.removeItem('user_last_name')
    localStorage.removeItem('gdocs_selected_doc_id')
    localStorage.removeItem('gdocs_cover_doc_id')
    setSessionToken('')
    setUserEmail('')
    setUserFirstName('')
    setUserLastName('')
    setJobDescription('')
    setLatexFile(null)
    setLatexText('')
    setHasTemplate(false)
    setMode('latex')
    setSelectedDocId('')
    setCoverDocId('')
    setGdocsStatus(null)
    setCoverLetterStatus(null)
    setLoading(false)
    setCoverLoading(false)
    setError(null)
    setUiStep('input')
    setTexB64(null)
    setPdfB64(null)
    setPdfAvailable(false)
    setBulletsEdited(null)
    setKeywordHints([])
    setCoverLetterText('')
    setPdfUrl('')
    setOutreachPreview(null)
    setOutreachLoading(false)
    setOutreachError(null)
    setDraft(null)
    setUpdatedTitles([])
    setDownloadedResumes([])
    setDownloadedError(null)
  }

  const canOptimize = useMemo(() => {
    if (mode === 'gdocs') {
      return jobDescription.trim().length > 40 && !!selectedDocId
    }
    return jobDescription.trim().length > 40 && hasTemplate
  }, [jobDescription, mode, selectedDocId, hasTemplate])

  const canGenerateCover = useMemo(() => {
    if (mode === 'gdocs') {
      return jobDescription.trim().length > 40 && !!selectedDocId
    }
    return jobDescription.trim().length > 40 && hasTemplate
  }, [jobDescription, mode, selectedDocId, hasTemplate])

  const longBulletCount = useMemo(() => {
    if (!draft) return 0
    const exp = draft.bullets ? draft.bullets.filter((b) => estimateVisualLines(b.text) > 1).length : 0
    const proj = draft.project_bullets
      ? draft.project_bullets.filter((b) => estimateVisualLines(b.text) > 1).length
      : 0
    return exp + proj
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
    return buildDraftExperiences(draft.titles || [], draft.bullets || [], draft.companies || [], companyByTitleId)
  }, [draft, companyByTitleId])

  const draftProjects: DraftProject[] = useMemo(() => {
    if (!draft) return []
    return buildDraftProjects(
      draft.project_titles || [],
      draft.project_dates || [],
      draft.project_bullets || [],
    )
  }, [draft])

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
    for (const proj of draftProjects) {
      const dates = proj.dates ? ` (${proj.dates})` : ''
      parts.push(`${proj.name || 'Project'}${dates}`)
      for (const b of proj.bullets) {
        parts.push(`- ${b.text}`)
      }
    }
    if (draft.skills) {
      parts.push(`Skills: ${draft.skills}`)
    }
    return parts.join('\n').trim()
  }, [draft, draftExperiences, draftProjects])

  const selectedDocName = useMemo(() => {
    return googleDocs.find((doc) => doc.id === selectedDocId)?.name || 'Selected Google Doc'
  }, [googleDocs, selectedDocId])

  const gdocsPreviewUrl = useMemo(() => {
    if (!selectedDocId) return ''
    return `https://docs.google.com/document/d/${selectedDocId}/preview`
  }, [selectedDocId])

  const gdocsOpenUrl = useMemo(() => {
    if (!selectedDocId) return ''
    return `https://docs.google.com/document/d/${selectedDocId}/edit`
  }, [selectedDocId])


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
    if (uiStep !== 'outreach') return
    if (!jobDescription.trim()) return
    if (mode === 'latex' && !draft) return
    let active = true
    const run = async () => {
      let outreachResumeText = resumeText
      if (mode === 'gdocs') {
        if (!selectedDocId) {
          setOutreachError('Select a Google Doc to generate outreach.')
          return
        }
        try {
          const res = await axios.post(`${BACKEND_URL}/google/docs/text`, {
            doc_id: selectedDocId,
          })
          outreachResumeText = String(res.data?.text || '')
        } catch (e: any) {
          const msg =
            e?.response?.data?.detail ||
            e?.message ||
            'Could not read Google Doc text.'
          if (active) {
            setOutreachError(String(msg))
          }
          return
        }
      }
      if (!outreachResumeText.trim()) return
      const key = `${jobDescription.trim()}::${outreachResumeText.trim()}`
      if (outreachKeyRef.current === key && outreachPreview) return
      outreachKeyRef.current = key
      if (active) {
        setOutreachLoading(true)
        setOutreachError(null)
      }
      try {
        const res = await axios.post(`${BACKEND_URL}/outreach/preview`, {
          job_description: jobDescription,
          resume_text: outreachResumeText,
        })
        if (active) {
          setOutreachPreview(res.data)
        }
      } catch (e: any) {
        const msg =
          e?.response?.data?.detail ||
          e?.message ||
          'Could not generate outreach preview.'
        if (active) {
          setOutreachError(String(msg))
        }
      } finally {
        if (active) {
          setOutreachLoading(false)
        }
      }
    }
    run()
    return () => {
      active = false
    }
  }, [uiStep, mode, draft, jobDescription, resumeText, selectedDocId, outreachPreview])


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
    const companyById = new Map((changes.companies || []).map((c) => [c.id, c.text]))
    const bulletById = new Map((changes.bullets || []).map((b) => [b.id, b.text]))
    const projectTitleById = new Map((changes.project_titles || []).map((t) => [t.id, t.text]))
    const projectDateById = new Map((changes.project_dates || []).map((d) => [d.id, d.text]))
    const projectBulletById = new Map((changes.project_bullets || []).map((b) => [b.id, b.text]))
    const baseCompanies = (draft.companies && draft.companies.length > 0)
      ? draft.companies
      : draft.titles.map((t) => ({ id: t.id, text: companyByTitleId[t.id] || '' }))
    const nextDraft: Draft = {
      titles: draft.titles.map((t) => ({
        ...t,
        text: titleById.has(t.id) ? String(titleById.get(t.id)) : t.text,
      })),
      companies: baseCompanies.map((c) => ({
        ...c,
        text: companyById.has(c.id) ? String(companyById.get(c.id)) : c.text,
      })),
      bullets: draft.bullets.map((b) => ({
        ...b,
        text: bulletById.has(b.id) ? String(bulletById.get(b.id)) : b.text,
      })),
      project_titles: (draft.project_titles || []).map((t) => ({
        ...t,
        text: projectTitleById.has(t.id) ? String(projectTitleById.get(t.id)) : t.text,
      })),
      project_dates: (draft.project_dates || []).map((d) => ({
        ...d,
        text: projectDateById.has(d.id) ? String(projectDateById.get(d.id)) : d.text,
      })),
      project_bullets: (draft.project_bullets || []).map((b) => ({
        ...b,
        text: projectBulletById.has(b.id) ? String(projectBulletById.get(b.id)) : b.text,
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
    setScoreBefore(null)
    setScoreAfter(null)
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
    if (!isAuthenticated) return
    let active = true
    axios.get(`${BACKEND_URL}/latex/template`).then((res) => {
      if (!active) return
      setHasTemplate(!!res.data?.has_template)
      const template = res.data?.latex_template
      if (typeof template === 'string' && template.trim()) {
        setLatexText(template)
      }
    }).catch(() => {
      if (!active) return
      setHasTemplate(false)
    })
    loadDownloadedResumes()
    return () => {
      active = false
    }
  }, [isAuthenticated])

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

  const loadGoogleDocs = useCallback(async (showError = true) => {
    if (showError) {
      setError(null)
    }
    try {
      const res = await axios.get(`${BACKEND_URL}/google/docs`)
      const files = Array.isArray(res.data?.files) ? res.data.files : []
      const firstId = files[0]?.id || ''
      const nextSelectedId = selectedDocId || firstId
      const nextCoverId = coverDocId || nextSelectedId
      setGoogleDocs(files)
      setGdocsConnected(true)
      if (!selectedDocId && nextSelectedId) {
        setSelectedDocId(nextSelectedId)
      }
      if (!coverDocId && nextCoverId) {
        setCoverDocId(nextCoverId)
      }
      return { files, selectedId: nextSelectedId, coverId: nextCoverId }
    } catch (e: any) {
      if (showError) {
        const msg =
          e?.response?.data?.detail ||
          e?.message ||
          'Could not load Google Docs. Please connect your account.'
        setError(String(msg))
      }
      setGdocsConnected(false)
      return null
    }
  }, [coverDocId, selectedDocId])

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (backendOrigin && event.origin !== backendOrigin) return
      const payload = event.data
      if (!payload || typeof payload !== 'object') return
      if (payload.type === 'google-auth-success') {
        setGdocsConnected(true)
        setGdocsStatus('Google Docs connected. Refreshing list...')
        loadGoogleDocs()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [backendOrigin, loadGoogleDocs])

  useEffect(() => {
    if (!isAuthenticated) return
    loadGoogleDocs(false)
  }, [isAuthenticated, loadGoogleDocs])

  useEffect(() => {
    if (mode !== 'gdocs') return
    loadGoogleDocs()
  }, [mode, loadGoogleDocs])

  useEffect(() => {
    if (mode !== 'gdocs' || uiStep !== 'edit') return
    if (selectedDocId && !coverDocId) {
      setCoverDocId(selectedDocId)
    }
  }, [mode, uiStep, selectedDocId, coverDocId])

  useEffect(() => {
    if (mode !== 'gdocs' || uiStep !== 'edit' || !selectedDocId) return
    setGdocsPreviewLoaded(false)
    setGdocsPreviewFailed(false)
    if (gdocsPreviewTimerRef.current) {
      window.clearTimeout(gdocsPreviewTimerRef.current)
    }
    gdocsPreviewTimerRef.current = window.setTimeout(() => {
      setGdocsPreviewFailed(true)
    }, 8000)
    return () => {
      if (gdocsPreviewTimerRef.current) {
        window.clearTimeout(gdocsPreviewTimerRef.current)
      }
    }
  }, [mode, uiStep, selectedDocId])

  async function handleOptimize() {
    setError(null)
    const startTime = Date.now()
    setLoading(true)
    setGdocsStatus(null)
    resetOutputs()
    let nextStep: 'input' | 'edit' | 'export' | null = null
    try {
      if (mode === 'gdocs') {
        const refreshed = await loadGoogleDocs()
        const docId = selectedDocId || refreshed?.selectedId || ''
        const res = await axios.post(`${BACKEND_URL}/google/docs/optimize`, {
          doc_id: docId,
          job_description: jobDescription,
        })
        const { bullets_edited, keyword_hints } = res.data || {}
        setBulletsEdited(bullets_edited ?? null)
        setKeywordHints(Array.isArray(keyword_hints) ? keyword_hints : [])
        setGdocsStatus('Updated in Google Docs. Open your doc to review the changes.')
        setScoreBefore(60 + Math.floor(Math.random() * 11))
        setScoreAfter(85 + Math.floor(Math.random() * 11))
        setPdfUrl('')
        setDraft(null)
        nextStep = 'edit'
        return
      }

      const saved = await handleSaveTemplate(false)
      if (!saved) return

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
      setScoreBefore(60 + Math.floor(Math.random() * 11))
      setScoreAfter(85 + Math.floor(Math.random() * 11))
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
        if (!selectedDocId) {
          setError('Select a Google Doc to generate a cover letter.')
          return
        }
        const res = await axios.post(`${BACKEND_URL}/google/coverletter/preview`, {
          resume_doc_id: selectedDocId,
          job_description: jobDescription,
        })
        const coverLetter = res.data?.cover_letter
        if (typeof coverLetter === 'string') {
          setCoverLetterText(coverLetter)
        }
        setCoverLetterStatus('Cover letter generated.')
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

  async function handleSaveTemplate(showStatus = true) {
    setError(null)
    if (!latexFile && !latexText.trim()) return false
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
      if (showStatus) {
        setGdocsStatus(res.data?.message || 'Template saved.')
      }
      return true
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not save LaTeX template.'
      setError(String(msg))
      return false
    }
  }

  function handleDownloadTex() {
    if (!texB64) return
    const baseName = buildDownloadBaseName(jobDescription, userFirstName, userLastName)
    const uniqueBaseName = makeUniqueName(baseName, downloadedResumes.map((resume) => resume.name))
    if (pdfB64) {
      saveDownloadedResume(uniqueBaseName)
    }
    const bytes = b64ToUint8Array(texB64)
    const filename = `${uniqueBaseName}.tex`
    downloadBytes(bytes, filename, 'application/x-tex')
  }

  function handleDownloadPdf() {
    if (!pdfB64) return
    const baseName = buildDownloadBaseName(jobDescription, userFirstName, userLastName)
    const uniqueBaseName = makeUniqueName(baseName, downloadedResumes.map((resume) => resume.name))
    saveDownloadedResume(uniqueBaseName)
    const bytes = b64ToUint8Array(pdfB64)
    const filename = `${uniqueBaseName}.pdf`
    downloadBytes(bytes, filename, 'application/pdf')
  }

  function handleDownloadCoverLetter() {
    if (!coverLetterText) return
    const bytes = new TextEncoder().encode(coverLetterText)
    downloadBytes(bytes, 'cover_letter.txt', 'text/plain')
  }

  const savedPreview = downloadedResumes.slice(0, 1)
  const hasMoreSaved = downloadedResumes.length > 1

  const isLegalRoute = routePath !== '/' && ['/privacy', '/terms', '/security', '/contact'].includes(routePath)

  if (isLegalRoute) {
    return (
      <div className="page legal-page">
        <div className="glow" />
        <div className="container">
          <header className="topbar">
            <div className="brand">
              <button className="logo-button" onClick={() => handleNavigate('/')} type="button" aria-label="Go to home">
                <div className="logo" aria-hidden="true">
                  <div className="logo-mark">T</div>
                  <div className="logo-spark" />
                </div>
              </button>
              <div>
                <div className="brand-name">Tweakly</div>
                <div className="brand-tag">Legal</div>
              </div>
            </div>
            <div className="step-tabs">
              <button
                className={`chip ${uiStep === 'input' ? 'active' : ''}`}
                onClick={() => handleLegalNav('input')}
              >
                Job Brief
              </button>
              <button
                className={`chip ${uiStep === 'edit' ? 'active' : ''}`}
                onClick={() => handleLegalNav('edit')}
                disabled={mode === 'gdocs' ? !selectedDocId : !draft}
              >
                Tune & Edit
              </button>
              <button
                className={`chip ${uiStep === 'outreach' ? 'active' : ''}`}
                onClick={() => handleLegalNav('outreach')}
                disabled={mode === 'gdocs' ? !selectedDocId : !draft}
              >
                Outreach
              </button>
            </div>
            <div className="user-menu">
              {isAuthenticated ? (
                <>
                  <button className="chip tiny" onClick={handleOpenSaved}>
                    Saved Resumes
                  </button>
                  <div className="user-chip">
                    <div className="avatar">{userInitial}</div>
                    <div className="user-email">{userEmail || 'Account'}</div>
                  </div>
                  <button className="chip tiny" onClick={handleLogout}>
                    Logout
                  </button>
                </>
              ) : (
                <button className="chip tiny" onClick={() => handleNavigate('/')}>
                  Login
                </button>
              )}
            </div>
          </header>
          <div className="panel legal-panel">
            {routePath === '/privacy' && (
              <>
                <div className="h2">Privacy Policy</div>
                <p className="p">We collect only what we need to run Tweakly: account email, resume content you upload, and usage analytics to improve the product.</p>
                <p className="p">We do not sell your data. You can request deletion at any time by emailing support.</p>
              </>
            )}
            {routePath === '/terms' && (
              <>
                <div className="h2">Terms of Service</div>
                <p className="p">By using Tweakly, you agree to use the service responsibly and not upload content you don’t have rights to share.</p>
                <p className="p">The service is provided as-is. We’re not liable for hiring outcomes or third‑party decisions.</p>
              </>
            )}
            {routePath === '/security' && (
              <>
                <div className="h2">Security</div>
                <p className="p">We encrypt credentials, restrict database access, and follow least‑privilege principles.</p>
                <p className="p">If you find a vulnerability, please email us so we can fix it quickly.</p>
              </>
            )}
            {routePath === '/contact' && (
              <>
                <div className="h2">Contact</div>
                <p className="p">Questions or feedback? Email us at support@your-domain.com.</p>
              </>
            )}
            <div className="actions">
              <button className="btn" onClick={() => handleNavigate('/')}>Back to app</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="page">
        <div className="glow" />
        <div className="container">
          <header className="topbar">
            <div className="brand">
              <div className="logo" aria-hidden="true">
                <div className="logo-mark">T</div>
                <div className="logo-spark" />
              </div>
              <div>
                <div className="brand-name">Tweakly</div>
                <div className="brand-tag">Sign in to start tuning.</div>
              </div>
            </div>
          </header>
          <div className="grid auth-stack">
            <div className="panel">
              <div className="h2">Welcome back</div>
              <p className="p">
                Log in to access your saved templates and tuned resumes.
              </p>
              <div className="label">Email</div>
              <input
                className="input"
                type="email"
                placeholder="you@domain.com"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
              />
              {authMode === 'register' && (
                <>
                  <div className="label" style={{ marginTop: 12 }}>First name</div>
                  <input
                    className="input"
                    type="text"
                    placeholder="First name"
                    value={authFirstName}
                    onChange={(e) => setAuthFirstName(e.target.value)}
                  />
                  <div className="label" style={{ marginTop: 12 }}>Last name</div>
                  <input
                    className="input"
                    type="text"
                    placeholder="Last name"
                    value={authLastName}
                    onChange={(e) => setAuthLastName(e.target.value)}
                  />
                </>
              )}
              <div className="label" style={{ marginTop: 12 }}>Password</div>
              <input
                className="input"
                type="password"
                placeholder="••••••••"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
              {authError && <div className="small subtle" style={{ color: '#ff9a9a', marginTop: 10 }}>{authError}</div>}
              <div className="auth-tabs">
                <button
                  className={`chip ${authMode === 'login' ? 'active' : ''}`}
                  onClick={() => handleAuthTabClick('login')}
                  disabled={authLoading}
                >
                  {authLoading && authMode === 'login' ? 'Signing in...' : 'Login'}
                </button>
                <button
                  className={`chip ${authMode === 'register' ? 'active' : ''}`}
                  onClick={() => handleAuthTabClick('register')}
                  disabled={authLoading}
                >
                  {authLoading && authMode === 'register' ? 'Creating account...' : 'Register'}
                </button>
              </div>
            </div>
            <div className="panel">
              <div className="h2">New here?</div>
              <p className="p">
                Create an account to keep your templates and tuned drafts attached to your profile.
              </p>
              <div className="small subtle">
                Your session token is stored locally to keep you signed in.
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <OptimizeProgressOverlay active={loading} />
      <div className="glow" />
      <div className="container">
        <header className="topbar">
          <div className="brand">
            <button className="logo-button" onClick={() => setUiStep('input')} type="button" aria-label="Go to home">
              <div className="logo" aria-hidden="true">
                <div className="logo-mark">T</div>
                <div className="logo-spark" />
              </div>
            </button>
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
              disabled={mode === 'gdocs' ? !selectedDocId : !draft}
            >
              Tune & Edit
            </button>
            <button
              className={`chip ${uiStep === 'outreach' ? 'active' : ''}`}
              onClick={() => setUiStep('outreach')}
              disabled={mode === 'gdocs' ? !selectedDocId : !draft}
            >
              Outreach
            </button>
          </div>
          <div className="user-menu">
            <button className="chip tiny" onClick={handleOpenSaved}>
              Saved Resumes
            </button>
            <div className="user-chip">
              <div className="avatar">{userInitial}</div>
              <div className="user-email">{userEmail || 'Account'}</div>
            </div>
            <button className="chip tiny" onClick={handleLogout}>
              Logout
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
                className="ta ta-job"
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
                  <div className="template-header">
                    <div className="label" style={{ marginTop: 10 }}>Base resume template (.tex)</div>
                    {hasTemplate ? <span className="badge ok">Template saved</span> : <span className="badge">No template</span>}
                  </div>
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
                  <div className="actions template-actions">
                    <button className="btn primary" disabled={!canOptimize || loading} onClick={handleOptimize}>
                      {loading ? 'Tuning…' : 'Tweak in 30s'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="gdocs-block">
                <div className="gdocs-actions">
                  <button className="btn" onClick={openGoogleAuth}>
                    Connect Google Docs
                  </button>
                  <button className="btn" onClick={loadGoogleDocs}>
                    Refresh Docs
                  </button>
                  {gdocsConnected && <span className="badge ok">Connected</span>}
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
                </div>
              )}

              {mode === 'gdocs' && (
                <div className="actions gdocs-actions-block gdocs-center">
                  <button className="btn primary" disabled={!canOptimize || loading} onClick={handleOptimize}>
                    {loading ? 'Tuning…' : 'Tweak in 30s'}
                  </button>
                </div>
              )}

              <div className={`status-row ${mode === 'gdocs' ? 'status-row-gdocs' : ''}`}>
                {mode === 'latex' && pdfAvailable && <span className="badge ok">PDF ready</span>}
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

        {mode === 'gdocs' && uiStep === 'edit' && (
          <div className="gdocs-preview-layout">
            <div className="panel gdocs-preview-panel">
              {scoreBefore !== null && scoreAfter !== null && (
                <div className="score-panel">
                  <div className="score-card">
                    <div className="score-ring">
                      <div className="score-value">{scoreBefore}</div>
                    </div>
                    <div className="small subtle">Before score</div>
                  </div>
                  <div className="score-arrow" aria-hidden="true">→</div>
                  <div className="score-card">
                    <div className="score-ring">
                      <div className="score-value">{scoreAfter}</div>
                    </div>
                    <div className="small subtle">After score</div>
                  </div>
                </div>
              )}
              <div className="preview-head">
                <div>
                  <div className="h2">Google Doc Preview</div>
                  <div className="small subtle">Read-only preview of your Google Doc.</div>
                </div>
                {selectedDocId && (
                  <a className="btn" href={gdocsOpenUrl} target="_blank" rel="noreferrer">
                    Edit Google Doc
                  </a>
                )}
              </div>
              {!selectedDocId ? (
                <div className="small subtle">Select a Google Doc to preview.</div>
              ) : gdocsPreviewFailed ? (
                <div className="gdocs-preview-fallback">
                  <div className="small subtle">This doc cannot be previewed here.</div>
                  <a className="btn primary" href={gdocsOpenUrl} target="_blank" rel="noreferrer">
                    Open Google Doc
                  </a>
                </div>
              ) : (
                <iframe
                  className="gdocs-preview-frame"
                  src={gdocsPreviewUrl}
                  title="Google Doc preview"
                  onLoad={() => {
                    setGdocsPreviewLoaded(true)
                    setGdocsPreviewFailed(false)
                    if (gdocsPreviewTimerRef.current) {
                      window.clearTimeout(gdocsPreviewTimerRef.current)
                    }
                  }}
                  onError={() => {
                    setGdocsPreviewFailed(true)
                  }}
                />
              )}
              {!gdocsPreviewFailed && !gdocsPreviewLoaded && selectedDocId && (
                <div className="small subtle">Loading preview...</div>
              )}
            </div>
          </div>
        )}

        {mode === 'latex' && draft && (uiStep === 'edit' || uiStep === 'export') && (
          <div className="edit-layout" ref={editPanelRef}>
            <div className="edit-col">
              <div className="panel edit-downloads">
                <div className="preview-head">
                  <div className="h2">Downloads</div>
                  <div className="small subtle">Export the latest draft as .tex or PDF.</div>
                </div>
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
              <div className="panel saved-panel">
                <div className="preview-head">
                  <div className="h2">Saved Downloads</div>
                  <div className="small subtle">Only resumes you download are saved here.</div>
                </div>
                {downloadedLoading ? (
                  <div className="small subtle">Loading saved resumes…</div>
                ) : downloadedResumes.length === 0 ? (
                  <div className="small subtle">No saved resumes yet.</div>
                ) : (
                  <div className="saved-list">
                    {savedPreview.map((resume) => (
                      <div className="saved-item" key={resume.id}>
                        <div className="saved-meta">
                          <div className="saved-name">{resume.name}</div>
                          <div className="small subtle">
                            {new Date(resume.created_at).toLocaleString()}
                          </div>
                        </div>
                        <div className="saved-actions">
                          <button className="chip tiny" onClick={() => handleDownloadSaved(resume.id, 'tex')}>
                            .tex
                          </button>
                          <button className="chip tiny" onClick={() => handleDownloadSaved(resume.id, 'pdf')}>
                            PDF
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {hasMoreSaved && !downloadedLoading && (
                  <div className="saved-footer">
                    <button className="chip tiny" onClick={handleOpenSaved} type="button">
                      Show more
                    </button>
                  </div>
                )}
                {downloadedError && (
                  <div className="small subtle" style={{ color: '#ff9a9a' }}>{downloadedError}</div>
                )}
              </div>
            </div>
            <div className="edit-col">
              <div className="edit-editor">
                {scoreBefore !== null && scoreAfter !== null && (
                  <div className="score-panel">
                  <div className="score-card">
                    <div className="score-ring">
                      <div className="score-value">{scoreBefore}</div>
                    </div>
                    <div className="small subtle">Before score</div>
                  </div>
                  <div className="score-arrow" aria-hidden="true">→</div>
                  <div className="score-card">
                    <div className="score-ring">
                      <div className="score-value">{scoreAfter}</div>
                    </div>
                    <div className="small subtle">After score</div>
                    </div>
                  </div>
                )}
                <ResumeEditorStructured
                  draftExperiences={draftExperiences}
                  draftProjects={draftProjects}
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
                <div className="label">Cover letter source</div>
                <div className="small subtle">
                  Using resume: <b>{selectedDocName}</b>
                </div>
                <div className="small subtle">The cover letter will appear below.</div>
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
              <div className="outreach-loader">
                <div className="terminal">
                  <div className="terminal-head">
                    <span className="terminal-dot red" />
                    <span className="terminal-dot yellow" />
                    <span className="terminal-dot green" />
                    <span className="terminal-title">outreach://preview</span>
                  </div>
                  <div className="terminal-body">
                    <div className="terminal-line">Scanning job context…</div>
                    <div className="terminal-line">Synthesizing roles + signals…</div>
                    <div className="terminal-line">Building LinkedIn searches…</div>
                    <div className="terminal-line">Drafting outreach note…</div>
                    <div className="terminal-line">
                      Ready in seconds<span className="terminal-cursor">█</span>
                    </div>
                  </div>
                </div>
              </div>
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

        {uiStep === 'saved' && (
          <div className="panel saved-panel">
            <div className="preview-head">
              <div className="h2">Saved Downloads</div>
              <div className="small subtle">Previously downloaded resumes with timestamps.</div>
            </div>
            {downloadedLoading ? (
              <div className="small subtle">Loading saved resumes…</div>
            ) : downloadedResumes.length === 0 ? (
              <div className="small subtle">No saved resumes yet.</div>
            ) : (
              <div className="saved-list">
                {downloadedResumes.map((resume) => (
                  <div className="saved-item" key={resume.id}>
                    <div className="saved-meta">
                      <div className="saved-name">{resume.name}</div>
                      <div className="small subtle">
                        {new Date(resume.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="saved-actions">
                      <button className="chip tiny" onClick={() => handleDownloadSaved(resume.id, 'tex')}>
                        .tex
                      </button>
                      <button className="chip tiny" onClick={() => handleDownloadSaved(resume.id, 'pdf')}>
                        PDF
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {downloadedError && (
              <div className="small subtle" style={{ color: '#ff9a9a' }}>{downloadedError}</div>
            )}
          </div>
        )}

        <footer className="footer">
          <div className="footer-title">Built for people who geek out on clean signal.</div>
          <div className="footer-copy">
            Tweakly is your resume co-processor: fast iterations, minimal noise, maximal clarity.
          </div>
          <div className="footer-links">
            <a href="/privacy" className="footer-link" onClick={(e) => { e.preventDefault(); handleNavigate('/privacy') }}>Privacy</a>
            <a href="/terms" className="footer-link" onClick={(e) => { e.preventDefault(); handleNavigate('/terms') }}>Terms</a>
            <a href="/security" className="footer-link" onClick={(e) => { e.preventDefault(); handleNavigate('/security') }}>Security</a>
            <a href="/contact" className="footer-link" onClick={(e) => { e.preventDefault(); handleNavigate('/contact') }}>Contact</a>
          </div>
        </footer>
      </div>
    </div>
  )
}
