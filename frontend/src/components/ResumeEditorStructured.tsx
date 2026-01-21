import React, { useEffect, useMemo, useState } from 'react'
import { estimateVisualLines } from '../utils/formatting'
import { DraftApplyRequest, DraftExperience, DraftItem } from '../utils/draft'

type ResumeEditorStructuredProps = {
  draftExperiences: DraftExperience[]
  skillsText?: string
  onApply: (changes: DraftApplyRequest) => Promise<void>
}

function normalizeBulletLine(line: string) {
  return line.replace(/^\s*[•\-–*]\s*/, '').replace(/\s+/g, ' ').trim()
}

export default function ResumeEditorStructured({
  draftExperiences,
  skillsText,
  onApply,
}: ResumeEditorStructuredProps) {
  const [bulletBlocks, setBulletBlocks] = useState<Record<string, string>>({})
  const [blockWarnings, setBlockWarnings] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    const nextBlocks: Record<string, string> = {}
    for (const exp of draftExperiences) {
      nextBlocks[exp.id] = exp.bullets.map((b) => `• ${b.text}`).join('\n')
    }
    setBulletBlocks(nextBlocks)
    setBlockWarnings({})
    setSaveError(null)
  }, [draftExperiences])

  const longBulletCount = useMemo(() => {
    let count = 0
    for (const exp of draftExperiences) {
      for (const b of exp.bullets) {
        if (estimateVisualLines(b.text) > 1) count += 1
      }
    }
    return count
  }, [draftExperiences])

  const skillsTooLong = useMemo(() => {
    if (!skillsText) return false
    return estimateVisualLines(skillsText) > 3
  }, [skillsText])

  const visibleExperiences = useMemo(() => {
    return draftExperiences.filter((exp) => exp.company && exp.bullets.length > 0)
  }, [draftExperiences])

  async function handleApply() {
    setSaveError(null)
    let invalid = false
    const bulletChanges: DraftItem[] = []

    for (const exp of visibleExperiences) {
      const block = bulletBlocks[exp.id] ?? ''
      const lines = block
        .split('\n')
        .map((line) => normalizeBulletLine(line))
        .filter((line) => line.length > 0)
      if (lines.length !== exp.bullets.length) {
        setBlockWarnings((prev) => ({
          ...prev,
          [exp.id]: 'keep same number of lines',
        }))
        continue
      } else if (blockWarnings[exp.id]) {
        setBlockWarnings((prev) => {
          const next = { ...prev }
          delete next[exp.id]
          return next
        })
      }
      for (let idx = 0; idx < exp.bullets.length; idx += 1) {
        const b = exp.bullets[idx]
        const nextText = (lines[idx] || '').replace(/\s+/g, ' ').trim()
        if (!nextText) continue
        const singleLine = nextText.replace(/\n/g, ' ').trim()
        if (singleLine.length > 180) {
          invalid = true
          setSaveError('Bullet edits must be 180 characters or fewer.')
          break
        }
        if (singleLine !== b.text) {
          bulletChanges.push({ id: b.id, text: singleLine, experience_id: exp.id })
        }
      }
      if (invalid) break
    }

    const changes: DraftApplyRequest = {}
    if (bulletChanges.length) changes.bullets = bulletChanges

    if (!changes.bullets) return
    if (invalid) return

    setSaving(true)
    try {
      await onApply(changes)
    } catch (e: any) {
      setSaveError(e?.message || 'Failed to apply changes.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel">
      <div className="preview-head">
        <div className="h2">Structured Editor</div>
        <div className="small subtle">Review and fine-tune before exporting. Changes update instantly.</div>
      </div>
      {(longBulletCount > 0 || skillsTooLong) && (
        <div className="warning-banner">
          ⚠ {longBulletCount > 0 ? `${longBulletCount} bullets likely exceed 1 line. ` : ''}
          {skillsTooLong ? 'Skills likely exceed 3 lines. ' : ''}
          Resume may spill to page 2.
        </div>
      )}

      {visibleExperiences.map((exp) => (
        <div key={exp.id} className="exp-editor">
          <div className="exp-editor-company">{exp.company}</div>
          <div className="exp-editor-title">{exp.title || 'Role'}</div>
          <textarea
            className="ta draft-textarea"
            rows={Math.max(3, exp.bullets.length + 1)}
            value={bulletBlocks[exp.id] ?? ''}
            onChange={(e) => setBulletBlocks((prev) => ({ ...prev, [exp.id]: e.target.value }))}
          />
          {blockWarnings[exp.id] && (
            <div className="small warn-inline">⚠ {blockWarnings[exp.id]}</div>
          )}
        </div>
      ))}

      <div className="actions">
        <button className="btn primary" onClick={handleApply} disabled={saving}>
          {saving ? 'Applying…' : 'Apply changes'}
        </button>
        {saveError && <span className="small error-inline">{saveError}</span>}
      </div>
    </div>
  )
}
