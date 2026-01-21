import React, { useEffect, useMemo, useRef, useState } from 'react'

const STEPS = [
  'Parsing resume structure',
  'Analyzing job description',
  'Rewriting experience bullets',
  'Optimizing skills & keywords',
  'Preparing editable draft',
]

type OptimizeProgressOverlayProps = {
  active: boolean
}

export default function OptimizeProgressOverlay({ active }: OptimizeProgressOverlayProps) {
  const [lineIndex, setLineIndex] = useState(0)
  const [charIndex, setCharIndex] = useState(0)
  const timerRef = useRef<number | null>(null)
  const [completedAll, setCompletedAll] = useState(false)

  useEffect(() => {
    if (!active) {
      setCompletedAll(true)
      setLineIndex(STEPS.length)
      setCharIndex(0)
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }

    setCompletedAll(false)
    setLineIndex(0)
    setCharIndex(0)

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [active])

  useEffect(() => {
    if (!active || completedAll) return undefined
    const stepLines = [...STEPS, 'Draft ready.']
    const typeDelay = 45
    const linePause = 7000
    const current = stepLines[lineIndex] || ''

    if (lineIndex >= stepLines.length) return

    if (charIndex < current.length) {
      timerRef.current = window.setTimeout(() => {
        setCharIndex((prev) => prev + 1)
      }, typeDelay)
      return () => {
        if (timerRef.current) {
          window.clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    }

    if (lineIndex < stepLines.length - 1) {
      timerRef.current = window.setTimeout(() => {
        setLineIndex((prev) => prev + 1)
        setCharIndex(0)
      }, linePause)
    }
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [active, completedAll, lineIndex, charIndex])

  const logLines = useMemo(() => {
    const lines = [...STEPS, 'Draft ready.'].map((step) => `> ${step}`)
    if (completedAll) {
      return lines
    }
    const visible = lines.slice(0, lineIndex)
    const current = lines[lineIndex] || ''
    if (current) {
      visible.push(current.slice(0, Math.min(current.length, charIndex + 2)))
    }
    return visible
  }, [lineIndex, charIndex, completedAll])

  if (!active) return null

  return (
    <div className="opt-overlay" aria-live="polite">
      <div className="opt-panel">
        <div className="opt-title">Optimizing…</div>
        <div className="opt-log" aria-live="polite">
          {logLines.map((line, idx) => (
            <div key={`${line}-${idx}`} className="opt-log-line">
              {line}
            </div>
          ))}
          {!completedAll && <span className="opt-cursor">▋</span>}
        </div>
        <div className="opt-footer">
          This may take 30-35 seconds. Your layout will be preserved.
        </div>
      </div>
    </div>
  )
}
