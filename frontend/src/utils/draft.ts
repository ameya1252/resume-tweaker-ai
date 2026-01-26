export type DraftItem = { id: string; text: string; experience_id?: string | null; project_id?: string | null }
export type Draft = {
  titles: DraftItem[]
  companies?: DraftItem[]
  bullets: DraftItem[]
  project_titles?: DraftItem[]
  project_dates?: DraftItem[]
  project_bullets?: DraftItem[]
  skills: string
}
export type DraftExperience = {
  id: string
  company: string
  title: string
  bullets: DraftItem[]
}
export type DraftProject = {
  id: string
  name: string
  dates: string
  bullets: DraftItem[]
}
export type DraftApplyRequest = {
  titles?: DraftItem[]
  companies?: DraftItem[]
  bullets?: DraftItem[]
  project_titles?: DraftItem[]
  project_dates?: DraftItem[]
  project_bullets?: DraftItem[]
  skills?: string
}

export function buildDraftExperiences(
  titles: DraftItem[],
  bullets: DraftItem[],
  companies: DraftItem[] = [],
  companyById: Record<string, string> = {},
) {
  if (!titles.length) {
    return bullets.length
      ? [{ id: 'exp0', company: '', title: '', bullets: bullets.slice() }]
      : []
  }
  const bucketed: Record<string, DraftItem[]> = {}
  for (const b of bullets) {
    const key = b.experience_id || ''
    if (!bucketed[key]) bucketed[key] = []
    bucketed[key].push(b)
  }
  const companyByDraft: Record<string, string> = {}
  for (const c of companies) {
    if (c.id) companyByDraft[c.id] = c.text
  }
  return titles.map((t) => ({
    id: t.id,
    company: companyByDraft[t.id] || companyById[t.id] || '',
    title: t.text,
    bullets: bucketed[t.id] || [],
  }))
}

export function buildDraftProjects(
  titles: DraftItem[],
  dates: DraftItem[] = [],
  bullets: DraftItem[] = [],
) {
  if (!titles.length) {
    return bullets.length
      ? [{ id: 'pj0', name: '', dates: '', bullets: bullets.slice() }]
      : []
  }
  const bucketed: Record<string, DraftItem[]> = {}
  for (const b of bullets) {
    const key = b.project_id || ''
    if (!bucketed[key]) bucketed[key] = []
    bucketed[key].push(b)
  }
  const datesById: Record<string, string> = {}
  for (const d of dates) {
    if (d.id) datesById[d.id] = d.text
  }
  return titles.map((t) => ({
    id: t.id,
    name: t.text,
    dates: datesById[t.id] || '',
    bullets: bucketed[t.id] || [],
  }))
}
