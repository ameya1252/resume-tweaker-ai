import React from 'react'
import { DraftExperience } from '../utils/draft'

type ResumePreviewReadOnlyProps = {
  draftExperiences: DraftExperience[]
  skills: string
}

export default function ResumePreviewReadOnly({ draftExperiences, skills }: ResumePreviewReadOnlyProps) {
  return (
    <div className="panel preview-readonly">
      <div className="preview-head">
        <div className="h2">Live Preview</div>
        <div className="small subtle">Read-only view of titles and bullets.</div>
      </div>
      {draftExperiences.map((exp) => (
        <div key={exp.id} className="preview-exp" data-exp-id={exp.id}>
          <div className="preview-exp-head">
            <div className="preview-exp-title">{exp.title || 'Untitled role'}</div>
            {exp.company && <div className="preview-exp-company">{exp.company}</div>}
          </div>
          <ul className="preview-exp-bullets">
            {exp.bullets.map((b) => (
              <li key={b.id}>{b.text}</li>
            ))}
          </ul>
        </div>
      ))}
      {skills && (
        <div className="preview-skills">
          <div className="label">Skills</div>
          <div className="preview-skills-text">{skills}</div>
        </div>
      )}
    </div>
  )
}
