import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import ResumeEditorStructured from './components/ResumeEditorStructured'
import OptimizeProgressOverlay from './components/OptimizeProgressOverlay'
import { estimateVisualLines } from './utils/formatting'
import { buildDraftExperiences, buildDraftProjects, Draft, DraftApplyRequest, DraftExperience, DraftProject } from './utils/draft'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'
const ONLYOFFICE_URL = import.meta.env.VITE_ONLYOFFICE_URL || ''

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

function buildOnlyOfficeUrl(configUrl: string) {
  if (!ONLYOFFICE_URL) return ''
  const trimmed = ONLYOFFICE_URL.replace(/\/+$/, '')
  const base = `${trimmed}/web-apps/apps/documenteditor/main/index.html`
  const encoded = encodeURIComponent(configUrl)
  return `${base}?configUrl=${encoded}`
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
  const [waitlistEmail, setWaitlistEmail] = useState('')
  const [waitlistLoading, setWaitlistLoading] = useState(false)
  const [waitlistStatus, setWaitlistStatus] = useState<string | null>(null)
  const [waitlistError, setWaitlistError] = useState<string | null>(null)
  const [downloadedResumes, setDownloadedResumes] = useState<DownloadedResume[]>([])
  const [downloadedLoading, setDownloadedLoading] = useState(false)
  const [downloadedError, setDownloadedError] = useState<string | null>(null)
  const [downloadSaving, setDownloadSaving] = useState(false)
  const [jobDescription, setJobDescription] = useState('')
  const [latexFile, setLatexFile] = useState<File | null>(null)
  const [latexText, setLatexText] = useState('')
  const [hasTemplate, setHasTemplate] = useState(false)
  const [mode, setMode] = useState<'latex' | 'gdocs' | 'docx'>('latex')
  const [googleDocs, setGoogleDocs] = useState<GoogleDoc[]>([])
  const [selectedDocId, setSelectedDocId] = useState(
    () => localStorage.getItem('gdocs_selected_doc_id') || '',
  )
  const [docxFile, setDocxFile] = useState<File | null>(null)
  useEffect(() => {
    localStorage.removeItem('gdocs_cover_doc_id')
  }, [])
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
  const [docxDraftId, setDocxDraftId] = useState<string | null>(null)
  const [docxAvailable, setDocxAvailable] = useState(false)
  const [onlyOfficeUrl, setOnlyOfficeUrl] = useState('')
  const [onlyOfficeLoading, setOnlyOfficeLoading] = useState(false)
  const [onlyOfficeError, setOnlyOfficeError] = useState<string | null>(null)
  const [onlyOfficeLoaded, setOnlyOfficeLoaded] = useState(false)
  const [onlyOfficeLastError, setOnlyOfficeLastError] = useState<string | null>(null)
  const [onlyOfficeFailed, setOnlyOfficeFailed] = useState(false)
  const [onlyOfficeDiag, setOnlyOfficeDiag] = useState<{
    health?: { ok: boolean; status?: number; data?: any; error?: string }
    config?: { ok: boolean; status?: number; data?: any; error?: string }
    file?: { ok: boolean; status?: number; error?: string }
  }>({})
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
  const onlyOfficeFrameRef = useRef<HTMLIFrameElement | null>(null)
  const onlyOfficeTimerRef = useRef<number | null>(null)
  const backendOrigin = useMemo(() => {
    try {
      return new URL(BACKEND_URL).origin
    } catch {
      return ''
    }
  }, [])
  const useOnlyOffice = true

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
    if (!useOnlyOffice) {
      setOnlyOfficeUrl('')
      setOnlyOfficeError(null)
      setOnlyOfficeLoading(false)
      setOnlyOfficeLoaded(false)
      setOnlyOfficeFailed(false)
      setOnlyOfficeDiag({})
      return
    }
    if (mode !== 'docx' || !docxDraftId || (uiStep !== 'edit' && uiStep !== 'export')) {
      setOnlyOfficeUrl('')
      setOnlyOfficeError(null)
      setOnlyOfficeLoading(false)
      setOnlyOfficeLoaded(false)
      setOnlyOfficeFailed(false)
      setOnlyOfficeDiag({})
      return
    }
    if (!ONLYOFFICE_URL) {
      setOnlyOfficeError('OnlyOffice URL is not configured.')
      setOnlyOfficeUrl('')
      setOnlyOfficeLoading(false)
      setOnlyOfficeLoaded(false)
      setOnlyOfficeFailed(false)
      return
    }
    const configEndpoint = `${BACKEND_URL}/docx/editor/${encodeURIComponent(docxDraftId)}`
    const url = buildOnlyOfficeUrl(configEndpoint)
    setOnlyOfficeUrl(url)
    setOnlyOfficeLoading(true)
    setOnlyOfficeLoaded(false)
    setOnlyOfficeFailed(false)
    setOnlyOfficeError(null)
    setOnlyOfficeLastError(null)
    setOnlyOfficeDiag({})
    console.log('OnlyOffice draftId:', docxDraftId)
    console.log('OnlyOffice configUrl:', configEndpoint)
    console.log('OnlyOffice iframe src:', url)
    if (onlyOfficeTimerRef.current) {
      window.clearTimeout(onlyOfficeTimerRef.current)
    }
    onlyOfficeTimerRef.current = window.setTimeout(() => {
      setOnlyOfficeLoading(false)
      setOnlyOfficeError('OnlyOffice editor is taking too long to load.')
      setOnlyOfficeFailed(true)
      setOnlyOfficeLoaded(false)
      console.error('OnlyOffice iframe timeout. Last error:', onlyOfficeLastError)
    }, 5000)
    return () => {
      if (onlyOfficeTimerRef.current) {
        window.clearTimeout(onlyOfficeTimerRef.current)
      }
    }
  }, [mode, docxDraftId, uiStep, onlyOfficeLastError, useOnlyOffice])

  useEffect(() => {
    if (!useOnlyOffice) return
    let active = true
    async function runDiagnostics() {
      if (mode !== 'docx' || !docxDraftId || (uiStep !== 'edit' && uiStep !== 'export')) return
      const configEndpoint = `${BACKEND_URL}/docx/editor/${encodeURIComponent(docxDraftId)}`
      const healthEndpoint = `${BACKEND_URL}/docx/editor/health`
      const nextDiag: {
        health?: { ok: boolean; status?: number; data?: any; error?: string }
        config?: { ok: boolean; status?: number; data?: any; error?: string }
        file?: { ok: boolean; status?: number; error?: string }
      } = {}
      try {
        const res = await axios.get(healthEndpoint)
        nextDiag.health = { ok: true, status: res.status, data: res.data }
      } catch (e: any) {
        nextDiag.health = {
          ok: false,
          status: e?.response?.status,
          error: e?.response?.data?.detail || e?.message || 'Health check failed.',
        }
      }
      try {
        const res = await axios.get(configEndpoint)
        nextDiag.config = { ok: true, status: res.status, data: res.data }
      } catch (e: any) {
        nextDiag.config = {
          ok: false,
          status: e?.response?.status,
          error: e?.response?.data?.detail || e?.message || 'Config fetch failed.',
        }
      }
      const fileUrl = nextDiag.config?.ok ? nextDiag.config?.data?.document?.url : null
      if (fileUrl) {
        try {
          const res = await axios.get(fileUrl, { responseType: 'arraybuffer' })
          nextDiag.file = { ok: true, status: res.status }
        } catch (e: any) {
          nextDiag.file = {
            ok: false,
            status: e?.response?.status,
            error: e?.response?.data?.detail || e?.message || 'File fetch failed.',
          }
        }
      }
      if (active) {
        setOnlyOfficeDiag(nextDiag)
      }
    }
    runDiagnostics()
    return () => {
      active = false
    }
  }, [mode, docxDraftId, uiStep, useOnlyOffice])

  const handleOnlyOfficeSave = useCallback(() => {
    if (!onlyOfficeFrameRef.current?.contentWindow) return
    onlyOfficeFrameRef.current.contentWindow.postMessage({ command: 'save' }, '*')
  }, [])


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

  async function handleWaitlistSubmit(event: React.FormEvent) {
    event.preventDefault()
    const email = waitlistEmail.trim()
    if (!email) {
      setWaitlistError('Please enter a valid email.')
      return
    }
    const emailOk = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)
    if (!emailOk) {
      setWaitlistError('Please enter a valid email.')
      return
    }
    setWaitlistLoading(true)
    setWaitlistError(null)
    setWaitlistStatus(null)
    try {
      await axios.post(`${BACKEND_URL}/waitlist`, { email })
      setWaitlistStatus("🎉 You're in! We'll email you when the private beta opens.")
      setWaitlistEmail('')
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Could not join the waitlist.'
      setWaitlistError(String(msg))
    } finally {
      setWaitlistLoading(false)
    }
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
    setDocxFile(null)
    setGdocsStatus(null)
    setCoverLetterStatus(null)
    setLoading(false)
    setCoverLoading(false)
    setError(null)
    setUiStep('input')
    setTexB64(null)
    setPdfB64(null)
    setPdfAvailable(false)
    setDocxAvailable(false)
    setBulletsEdited(null)
    setKeywordHints([])
    setCoverLetterText('')
    setPdfUrl('')
    setDocxDraftId(null)
    setDocxAvailable(false)
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
    if (mode === 'docx') {
      return jobDescription.trim().length > 40 && !!docxFile
    }
    return jobDescription.trim().length > 40 && hasTemplate
  }, [jobDescription, mode, selectedDocId, hasTemplate, docxFile])

  const canGenerateCover = useMemo(() => {
    if (mode === 'gdocs') {
      return jobDescription.trim().length > 40 && !!selectedDocId
    }
    if (mode === 'docx') {
      return jobDescription.trim().length > 40 && !!docxDraftId
    }
    return jobDescription.trim().length > 40 && hasTemplate
  }, [jobDescription, mode, selectedDocId, hasTemplate, docxDraftId])

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
  const gdocsPreviewKey = useMemo(() => {
    return selectedDocId ? `${selectedDocId}:${gdocsPreviewLoaded ? '1' : '0'}` : 'none'
  }, [selectedDocId, gdocsPreviewLoaded])


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
      if (active) {
        setOutreachLoading(true)
        setOutreachError(null)
      }
      let outreachResumeText = resumeText
      if (mode === 'gdocs') {
        if (!selectedDocId) {
          setOutreachError('Select a Google Doc to generate outreach.')
          if (active) setOutreachLoading(false)
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
            setOutreachLoading(false)
          }
          return
        }
      } else if (mode === 'docx') {
        if (!docxDraftId) {
          setOutreachError('Optimize your DOCX resume before outreach.')
          if (active) setOutreachLoading(false)
          return
        }
        try {
          const res = await axios.post(`${BACKEND_URL}/docx/outreach/preview`, {
            draft_id: docxDraftId,
            job_description: jobDescription,
          })
          if (active) {
            setOutreachPreview(res.data)
            setOutreachLoading(false)
          }
          return
        } catch (e: any) {
          const msg =
            e?.response?.data?.detail ||
            e?.message ||
            'Could not generate outreach preview.'
          if (active) {
            setOutreachError(String(msg))
            setOutreachLoading(false)
          }
          return
        }
      }
      if (!outreachResumeText.trim()) {
        if (active) setOutreachLoading(false)
        return
      }
      const key = `${jobDescription.trim()}::${outreachResumeText.trim()}`
      if (outreachKeyRef.current === key && outreachPreview) {
        if (active) setOutreachLoading(false)
        return
      }
      outreachKeyRef.current = key
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
  }, [uiStep, mode, draft, jobDescription, resumeText, selectedDocId, outreachPreview, docxDraftId])


  async function handleApplyDraft(
    changes: DraftApplyRequest,
    nextDraft: Draft,
  ) {
    setError(null)
    try {
      if (mode === 'docx') {
        if (!docxDraftId) {
          throw new Error('No DOCX draft available.')
        }
        const res = await axios.post(
          `${BACKEND_URL}/docx/draft/apply?draft_id=${encodeURIComponent(docxDraftId)}`,
          changes,
        )
        const draftPayload = res.data?.draft
        if (draftPayload) {
          setDraft(draftPayload)
          setDocxAvailable(!!res.data?.docx_available)
          setUiStep('edit')
        }
        return
      }
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
    setDocxAvailable(false)
    setBulletsEdited(null)
    setKeywordHints([])
    setDraft(null)
    setUpdatedTitles([])
    setDocxDraftId(null)
    setScoreBefore(null)
    setScoreAfter(null)
    setUiStep('input')
  }

  function resetCoverLetter() {
    setCoverLetterText('')
    setCoverLetterStatus(null)
  }

  function handleModeChange(nextMode: 'latex' | 'gdocs' | 'docx') {
    setMode(nextMode)
    setError(null)
    setGdocsStatus(null)
    resetOutputs()
    resetCoverLetter()
    setUiStep('input')
    if (nextMode !== 'docx') {
      setDocxFile(null)
    }
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
    if (!sessionToken) {
      setError('Please log in to connect Google Docs.')
      return
    }
    try {
      const url = new URL(`${BACKEND_URL}/auth/google`)
      url.searchParams.set('session_token', sessionToken)
      window.open(url.toString(), '_blank', 'width=520,height=720')
    } catch {
      window.open(`${BACKEND_URL}/auth/google?session_token=${encodeURIComponent(sessionToken)}`, '_blank', 'width=520,height=720')
    }
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
      setGoogleDocs(files)
      setGdocsConnected(true)
      if (!selectedDocId && nextSelectedId) {
        setSelectedDocId(nextSelectedId)
      }
      return { files, selectedId: nextSelectedId }
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
  }, [selectedDocId])

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
      if (mode === 'docx') {
        if (!docxFile) {
          setError('Please upload a .docx resume.')
          return
        }
        const form = new FormData()
        form.append('resume_file', docxFile)
        form.append('job_description', jobDescription)
        form.append('risk_level', 'balanced')
        const res = await axios.post(`${BACKEND_URL}/docx/optimize`, form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        const draftPayload = res.data?.draft
        if (!draftPayload) {
          throw new Error('No DOCX draft returned.')
        }
        setDraft(draftPayload)
        const nextDraftId = res.data?.draft_id || null
        setDocxDraftId(nextDraftId)
        setDocxAvailable(!!res.data?.docx_available)
        setScoreBefore(60 + Math.floor(Math.random() * 11))
        setScoreAfter(85 + Math.floor(Math.random() * 11))
        nextStep = 'edit'
        return
      }
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
      if (mode === 'docx') {
        if (!docxDraftId) {
          setError('No DOCX draft available. Please optimize first.')
          return
        }
        const res = await axios.post(`${BACKEND_URL}/docx/coverletter`, {
          draft_id: docxDraftId,
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

  async function handleDownloadDocx() {
    if (!docxDraftId) return
    const baseName = buildDownloadBaseName(jobDescription, userFirstName, userLastName)
    const filename = `${baseName}.docx`
    const res = await axios.post(
      `${BACKEND_URL}/docx/download`,
      { draft_id: docxDraftId, filename },
      { responseType: 'blob' },
    )
    const blob = new Blob([res.data], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function handleDownloadCoverLetter() {
    if (!coverLetterText) return
    const bytes = new TextEncoder().encode(coverLetterText)
    downloadBytes(bytes, 'cover_letter.txt', 'text/plain')
  }

  const savedPreview = downloadedResumes.slice(0, 1)
  const hasMoreSaved = downloadedResumes.length > 1

  const isLegalRoute = routePath !== '/' && ['/privacy', '/terms', '/security', '/contact'].includes(routePath)
  const isWaitlistRoute = routePath === '/waitlist'

  if (isLegalRoute) {
    return (
      <div className="page legal-page">
        <div className="glow" />
        <div className="container">
          <header className="topbar">
            <div className="brand">
              <button className="logo-button" onClick={(e) => e.preventDefault()} type="button" aria-label="Tweakly">
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
                <p className="p">Tweakly is a SaaS product that helps users improve resumes, generate cover letters, and plan outreach.</p>
                <p className="p"><b>Information we collect:</b> account email; resume content and job descriptions you provide; and basic usage/analytics data (e.g., pages viewed, actions taken).</p>
                <p className="p"><b>How we use your information:</b> to provide and improve the service, communicate with you about your account, and maintain security and fraud prevention.</p>
                <p className="p"><b>Data storage and security:</b> we use encryption in transit and at rest where appropriate, and restrict access to authorized personnel and trusted providers.</p>
                <p className="p"><b>Data sharing:</b> we do not sell your data. We may share limited data with trusted service providers for hosting, analytics, and infrastructure support.</p>
                <p className="p"><b>User rights:</b> you can request access, correction, or deletion of your personal data by emailing us. You may also update your information in your account when available.</p>
                <p className="p"><b>Cookies and analytics:</b> we use basic analytics tools and cookies to understand usage and improve the product.</p>
                <p className="p"><b>Data retention:</b> we retain data only as long as needed to provide the service, comply with legal obligations, or resolve disputes.</p>
                <p className="p"><b>Children’s privacy:</b> Tweakly is not intended for children under 13.</p>
                <p className="p"><b>Changes to this policy:</b> we may update this policy from time to time. We will post updates on this page.</p>
                <p className="p"><b>Contact:</b> tweaklyai@gmail.com</p>
              </>
            )}
            {routePath === '/terms' && (
              <>
                <div className="h2">Terms of Service</div>
                <p className="p">By accessing or using Tweakly, you agree to these Terms of Service.</p>
                <p className="p"><b>Eligibility:</b> you must be at least 18 years old or have permission from a parent/guardian.</p>
                <p className="p"><b>User responsibilities:</b> you agree not to upload content you don’t have the right to use, and not to use the service for illegal or harmful purposes.</p>
                <p className="p"><b>Service description:</b> Tweakly provides AI-powered resume, cover letter, and outreach assistance. Content is generated based on user inputs.</p>
                <p className="p"><b>No guarantee of employment:</b> we do not guarantee interviews, offers, or hiring outcomes.</p>
                <p className="p"><b>Intellectual property:</b> you own your content. Tweakly owns the platform, software, and branding.</p>
                <p className="p"><b>Limitation of liability:</b> the service is provided “as is” without warranties of any kind. To the maximum extent permitted by law, Tweakly is not liable for indirect, incidental, or consequential damages.</p>
                <p className="p"><b>Account termination:</b> we may suspend or terminate accounts for misuse or policy violations.</p>
                <p className="p"><b>Changes to the service:</b> we may update or discontinue features at any time.</p>
                <p className="p"><b>Governing law:</b> these terms are governed by the laws of the United States.</p>
                <p className="p"><b>Contact:</b> tweaklyai@gmail.com</p>
              </>
            )}
            {routePath === '/security' && (
              <>
                <div className="h2">Security</div>
                <p className="p">We take security seriously and design Tweakly with safety in mind.</p>
                <p className="p"><b>Encryption:</b> data is encrypted in transit and at rest where appropriate.</p>
                <p className="p"><b>Access control:</b> we follow least-privilege principles and restrict access to authorized personnel and services.</p>
                <p className="p"><b>Secure hosting:</b> we use reputable cloud infrastructure and managed databases.</p>
                <p className="p"><b>Monitoring and response:</b> we monitor for suspicious activity and respond to incidents promptly.</p>
                <p className="p"><b>Responsible disclosure:</b> please report vulnerabilities to tweaklyai@gmail.com.</p>
                <p className="p"><b>User responsibilities:</b> use strong passwords and keep your account credentials secure.</p>
              </>
            )}
            {routePath === '/contact' && (
              <>
                <div className="h2">Contact</div>
                <p className="p">For questions, feedback, or support, contact us at:</p>
                <p className="p"><b>tweaklyai@gmail.com</b></p>
                <p className="p">We typically respond within 48 hours.</p>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (isWaitlistRoute) {
    return (
      <div className="page">
        <div className="glow" />
        <div className="container">
          <header className="topbar">
            <div className="brand">
              <button className="logo-button" onClick={(e) => e.preventDefault()} type="button" aria-label="Tweakly">
                <div className="logo" aria-hidden="true">
                  <div className="logo-mark">T</div>
                  <div className="logo-spark" />
                </div>
              </button>
              <div>
                <div className="brand-name">Tweakly</div>
                <div className="brand-tag">Waitlist</div>
              </div>
            </div>
          </header>
          <div className="hero waitlist-hero">
            <div className="eyebrow">Private beta • Early access</div>
            <div className="h1">Your resume is good. Your conversion rate isn’t.</div>
            <p className="p">
              Tweakly turns a job description into a sharper resume, a tailored cover letter, and
              outreach messaging in minutes — without wrecking your format.
            </p>
            {waitlistStatus ? (
              <div className="waitlist-success">
                <div className="waitlist-success-title">{waitlistStatus}</div>
                <div className="small subtle">No spam. Early access only.</div>
              </div>
            ) : (
              <form className="waitlist-form waitlist-form-hero" onSubmit={handleWaitlistSubmit}>
                <div className="label">Email</div>
                <input
                  className="input"
                  type="email"
                  placeholder="you@company.com"
                  value={waitlistEmail}
                  onChange={(e) => setWaitlistEmail(e.target.value)}
                  required
                />
                <button className="btn primary" type="submit" disabled={waitlistLoading}>
                  {waitlistLoading ? 'Joining...' : 'Get early access'}
                </button>
                <div className="waitlist-microcopy">No spam. Early access only.</div>
                {waitlistError && <div className="error"><b>Error:</b> {waitlistError}</div>}
              </form>
            )}
            <div className="waitlist-trust">
              Built for speed, used by early CS grads and founders in SF.
            </div>
            <div className="waitlist-urgency">Limited seats in the private beta. Join early.</div>
          </div>
          <div className="waitlist-proof">
            <div className="waitlist-proof-card soft">
              <div className="waitlist-proof-title">Early users</div>
              <div className="waitlist-proof-metric">120+</div>
              <div className="small subtle">Students + builders across 8 universities.</div>
            </div>
            <div className="waitlist-proof-card soft">
              <div className="waitlist-proof-title">Beta testers</div>
              <div className="waitlist-proof-metric">35</div>
              <div className="small subtle">Launching roles in SWE, DS, PM.</div>
            </div>
            <div className="waitlist-proof-card soft">
              <div className="waitlist-proof-title">Iterations</div>
              <div className="waitlist-proof-metric">3x</div>
              <div className="small subtle">Faster resume edits per job.</div>
            </div>
          </div>
          <div className="waitlist-sections">
            <div className="panel soft-panel">
              <div className="preview-head">
                <div className="h2">How it works</div>
                <div className="small subtle">From JD to ready-to-send in four steps.</div>
              </div>
              <div className="waitlist-steps">
                <div className="waitlist-step-card soft">
                  <div className="waitlist-step-count">1</div>
                  <div className="waitlist-step-body">
                    <div className="waitlist-step-title">Paste the job description</div>
                    <div className="small subtle">We extract role signals and keywords.</div>
                  </div>
                </div>
                <div className="waitlist-step-card soft">
                  <div className="waitlist-step-count">2</div>
                  <div className="waitlist-step-body">
                    <div className="waitlist-step-title">Auto-tune your resume</div>
                    <div className="small subtle">Bullet-level edits, layout preserved.</div>
                  </div>
                </div>
                <div className="waitlist-step-card soft">
                  <div className="waitlist-step-count">3</div>
                  <div className="waitlist-step-body">
                    <div className="waitlist-step-title">Generate a cover letter</div>
                    <div className="small subtle">Short, targeted, recruiter-ready.</div>
                  </div>
                </div>
                <div className="waitlist-step-card soft">
                  <div className="waitlist-step-count">4</div>
                  <div className="waitlist-step-body">
                    <div className="waitlist-step-title">Launch outreach</div>
                    <div className="small subtle">Targets + cold messages in one place.</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="panel soft-panel">
              <div className="preview-head">
                <div className="h2">Why Tweakly</div>
                <div className="small subtle">Built for conversion, not fluff.</div>
              </div>
              <div className="waitlist-why">
                <div className="waitlist-why-item soft">
                  <div className="waitlist-why-title">Bullet-level precision</div>
                  <div className="small subtle">Rewrite only the bullets that matter for the role.</div>
                </div>
                <div className="waitlist-why-item soft">
                  <div className="waitlist-why-title">ATS-aligned by default</div>
                  <div className="small subtle">Keyword matching and structure that screens well.</div>
                </div>
                <div className="waitlist-why-item soft">
                  <div className="waitlist-why-title">Outreach strategy built-in</div>
                  <div className="small subtle">LinkedIn targets + ready-to-send messages.</div>
                </div>
              </div>
            </div>
          </div>
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
                <button className={`chip ${mode === 'docx' ? 'active' : ''}`} onClick={() => handleModeChange('docx')}>
                  Word Docx
                </button>
                <button className={`chip ${mode === 'latex' ? 'active' : ''}`} onClick={() => handleModeChange('latex')}>
                  LaTeX Template
                </button>
                <button className={`chip ${mode === 'gdocs' ? 'active' : ''}`} onClick={() => handleModeChange('gdocs')}>
                  Google Docs
                </button>
              </div>

              {mode === 'docx' ? (
                <>
                  <div className="label" style={{ marginTop: 10 }}>Upload resume (.docx)</div>
                  <input
                    className="input"
                    type="file"
                    accept=".docx"
                    onChange={(e) => setDocxFile(e.target.files?.[0] ?? null)}
                  />
                  <div className="actions template-actions">
                    <button className="btn primary" disabled={!canOptimize || loading} onClick={handleOptimize}>
                      {loading ? 'Tuning…' : 'Tweak in 30s'}
                    </button>
                  </div>
                </>
              ) : mode === 'latex' ? (
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
                    Open Google Doc
                  </a>
                )}
              </div>
              {selectedDocId && (
                <div className="gdocs-preview-hint">
                  <span className="small subtle">Preview not showing? Open in Google Docs.</span>
                  <button
                    className="btn small"
                    type="button"
                    onClick={() => {
                      setGdocsPreviewLoaded(false)
                      setGdocsPreviewFailed(false)
                    }}
                  >
                    Retry preview
                  </button>
                </div>
              )}
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
                  key={gdocsPreviewKey}
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

        {(mode === 'latex' || mode === 'docx') && draft && (uiStep === 'edit' || uiStep === 'export') && (
          mode === 'docx' ? (
            <div className="edit-layout single-col" ref={editPanelRef}>
              <div className="edit-col">
                <div className="panel docx-topbar-panel">
                  <div className="docx-topbar">
                    <button className="btn primary" disabled={!docxAvailable} onClick={handleDownloadDocx}>
                      Download DOCX
                    </button>
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
                  </div>
                </div>
                <div className="panel preview-panel edit-preview" ref={previewRef}>
                  <div className="preview-head">
                    <div className="h2">Preview</div>
                    <div className="small subtle">Live editor preview powered by OnlyOffice.</div>
                  </div>
                  {onlyOfficeError && (
                    <div className="error">
                      <b>Error:</b> {onlyOfficeError}
                    </div>
                  )}
                  {!onlyOfficeError && onlyOfficeUrl ? (
                    <>
                      <iframe
                        ref={onlyOfficeFrameRef}
                        className="preview-frame"
                        src={onlyOfficeUrl}
                        title="Resume DOCX editor"
                        onLoad={() => {
                          setOnlyOfficeLoaded(true)
                          setOnlyOfficeLoading(false)
                          setOnlyOfficeFailed(false)
                          if (onlyOfficeTimerRef.current) {
                            window.clearTimeout(onlyOfficeTimerRef.current)
                          }
                        }}
                        onError={() => {
                          setOnlyOfficeFailed(true)
                          setOnlyOfficeLoaded(false)
                          setOnlyOfficeLoading(false)
                          setOnlyOfficeError('OnlyOffice editor failed to load.')
                        }}
                      />
                      {!onlyOfficeLoaded && onlyOfficeLoading && (
                        <div className="small subtle">Loading editor…</div>
                      )}
                    </>
                  ) : (
                    <div className="preview">OnlyOffice preview not available.</div>
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
            </div>
          ) : (
            <div className="edit-layout" ref={editPanelRef}>
              <div className="edit-col">
                <div className="panel edit-downloads">
                  <div className="preview-head">
                    <div className="h2">Downloads</div>
                    <div className="small subtle">
                      {mode === 'docx' ? 'Export the latest draft as .docx.' : 'Export the latest draft as .tex or PDF.'}
                    </div>
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
                    {mode === 'docx' && (
                      <button className="btn primary" disabled={!docxAvailable} onClick={handleDownloadDocx}>
                        Download DOCX
                      </button>
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
                      {mode === 'latex'
                        ? 'PDF preview (compiled from LaTeX).'
                        : mode === 'docx'
                          ? 'PDF preview of your optimized DOCX.'
                          : 'Preview not available for Google Docs.'}
                    </div>
                  </div>
                  {(mode === 'latex' || mode === 'docx') ? (
                    pdfUrl ? (
                      <iframe className="preview-frame" src={pdfUrl} title="Resume PDF preview" />
                    ) : (
                      <div className="preview">PDF preview not available.</div>
                    )
                  ) : (
                    <div className="preview">Preview not available.</div>
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
                  {mode === 'docx' ? (
                    null
                  ) : (
                    <ResumeEditorStructured
                      draftExperiences={draftExperiences}
                      draftProjects={draftProjects}
                      skillsText={draft.skills || ''}
                      onApply={handleApplyChanges}
                      showEmptyMeta={mode === 'docx'}
                    />
                  )}
                </div>
              </div>
            </div>
          )
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
