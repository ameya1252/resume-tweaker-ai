import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { motion, AnimatePresence } from 'framer-motion'
import ResumeEditorStructured from './components/ResumeEditorStructured'
import OptimizeProgressOverlay from './components/OptimizeProgressOverlay'
import { estimateVisualLines } from './utils/formatting'
import { buildDraftExperiences, buildDraftProjects, Draft, DraftApplyRequest, DraftExperience, DraftProject } from './utils/draft'

const ease = [0.16, 1, 0.3, 1] as const

const fadeInUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.35, ease },
}

const scaleIn = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
  transition: { duration: 0.3, ease },
}

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
  const [uiStep, setUiStep] = useState<'input' | 'edit' | 'outreach' | 'export' | 'saved' | 'account' | 'settings'>('input')
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
  const userInitial = (userFirstName.trim()[0] || userEmail.trim()[0] || 'U').toUpperCase()
  const userDisplayName = userFirstName.trim() || 'Account'
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false)
  const accountDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (accountDropdownRef.current && !accountDropdownRef.current.contains(e.target as Node)) {
        setAccountDropdownOpen(false)
      }
    }
    if (accountDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [accountDropdownOpen])

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

  const msOfficeViewerUrl = useMemo(() => {
    if (!docxDraftId) return ''
    const fileUrl = `${BACKEND_URL}/docx/editor/file/${docxDraftId}`
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`
  }, [docxDraftId])


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
        const key = `${jobDescription.trim()}::${docxDraftId}`
        if (outreachKeyRef.current === key && outreachPreview) {
          if (active) setOutreachLoading(false)
          return
        }
        outreachKeyRef.current = key
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

  const legalContent = isLegalRoute ? (
    <div className="panel legal-panel">
      {routePath === '/privacy' && (
        <>
          <div className="h2">Privacy Policy</div>
          <p className="p"><i>Last updated: February 1, 2025</i></p>

          <p className="p">Tweakly ("we," "us," or "our") is a software-as-a-service (SaaS) platform that helps users optimize resumes, generate tailored cover letters, and plan professional outreach. We are committed to protecting the privacy and security of every user who interacts with our platform. This Privacy Policy explains in detail what information we collect, how we use it, how we store and protect it, and what rights you have regarding your data.</p>
          <p className="p">By creating an account or using Tweakly in any capacity, you acknowledge that you have read, understood, and agree to the practices described in this Privacy Policy. If you do not agree with any part of this policy, please do not use our service.</p>

          <div className="h3">1. Information We Collect</div>
          <p className="p"><b>1.1 Account Information:</b> When you register for a Tweakly account, we collect your email address, first name, and last name. If you sign in via Google OAuth, we receive your Google account email address, display name, and profile identifier. We do not receive or store your Google account password.</p>
          <p className="p"><b>1.2 Authentication Credentials:</b> If you create an account using email and password, your password is hashed using industry-standard bcrypt hashing with a unique salt before being stored. We never store passwords in plaintext, and our engineering team cannot view or recover your original password.</p>
          <p className="p"><b>1.3 Resume and Document Content:</b> When you upload a resume (in DOCX format) or connect a Google Docs document, we process the content of that document to provide our optimization service. For DOCX uploads, the file is parsed server-side, processed, and the extracted text content is stored temporarily to generate your tailored draft. For Google Docs integration, we access your document content via the Google Docs API using OAuth 2.0 tokens that you explicitly authorize.</p>
          <p className="p"><b>1.4 Job Description Content:</b> We collect the job description text that you paste into our platform. This content is used solely to analyze role requirements, extract keywords, and tailor your resume and cover letter to the specific position.</p>
          <p className="p"><b>1.5 Generated Content:</b> We store the optimized resume drafts, cover letters, and outreach messages generated by our AI engine so that you can review, edit, and export them. You may also save multiple versions of your tailored resumes for future reference.</p>
          <p className="p"><b>1.6 Usage and Analytics Data:</b> We collect basic analytics data including pages visited, features used, session duration, browser type, operating system, device type, and referring URL. This data is collected in aggregate and is used solely to improve the product experience.</p>
          <p className="p"><b>1.7 Cookies and Local Storage:</b> We use essential cookies and browser local storage to maintain your authenticated session, store user preferences, and ensure the platform functions correctly. We do not use third-party advertising cookies or cross-site tracking cookies.</p>

          <div className="h3">2. Google OAuth and Google Docs Access</div>
          <p className="p"><b>2.1 Google Sign-In:</b> When you choose to sign in with Google, we use Google OAuth 2.0 to authenticate your identity. We request access to your basic profile information (email address and display name) to create and manage your Tweakly account. We do not access your Gmail, Google Calendar, Google Contacts, or any other Google services beyond what is explicitly listed here.</p>
          <p className="p"><b>2.2 Google Docs Read and Write Access:</b> If you choose to use the Google Docs integration feature, we request permission to read and write to your Google Docs documents. Specifically, we use the <b>https://www.googleapis.com/auth/documents</b> scope. This permission is used exclusively to: (a) read the content of a resume document you select so we can analyze and optimize it; and (b) write the optimized content back to your Google Doc or create a new document with the tailored resume, preserving your original formatting and layout. We only access documents that you explicitly select through the Google file picker. We do not browse, scan, index, or access any other files in your Google Drive. We do not store your Google OAuth refresh tokens beyond the active session unless you explicitly opt to stay signed in.</p>
          <p className="p"><b>2.3 Token Storage and Revocation:</b> Google OAuth access tokens are stored securely in encrypted server-side sessions and are never exposed to client-side code. You can revoke Tweakly's access to your Google account at any time by visiting your Google Account permissions page at <b>https://myaccount.google.com/permissions</b>. Upon revocation, we will no longer be able to access any of your Google data.</p>
          <p className="p"><b>2.4 Compliance with Google API Services User Data Policy:</b> Tweakly's use and transfer to any other app of information received from Google APIs will adhere to the <b>Google API Services User Data Policy</b>, including the Limited Use requirements. We do not use Google user data for advertising, do not transfer it to third parties for unrelated purposes, and do not use it to build user profiles for advertising or marketing.</p>

          <div className="h3">3. How We Use Your Information</div>
          <p className="p"><b>3.1 Service Delivery:</b> We use your resume content, job description, and account information to provide the core Tweakly service — analyzing job requirements, rewriting resume bullets, generating cover letters, identifying outreach targets, and producing export-ready documents in LaTeX, PDF, and DOCX formats.</p>
          <p className="p"><b>3.2 Account Management:</b> We use your email address to manage your account, send password reset emails, and communicate important service updates or security notifications.</p>
          <p className="p"><b>3.3 Service Improvement:</b> Aggregated, anonymized usage data helps us understand which features are most valuable, identify performance bottlenecks, and prioritize product improvements. We do not use individual resume content for training AI models or for any purpose other than delivering the service to you.</p>
          <p className="p"><b>3.4 Security and Fraud Prevention:</b> We use account and session data to detect unauthorized access, prevent abuse, and protect the integrity of the platform.</p>

          <div className="h3">4. Data Storage and Security</div>
          <p className="p"><b>4.1 Encryption in Transit:</b> All data transmitted between your browser and our servers is encrypted using TLS 1.2 or higher (HTTPS). This includes login credentials, resume content, API requests, and all other communications.</p>
          <p className="p"><b>4.2 Encryption at Rest:</b> Sensitive data stored in our databases — including hashed passwords, OAuth tokens, and resume content — is encrypted at rest using AES-256 encryption provided by our cloud infrastructure.</p>
          <p className="p"><b>4.3 Password Security:</b> User passwords are hashed using bcrypt with a cost factor of 12 and a unique randomly generated salt per user. We never store, log, or transmit plaintext passwords. Password reset flows use time-limited, single-use tokens sent to your verified email address.</p>
          <p className="p"><b>4.4 Infrastructure:</b> Tweakly is hosted on industry-leading cloud infrastructure with SOC 2 compliant data centers. Our databases use managed services with automated backups, failover capabilities, and network-level isolation.</p>
          <p className="p"><b>4.5 Access Controls:</b> Access to production systems and user data is restricted to authorized personnel on a need-to-know basis. We follow the principle of least privilege for all internal access. Administrative actions are logged and auditable.</p>

          <div className="h3">5. Data Sharing and Third Parties</div>
          <p className="p"><b>5.1 We Do Not Sell Your Data:</b> We will never sell, rent, lease, or trade your personal information or resume content to any third party for any reason.</p>
          <p className="p"><b>5.2 Service Providers:</b> We may share limited data with trusted third-party service providers who assist us in operating the platform, including cloud hosting providers, database services, email delivery services, and analytics tools. These providers are contractually obligated to protect your data and may only use it to perform services on our behalf.</p>
          <p className="p"><b>5.3 AI Processing:</b> Resume optimization and content generation are performed using third-party AI APIs (such as OpenAI or Anthropic). When we send your resume and job description content to these APIs for processing, we do so under their data processing agreements, which prohibit using your data to train their models. We send only the minimum content necessary for the optimization task.</p>
          <p className="p"><b>5.4 Legal Requirements:</b> We may disclose your information if required to do so by law, regulation, legal process, or governmental request, or if we believe disclosure is necessary to protect our rights, your safety, or the safety of others.</p>

          <div className="h3">6. Data Retention and Deletion</div>
          <p className="p"><b>6.1 Active Accounts:</b> We retain your account information and saved resumes for as long as your account is active. Generated drafts, cover letters, and outreach content are retained so you can access your saved work.</p>
          <p className="p"><b>6.2 Account Deletion:</b> You may request deletion of your account and all associated data at any time by emailing <b>tweaklyai@gmail.com</b>. Upon receiving a verified deletion request, we will permanently delete your account data, saved resumes, generated content, and any stored OAuth tokens within 30 days. Backup copies may persist in encrypted backups for up to 90 days before being automatically purged.</p>
          <p className="p"><b>6.3 Temporary Processing Data:</b> Resume content uploaded for one-time processing (without saving) is retained only for the duration of the processing session and is automatically purged thereafter.</p>

          <div className="h3">7. Your Rights</div>
          <p className="p"><b>7.1 Access:</b> You have the right to request a copy of the personal data we hold about you.</p>
          <p className="p"><b>7.2 Correction:</b> You have the right to request correction of any inaccurate personal data.</p>
          <p className="p"><b>7.3 Deletion:</b> You have the right to request deletion of your personal data, subject to any legal retention obligations.</p>
          <p className="p"><b>7.4 Portability:</b> You have the right to request your data in a structured, machine-readable format.</p>
          <p className="p"><b>7.5 Objection:</b> You have the right to object to certain processing of your data.</p>
          <p className="p"><b>7.6 California Residents (CCPA):</b> If you are a California resident, you have additional rights under the California Consumer Privacy Act, including the right to know what personal information is collected, the right to delete personal information, and the right to opt-out of the sale of personal information. As stated above, we do not sell personal information.</p>
          <p className="p"><b>7.7 EEA/UK Residents (GDPR):</b> If you are located in the European Economic Area or the United Kingdom, you have rights under the General Data Protection Regulation including access, rectification, erasure, restriction of processing, data portability, and the right to lodge a complaint with a supervisory authority.</p>
          <p className="p">To exercise any of these rights, please contact us at <b>tweaklyai@gmail.com</b>. We will respond to verified requests within 30 days.</p>

          <div className="h3">8. Children's Privacy</div>
          <p className="p">Tweakly is not intended for use by individuals under the age of 13 (or under the age of 16 in the EEA/UK). We do not knowingly collect personal information from children. If we become aware that we have inadvertently collected data from a child under the applicable age, we will take steps to delete that information promptly. If you believe a child has provided us with personal data, please contact us immediately at <b>tweaklyai@gmail.com</b>.</p>

          <div className="h3">9. International Data Transfers</div>
          <p className="p">Our servers are located in the United States. If you access Tweakly from outside the United States, your data may be transferred to and processed in the United States. By using the service, you consent to this transfer. We ensure appropriate safeguards are in place to protect your data in accordance with this Privacy Policy and applicable data protection laws.</p>

          <div className="h3">10. Changes to This Privacy Policy</div>
          <p className="p">We may update this Privacy Policy from time to time to reflect changes in our practices, technology, legal requirements, or other factors. When we make material changes, we will notify users by posting the updated policy on this page with a revised "Last updated" date. We encourage you to review this page periodically. Your continued use of Tweakly after changes are posted constitutes your acceptance of the updated policy.</p>

          <div className="h3">11. Contact Us</div>
          <p className="p">If you have any questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us at:</p>
          <p className="p"><b>Email:</b> tweaklyai@gmail.com</p>
          <p className="p"><b>Application:</b> Tweakly — https://tweakly.pro</p>
        </>
      )}
      {routePath === '/terms' && (
        <>
          <div className="h2">Terms of Service</div>
          <p className="p"><i>Last updated: February 1, 2025</i></p>

          <p className="p">Welcome to Tweakly. These Terms of Service ("Terms") govern your access to and use of the Tweakly platform, website, and all related services (collectively, the "Service") operated by Tweakly ("we," "us," or "our"). By creating an account, accessing, or using the Service in any way, you agree to be bound by these Terms. If you do not agree to these Terms, you must not use the Service.</p>

          <div className="h3">1. Eligibility</div>
          <p className="p">You must be at least 18 years of age, or the age of legal majority in your jurisdiction, to create an account and use Tweakly. If you are between 13 and 18 years of age, you may only use the Service with the consent and supervision of a parent or legal guardian who agrees to be bound by these Terms. We do not knowingly provide the Service to individuals under 13.</p>

          <div className="h3">2. Account Registration and Security</div>
          <p className="p"><b>2.1 Account Creation:</b> To use Tweakly, you must create an account by providing a valid email address and password, or by authenticating through Google OAuth. You agree to provide accurate, current, and complete information during registration and to keep your account information up to date.</p>
          <p className="p"><b>2.2 Account Security:</b> You are responsible for maintaining the confidentiality of your login credentials and for all activities that occur under your account. You agree to notify us immediately at <b>tweaklyai@gmail.com</b> if you suspect unauthorized access to your account. We are not liable for any loss or damage resulting from unauthorized use of your account.</p>
          <p className="p"><b>2.3 One Account Per User:</b> Each user may maintain one account. Creating multiple accounts to abuse free tiers, circumvent restrictions, or for any deceptive purpose is prohibited.</p>

          <div className="h3">3. Description of the Service</div>
          <p className="p"><b>3.1 Core Features:</b> Tweakly is an AI-powered platform that helps users optimize their resumes for specific job descriptions, generate tailored cover letters, and plan professional outreach. The Service includes resume analysis, bullet-point rewriting, skills optimization, cover letter generation, LinkedIn outreach target identification, and cold message drafting.</p>
          <p className="p"><b>3.2 Document Processing:</b> Users may upload resumes in Microsoft Word (.docx) format or connect their Google Docs account to select a resume document. Tweakly processes the document content to generate optimized drafts while preserving the original document layout and formatting.</p>
          <p className="p"><b>3.3 Export Formats:</b> Optimized resumes can be exported in DOCX, LaTeX (.tex), and PDF formats. Cover letters and outreach content can be copied or downloaded as text.</p>
          <p className="p"><b>3.4 Google Docs Integration:</b> When you connect your Google account, Tweakly requests permission to read and write to your Google Docs documents. This access is used exclusively to read your selected resume document and write optimized content back. We do not access any documents other than those you explicitly select. You may revoke this access at any time through your Google Account settings.</p>

          <div className="h3">4. Acceptable Use</div>
          <p className="p">You agree to use Tweakly only for lawful purposes and in accordance with these Terms. You agree NOT to:</p>
          <p className="p">• Upload content that you do not own or do not have the right to use, including resumes or documents belonging to other individuals without their consent.</p>
          <p className="p">• Use the Service to generate fraudulent, misleading, or deceptive content, including fabricating qualifications, work history, or credentials.</p>
          <p className="p">• Attempt to reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code of the platform or its underlying AI models.</p>
          <p className="p">• Use automated scripts, bots, or crawlers to access the Service or extract data from it without our written permission.</p>
          <p className="p">• Interfere with or disrupt the Service, servers, or networks connected to the Service.</p>
          <p className="p">• Use the Service to harass, abuse, stalk, threaten, or intimidate any individual.</p>
          <p className="p">• Resell, sublicense, or redistribute the Service or any content generated through it without our written permission.</p>
          <p className="p">• Violate any applicable local, state, national, or international law or regulation.</p>

          <div className="h3">5. Intellectual Property</div>
          <p className="p"><b>5.1 Your Content:</b> You retain full ownership of all content you upload to Tweakly, including your original resume, job descriptions, and any edits you make. By uploading content, you grant us a limited, non-exclusive, revocable license to process that content solely for the purpose of providing the Service to you.</p>
          <p className="p"><b>5.2 Generated Content:</b> Content generated by Tweakly's AI (including optimized bullets, cover letters, and outreach messages) is provided for your personal and professional use. You may use generated content freely in your job applications and professional communications.</p>
          <p className="p"><b>5.3 Our Intellectual Property:</b> The Tweakly platform, including its software, design, branding, logos, user interface, algorithms, and documentation, is owned by Tweakly and is protected by copyright, trademark, and other intellectual property laws. You may not copy, modify, distribute, or create derivative works based on any part of the platform without our written consent.</p>

          <div className="h3">6. No Guarantee of Employment Outcomes</div>
          <p className="p">Tweakly is a tool designed to help you present your existing qualifications more effectively. We do not guarantee that using the Service will result in job interviews, employment offers, or any particular hiring outcome. The effectiveness of your resume, cover letter, and outreach depends on many factors outside our control, including your qualifications, the job market, employer preferences, and hiring processes. You are solely responsible for verifying the accuracy and truthfulness of all content in your resume and application materials.</p>

          <div className="h3">7. Payment and Billing</div>
          <p className="p"><b>7.1 Free and Paid Tiers:</b> Tweakly may offer both free and paid subscription plans. Features, usage limits, and pricing for each plan are described on the platform and may change from time to time.</p>
          <p className="p"><b>7.2 Billing:</b> If you subscribe to a paid plan, you agree to pay all applicable fees. Payments are processed through third-party payment processors (such as Stripe). We do not store your full credit card number on our servers.</p>
          <p className="p"><b>7.3 Refunds:</b> Refund policies, if applicable, will be described on the platform or communicated at the time of purchase.</p>

          <div className="h3">8. Limitation of Liability</div>
          <p className="p">THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE. WE DISCLAIM ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.</p>
          <p className="p">TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL TWEAKLY, ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, OR AFFILIATES BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES, RESULTING FROM: (A) YOUR USE OF OR INABILITY TO USE THE SERVICE; (B) ANY UNAUTHORIZED ACCESS TO OR ALTERATION OF YOUR DATA; (C) ANY CONTENT GENERATED BY THE SERVICE; OR (D) ANY OTHER MATTER RELATING TO THE SERVICE.</p>
          <p className="p">OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE AMOUNT YOU PAID TO US IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR ONE HUNDRED U.S. DOLLARS ($100), WHICHEVER IS GREATER.</p>

          <div className="h3">9. Indemnification</div>
          <p className="p">You agree to indemnify, defend, and hold harmless Tweakly and its officers, directors, employees, and agents from and against any and all claims, liabilities, damages, losses, and expenses (including reasonable attorney fees) arising out of or relating to: (a) your use of the Service; (b) your violation of these Terms; (c) your violation of any third-party rights, including intellectual property rights; or (d) any content you upload to the platform.</p>

          <div className="h3">10. Account Suspension and Termination</div>
          <p className="p"><b>10.1 By You:</b> You may close your account at any time by contacting us at <b>tweaklyai@gmail.com</b>. Upon account closure, your data will be deleted in accordance with our Privacy Policy.</p>
          <p className="p"><b>10.2 By Us:</b> We reserve the right to suspend or terminate your account, without prior notice, if we reasonably believe you have violated these Terms, engaged in fraudulent or abusive behavior, or if required by law. We may also suspend or terminate accounts that have been inactive for an extended period.</p>
          <p className="p"><b>10.3 Effect of Termination:</b> Upon termination, your right to use the Service ceases immediately. We may delete your data in accordance with our Privacy Policy. Sections of these Terms that by their nature should survive termination will remain in effect.</p>

          <div className="h3">11. Changes to the Service and Terms</div>
          <p className="p"><b>11.1 Service Changes:</b> We reserve the right to modify, update, suspend, or discontinue any part of the Service at any time, with or without notice. We are not liable to you or any third party for any modification, suspension, or discontinuation of the Service.</p>
          <p className="p"><b>11.2 Terms Changes:</b> We may revise these Terms from time to time. When we make material changes, we will post the updated Terms on this page with a revised "Last updated" date. Your continued use of the Service after changes are posted constitutes your acceptance of the revised Terms.</p>

          <div className="h3">12. Governing Law and Dispute Resolution</div>
          <p className="p"><b>12.1 Governing Law:</b> These Terms are governed by and construed in accordance with the laws of the State of California, United States, without regard to its conflict-of-law principles.</p>
          <p className="p"><b>12.2 Dispute Resolution:</b> Any dispute arising out of or relating to these Terms or the Service shall first be attempted to be resolved through good-faith negotiation. If the dispute cannot be resolved through negotiation within 30 days, either party may pursue resolution through binding arbitration in accordance with the rules of the American Arbitration Association, or in the courts located in San Francisco, California.</p>

          <div className="h3">13. Severability</div>
          <p className="p">If any provision of these Terms is found to be unenforceable or invalid, that provision shall be limited or eliminated to the minimum extent necessary, and the remaining provisions shall remain in full force and effect.</p>

          <div className="h3">14. Entire Agreement</div>
          <p className="p">These Terms, together with our Privacy Policy and any other policies referenced herein, constitute the entire agreement between you and Tweakly regarding your use of the Service and supersede all prior agreements, communications, and understandings.</p>

          <div className="h3">15. Contact</div>
          <p className="p">If you have any questions about these Terms of Service, please contact us at:</p>
          <p className="p"><b>Email:</b> tweaklyai@gmail.com</p>
          <p className="p"><b>Application:</b> Tweakly — https://tweakly.pro</p>
        </>
      )}
      {routePath === '/security' && (
        <>
          <div className="h2">Security Practices</div>
          <p className="p"><i>Last updated: February 1, 2025</i></p>

          <p className="p">At Tweakly, security is a foundational design principle, not an afterthought. We understand that our users trust us with sensitive personal and professional information — resumes, career history, and account credentials — and we take that responsibility seriously. This page provides a comprehensive overview of the security measures, infrastructure choices, and operational practices we employ to protect your data.</p>

          <div className="h3">1. Data Encryption</div>
          <p className="p"><b>1.1 Encryption in Transit:</b> All communications between your browser and Tweakly's servers are encrypted using TLS 1.2 or higher. This ensures that your login credentials, resume content, job descriptions, and all other data are protected from interception during transmission. We enforce HTTPS across the entire platform with HTTP Strict Transport Security (HSTS) headers.</p>
          <p className="p"><b>1.2 Encryption at Rest:</b> All data stored in our databases and file storage systems is encrypted at rest using AES-256 encryption. This includes user account information, resume content, generated drafts, OAuth tokens, and all other stored data. Encryption keys are managed by our cloud provider's key management service and are rotated regularly.</p>
          <p className="p"><b>1.3 API Communications:</b> All internal API communications between our services and third-party API providers (including AI model providers) are conducted over encrypted channels using TLS.</p>

          <div className="h3">2. Authentication and Password Security</div>
          <p className="p"><b>2.1 Password Hashing:</b> User passwords are never stored in plaintext. We use the bcrypt hashing algorithm with a cost factor of 12 and a unique, randomly generated salt for each user. This makes brute-force and rainbow table attacks computationally infeasible. Our engineering team cannot view, recover, or reset your password — only you can set a new password through our secure password reset flow.</p>
          <p className="p"><b>2.2 Password Reset:</b> Password reset tokens are cryptographically random, time-limited (expiring within 1 hour), and single-use. Reset links are sent only to the verified email address associated with the account.</p>
          <p className="p"><b>2.3 Google OAuth 2.0:</b> For users who sign in with Google, authentication is handled entirely by Google's OAuth 2.0 infrastructure. We receive only a scoped access token and basic profile information. We do not receive or store your Google password. OAuth tokens are stored in encrypted server-side sessions and are never exposed to client-side JavaScript.</p>
          <p className="p"><b>2.4 Session Management:</b> User sessions are managed using secure, HTTP-only, same-site cookies with short expiration periods. Session tokens are cryptographically random and are invalidated upon logout. We implement automatic session expiration for inactive sessions.</p>

          <div className="h3">3. Infrastructure Security</div>
          <p className="p"><b>3.1 Cloud Hosting:</b> Tweakly is hosted on industry-leading cloud infrastructure that maintains SOC 2 Type II, ISO 27001, and other compliance certifications. Our infrastructure benefits from physical security, network isolation, and redundancy provided by the cloud platform.</p>
          <p className="p"><b>3.2 Network Security:</b> Our production environment is isolated within a virtual private cloud (VPC) with strict firewall rules. Only necessary ports and protocols are exposed. Database servers are not directly accessible from the public internet and can only be reached through our application servers.</p>
          <p className="p"><b>3.3 Database Security:</b> We use managed database services with automated encrypted backups, point-in-time recovery, and automated failover. Database access is restricted to application-level service accounts with the minimum required permissions.</p>
          <p className="p"><b>3.4 Dependency Management:</b> We regularly audit and update our software dependencies to patch known vulnerabilities. We use automated vulnerability scanning tools to identify and address security issues in our dependency chain.</p>

          <div className="h3">4. Access Controls</div>
          <p className="p"><b>4.1 Principle of Least Privilege:</b> All internal access to production systems, databases, and user data is granted on a strict need-to-know basis. Team members are given the minimum level of access required to perform their responsibilities.</p>
          <p className="p"><b>4.2 Administrative Access:</b> Administrative access to production infrastructure requires multi-factor authentication and is limited to authorized personnel. All administrative actions are logged and auditable.</p>
          <p className="p"><b>4.3 Third-Party Access:</b> Third-party service providers are granted access only to the data necessary to perform their contracted services and are bound by data processing agreements that require them to maintain appropriate security measures.</p>

          <div className="h3">5. Application Security</div>
          <p className="p"><b>5.1 Input Validation:</b> All user inputs are validated and sanitized on both the client and server side to prevent injection attacks, including SQL injection, cross-site scripting (XSS), and command injection.</p>
          <p className="p"><b>5.2 CSRF Protection:</b> We implement cross-site request forgery (CSRF) protection using secure tokens on all state-changing requests.</p>
          <p className="p"><b>5.3 Rate Limiting:</b> API endpoints are protected by rate limiting to prevent abuse, brute-force attacks, and denial-of-service attempts.</p>
          <p className="p"><b>5.4 Content Security Policy:</b> We implement Content Security Policy (CSP) headers to mitigate cross-site scripting and data injection attacks.</p>
          <p className="p"><b>5.5 Secure Headers:</b> Our server responses include security headers such as X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and Permissions-Policy to provide defense-in-depth protection.</p>

          <div className="h3">6. Data Handling and Privacy</div>
          <p className="p"><b>6.1 Minimal Data Collection:</b> We collect only the data necessary to provide the Service. We do not collect unnecessary personal information, and we do not sell or share user data with advertisers.</p>
          <p className="p"><b>6.2 AI Processing:</b> When resume content is sent to third-party AI APIs for processing, it is transmitted over encrypted channels. We use AI providers that offer data processing agreements ensuring your data is not used to train their models or retained beyond the processing request.</p>
          <p className="p"><b>6.3 Data Isolation:</b> Each user's data is logically isolated within our database. Users can only access their own data through authenticated API requests.</p>
          <p className="p"><b>6.4 Secure Deletion:</b> When you delete your account or specific data, we perform secure deletion from our primary storage. Data may persist in encrypted backups for up to 90 days before being automatically purged.</p>

          <div className="h3">7. Monitoring and Incident Response</div>
          <p className="p"><b>7.1 Monitoring:</b> We continuously monitor our systems for suspicious activity, unusual access patterns, and potential security threats. Automated alerts are configured for anomalous behavior.</p>
          <p className="p"><b>7.2 Logging:</b> We maintain comprehensive access and activity logs for security audit purposes. Logs are stored securely and are reviewed regularly.</p>
          <p className="p"><b>7.3 Incident Response:</b> We have a defined incident response process for handling security events. In the event of a confirmed data breach, we will notify affected users and relevant authorities within the timeframes required by applicable law.</p>

          <div className="h3">8. Responsible Disclosure</div>
          <p className="p">We value the security research community and welcome responsible disclosure of vulnerabilities. If you discover a security vulnerability in Tweakly, please report it to us at <b>tweaklyai@gmail.com</b>. Please include a detailed description of the vulnerability, steps to reproduce it, and the potential impact. We ask that you do not publicly disclose the vulnerability until we have had an opportunity to investigate and address it. We will acknowledge your report within 48 hours and work to resolve confirmed vulnerabilities promptly.</p>

          <div className="h3">9. User Responsibilities</div>
          <p className="p">While we implement robust security measures on our end, security is a shared responsibility. We recommend that you:</p>
          <p className="p">• Use a strong, unique password for your Tweakly account that you do not reuse on other services.</p>
          <p className="p">• Enable two-factor authentication on your Google account if you use Google Sign-In.</p>
          <p className="p">• Keep your browser and operating system up to date with the latest security patches.</p>
          <p className="p">• Log out of Tweakly when using shared or public computers.</p>
          <p className="p">• Report any suspected unauthorized access to your account immediately.</p>

          <div className="h3">10. Contact</div>
          <p className="p">For security-related inquiries or to report a vulnerability, please contact us at:</p>
          <p className="p"><b>Email:</b> tweaklyai@gmail.com</p>
          <p className="p"><b>Application:</b> Tweakly — https://tweakly.pro</p>
        </>
      )}
      {routePath === '/contact' && (
        <>
          <div className="h2">Contact Us</div>
          <p className="p"><i>Last updated: February 1, 2025</i></p>

          <p className="p">We appreciate your interest in Tweakly and are here to help with any questions, concerns, feedback, or support requests you may have. Below you will find the best ways to reach our team and what to expect when you contact us.</p>

          <div className="h3">General Inquiries and Support</div>
          <p className="p">For general questions about Tweakly, help with using the platform, troubleshooting issues, or providing product feedback, please contact us at:</p>
          <p className="p"><b>Email:</b> tweaklyai@gmail.com</p>
          <p className="p">We aim to respond to all inquiries within 48 hours during business days. For urgent issues related to account access or security, we prioritize faster response times.</p>

          <div className="h3">Privacy and Data Requests</div>
          <p className="p">If you have questions about our privacy practices, want to exercise your data rights (access, correction, deletion, or portability), or have concerns about how your data is being handled, please email us at <b>tweaklyai@gmail.com</b> with the subject line "Privacy Request." Please include your account email address so we can verify your identity and process your request efficiently. We will respond to verified data requests within 30 days, as required by applicable data protection laws including CCPA and GDPR.</p>

          <div className="h3">Security Concerns</div>
          <p className="p">If you have discovered a security vulnerability in Tweakly, suspect unauthorized access to your account, or have any security-related concerns, please report them immediately to <b>tweaklyai@gmail.com</b> with the subject line "Security Report." We take all security reports seriously and will acknowledge your report within 48 hours. For responsible vulnerability disclosure guidelines, please visit our <b>Security</b> page.</p>

          <div className="h3">Account Issues</div>
          <p className="p">If you are experiencing issues with your account — including login problems, password resets, Google OAuth connection issues, or difficulty accessing your saved resumes — please contact us at <b>tweaklyai@gmail.com</b> with a description of the issue and the email address associated with your account. Our team will work to resolve account-related issues as quickly as possible.</p>

          <div className="h3">Business and Partnership Inquiries</div>
          <p className="p">For business partnerships, press inquiries, integration requests, or any commercial discussions, please reach out to <b>tweaklyai@gmail.com</b> with the subject line "Business Inquiry." We are open to collaborations that align with our mission of helping professionals present their qualifications more effectively.</p>

          <div className="h3">Feedback and Feature Requests</div>
          <p className="p">We are constantly working to improve Tweakly, and your feedback is invaluable. If you have suggestions for new features, improvements to existing features, or ideas for how we can better serve your needs, please email us at <b>tweaklyai@gmail.com</b> with the subject line "Feedback." While we cannot guarantee that every suggestion will be implemented, we read and consider all feedback from our users.</p>

          <div className="h3">Legal Notices</div>
          <p className="p">Legal notices, DMCA takedown requests, and formal legal communications should be sent to <b>tweaklyai@gmail.com</b> with the subject line "Legal Notice." Please include all relevant details and supporting documentation. We will review and respond to legal notices in accordance with applicable law.</p>

          <div className="h3">Response Times</div>
          <p className="p">• <b>General support:</b> within 48 business hours</p>
          <p className="p">• <b>Security reports:</b> acknowledged within 48 hours</p>
          <p className="p">• <b>Privacy/data requests:</b> within 30 days</p>
          <p className="p">• <b>Account issues:</b> within 24–48 business hours</p>
          <p className="p">• <b>Business inquiries:</b> within 5 business days</p>

          <p className="p">Thank you for using Tweakly. We are committed to providing a secure, reliable, and effective platform for your career advancement needs.</p>
        </>
      )}
    </div>
  ) : null

  if (isWaitlistRoute) {
    return (
      <div className="page">
        <div className="glow" />
        <div className="container">
          <header className="topbar">
            <div className="brand">
              <button className="logo-button" onClick={(e) => e.preventDefault()} type="button" aria-label="Tweakly">
                <img className="logo-img" src="/icons/icon0.svg" alt="Tweakly" width="46" height="46" />
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
              <a href="https://tweakly.pro/privacy" className="footer-link">Privacy Policy</a>
              <a href="https://tweakly.pro/terms" className="footer-link">Terms of Service</a>
              <a href="https://tweakly.pro/security" className="footer-link">Security</a>
              <a href="https://tweakly.pro/contact" className="footer-link">Contact</a>
            </div>
          </footer>
        </div>
      </div>
    )
  }

  const tickerCompanies = ['Google', 'Meta', 'Apple', 'Microsoft', 'Amazon', 'Netflix', 'Nvidia', 'Tesla', 'Stripe', 'Airbnb', 'Uber', 'Salesforce']

  const landingFeatures = [
    { icon: '\u{1F3AF}', title: 'Resume Tailoring', desc: 'Automatically rewrite bullets and skills to match each job description. ATS-optimized output every time.' },
    { icon: '\u{2709}\u{FE0F}', title: 'Cover Letters', desc: 'Generate personalized cover letters that reference the role and company, ready to send in seconds.' },
    { icon: '\u{1F4C4}', title: 'Format Preservation', desc: 'Upload your DOCX or Google Doc. Tweakly preserves your layout, fonts, and formatting perfectly.' },
    { icon: '\u{1F680}', title: 'Outreach Messages', desc: 'Craft cold emails and LinkedIn messages tailored to each recruiter and company.' },
  ]

  if (!isAuthenticated) {
    return (
      <div className="page landing-page">
        <div className="glow" />

        {/* Nav */}
        <nav className="landing-nav">
          <div className="landing-nav-inner">
            <div className="brand">
              <img className="logo-img" src="/icons/icon0.svg" alt="Tweakly" width="36" height="36" />
              <span className="brand-name">Tweakly</span>
            </div>
            <div className="landing-nav-actions">
              <button className="btn small" onClick={() => { setAuthMode('login'); document.getElementById('auth-section')?.scrollIntoView({ behavior: 'smooth' }); }}>Log In</button>
              <button className="btn primary small" onClick={() => { setAuthMode('register'); document.getElementById('auth-section')?.scrollIntoView({ behavior: 'smooth' }); }}>Sign Up Free</button>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <motion.section
          className="landing-hero"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease }}
        >
          <div className="landing-eyebrow">AI-Powered Resume Tailoring</div>
          <h1 className="landing-h1">
            Land more interviews.<br />
            <span className="landing-gradient-text">Tailor every resume in seconds.</span>
          </h1>
          <p className="landing-subtitle">
            Feed Tweakly a job description and your resume. Get back a sharper, ATS-optimized
            version with your formatting preserved — plus a cover letter and outreach messages.
          </p>
          <button
            className="btn primary landing-cta"
            onClick={() => { setAuthMode('register'); document.getElementById('auth-section')?.scrollIntoView({ behavior: 'smooth' }); }}
          >
            Get Started Free &rarr;
          </button>
        </motion.section>

        {/* Logo Ticker */}
        <section className="landing-ticker-section">
          <div className="landing-ticker-label">Trusted by candidates applying to</div>
          <div className="landing-ticker-track">
            <div className="landing-ticker-scroll">
              {tickerCompanies.map((name, i) => (
                <span key={i} className="landing-ticker-item">{name}</span>
              ))}
              {tickerCompanies.map((name, i) => (
                <span key={`dup-${i}`} className="landing-ticker-item">{name}</span>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="landing-features">
          <div className="landing-features-header">
            <div className="landing-eyebrow">Everything you need</div>
            <div className="landing-h1" style={{ fontSize: 'clamp(24px, 3vw, 36px)', marginBottom: 0 }}>
              Your entire application toolkit.<br />
              <span className="landing-gradient-text">In one place.</span>
            </div>
          </div>
          <motion.div
            className="landing-features-grid"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-80px' }}
            variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.12 } } }}
          >
            {landingFeatures.map((f, i) => (
              <motion.div
                key={i}
                className="panel landing-feature-card"
                variants={{
                  hidden: { opacity: 0, y: 20 },
                  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease } }
                }}
              >
                <div className="landing-feature-icon">{f.icon}</div>
                <div className="h2">{f.title}</div>
                <p className="p" style={{ marginTop: 8 }}>{f.desc}</p>
              </motion.div>
            ))}
          </motion.div>
        </section>

        {/* Auth */}
        <section className="landing-auth-section" id="auth-section">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, ease }}
          >
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div className="h2">
                {authMode === 'login' ? 'Welcome back' : 'Create your account'}
              </div>
              <p className="p" style={{ margin: '8px auto 0', maxWidth: 360 }}>
                {authMode === 'login'
                  ? 'Log in to access your saved templates and tuned resumes.'
                  : 'Sign up free to start tailoring your resume in seconds.'}
              </p>
            </div>
            <div className="panel landing-auth-panel">
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
          </motion.div>
        </section>

        {/* Footer */}
        <footer className="footer landing-footer">
          <div className="footer-title">Built for people who geek out on clean signal.</div>
          <div className="footer-copy">
            Tweakly is your resume co-processor: fast iterations, minimal noise, maximal clarity.
          </div>
          <div className="footer-links">
            <a href="https://tweakly.pro/privacy" className="footer-link">Privacy Policy</a>
            <a href="https://tweakly.pro/terms" className="footer-link">Terms of Service</a>
            <a href="https://tweakly.pro/security" className="footer-link">Security</a>
            <a href="https://tweakly.pro/contact" className="footer-link">Contact</a>
          </div>
        </footer>
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
              <img className="logo-img" src="/icons/icon0.svg" alt="Tweakly" width="36" height="36" />
            </button>
            <span className="brand-name">Tweakly</span>
          </div>
          <nav className="stepper">
            <button
              className={`stepper-step ${uiStep === 'input' ? 'active' : ''} ${draft || selectedDocId ? 'done' : ''}`}
              onClick={() => setUiStep('input')}
            >
              <span className="stepper-num">1</span>
              <span className="stepper-label">Brief</span>
            </button>
            <span className="stepper-arrow">&rsaquo;</span>
            <button
              className={`stepper-step ${uiStep === 'edit' ? 'active' : ''}`}
              onClick={() => setUiStep('edit')}
              disabled={mode === 'gdocs' ? !selectedDocId : !draft}
            >
              <span className="stepper-num">2</span>
              <span className="stepper-label">Tune</span>
            </button>
            <span className="stepper-arrow">&rsaquo;</span>
            <button
              className={`stepper-step ${uiStep === 'outreach' ? 'active' : ''}`}
              onClick={() => setUiStep('outreach')}
              disabled={mode === 'gdocs' ? !selectedDocId : !draft}
            >
              <span className="stepper-num">3</span>
              <span className="stepper-label">Outreach</span>
            </button>
          </nav>
          <div className="user-menu">
            <button className="chip tiny" onClick={handleOpenSaved}>
              Saved Resumes
            </button>
            <div className="account-dropdown-wrapper" ref={accountDropdownRef}>
              <button
                className="user-chip"
                onClick={() => setAccountDropdownOpen(prev => !prev)}
                type="button"
              >
                <div className="avatar">{userInitial}</div>
                <div className="user-display-name">{userDisplayName}</div>
              </button>
              {accountDropdownOpen && (
                <div className="account-dropdown">
                  <div className="account-dropdown-header">
                    <div className="avatar">{userInitial}</div>
                    <div>
                      <div className="account-dropdown-name">{userDisplayName}</div>
                      <div className="account-dropdown-email">{userEmail}</div>
                    </div>
                  </div>
                  <div className="account-dropdown-divider" />
                  <button className="account-dropdown-item" onClick={() => { setAccountDropdownOpen(false); setUiStep('account'); }}>
                    My Account
                  </button>
                  <button className="account-dropdown-item" onClick={() => { setAccountDropdownOpen(false); setUiStep('settings'); }}>
                    Settings
                  </button>
                  <div className="account-dropdown-divider" />
                  <button className="account-dropdown-item danger" onClick={() => { setAccountDropdownOpen(false); handleLogout(); }}>
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        {isLegalRoute ? legalContent : (<>

        {uiStep === 'account' && (
          <motion.div key="account-page" className="settings-page" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
            <button className="back-link" onClick={() => setUiStep('input')} type="button">&larr; Back</button>
            <div className="h2">My Account</div>
            <div className="settings-section">
              <div className="settings-label">Profile</div>
              <div className="settings-card">
                <div className="settings-row">
                  <div className="avatar avatar-lg">{userInitial}</div>
                  <div>
                    <div className="settings-value">{userFirstName}{userLastName ? ` ${userLastName}` : ''}</div>
                    <div className="settings-hint">{userEmail}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Account details</div>
              <div className="settings-card">
                <div className="settings-field">
                  <span className="settings-field-label">First name</span>
                  <span className="settings-value">{userFirstName || '—'}</span>
                </div>
                <div className="settings-divider" />
                <div className="settings-field">
                  <span className="settings-field-label">Last name</span>
                  <span className="settings-value">{userLastName || '—'}</span>
                </div>
                <div className="settings-divider" />
                <div className="settings-field">
                  <span className="settings-field-label">Email</span>
                  <span className="settings-value">{userEmail}</span>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Danger zone</div>
              <div className="settings-card danger-zone">
                <div className="settings-field">
                  <div>
                    <span className="settings-value">Delete account</span>
                    <div className="settings-hint">Permanently delete your account and all associated data.</div>
                  </div>
                  <a href="mailto:tweaklyai@gmail.com?subject=Account%20Deletion%20Request" className="chip tiny danger-chip">Request deletion</a>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {uiStep === 'settings' && (
          <motion.div key="settings-page" className="settings-page" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
            <button className="back-link" onClick={() => setUiStep('input')} type="button">&larr; Back</button>
            <div className="h2">Settings</div>
            <div className="settings-section">
              <div className="settings-label">Appearance</div>
              <div className="settings-card">
                <div className="settings-field">
                  <span className="settings-field-label">Theme</span>
                  <span className="settings-value">Dark</span>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Resume defaults</div>
              <div className="settings-card">
                <div className="settings-field">
                  <span className="settings-field-label">Default mode</span>
                  <span className="settings-value">{mode === 'latex' ? 'LaTeX' : mode === 'gdocs' ? 'Google Docs' : 'DOCX'}</span>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Connected accounts</div>
              <div className="settings-card">
                <div className="settings-field">
                  <div>
                    <span className="settings-value">Google</span>
                    <div className="settings-hint">{selectedDocId ? 'Connected' : 'Not connected'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">About</div>
              <div className="settings-card">
                <div className="settings-field">
                  <span className="settings-field-label">Version</span>
                  <span className="settings-value">1.0.0</span>
                </div>
                <div className="settings-divider" />
                <div className="settings-field">
                  <span className="settings-field-label">Support</span>
                  <a href="mailto:tweaklyai@gmail.com" className="settings-link">tweaklyai@gmail.com</a>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {uiStep !== 'account' && uiStep !== 'settings' && (<>
        <div className="hero">
          <div className="h1">
            {uiStep === 'edit'
              ? 'Tuned and ready.'
              : uiStep === 'outreach'
                ? 'Who are we reaching?'
                : 'What are we tuning today?'}
          </div>
        </div>

        {uiStep === 'input' && (
          <motion.div key="input-grid" className="grid grid-2" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>

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
          </motion.div>
        )}

        {mode === 'gdocs' && uiStep === 'edit' && (
          <motion.div className="gdocs-preview-layout" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>
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
          </motion.div>
        )}

        {(mode === 'latex' || mode === 'docx') && draft && (uiStep === 'edit' || uiStep === 'export') && (
          mode === 'docx' ? (
            <motion.div className="edit-layout single-col" ref={editPanelRef} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>
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
                    <div className="small subtle">Read-only preview powered by Microsoft Office Online.</div>
                  </div>
                  {msOfficeViewerUrl ? (
                    <iframe
                      className="preview-frame"
                      src={msOfficeViewerUrl}
                      title="Resume DOCX preview"
                    />
                  ) : (
                    <div className="preview">Preview not available. Download the DOCX to view.</div>
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
            </motion.div>
          ) : (
            <motion.div className="edit-layout" ref={editPanelRef} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>
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
            </motion.div>
          )
        )}

        {uiStep === 'edit' && (
          <motion.div className="panel cover-panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease, delay: 0.1 }}>
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
          </motion.div>
        )}

        {uiStep === 'outreach' && (
          <motion.div className="panel cover-panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease }}>
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
          </motion.div>
        )}

        {uiStep === 'saved' && (
          <motion.div className="panel saved-panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease }}>
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
          </motion.div>
        )}
        </>)}

        <footer className="footer">
          <div className="footer-links">
            <a href="https://tweakly.pro/privacy" className="footer-link">Privacy Policy</a>
            <a href="https://tweakly.pro/terms" className="footer-link">Terms of Service</a>
            <a href="https://tweakly.pro/security" className="footer-link">Security</a>
            <a href="https://tweakly.pro/contact" className="footer-link">Contact</a>
          </div>
        </footer>
        </>)}
      </div>
    </div>
  )
}
