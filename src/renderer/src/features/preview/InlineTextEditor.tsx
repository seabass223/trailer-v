/**
 * In-place text editing on the preview: a TipTap editor laid exactly over the clip's text box,
 * zoomed so one reference unit is as large on screen as in the GPU render (identical line
 * breaks). The clip is hidden in the GPU render meanwhile so the text isn't drawn twice.
 * Escape or a click anywhere outside ends editing.
 */
import { EditorContent, useEditor as useTiptap } from '@tiptap/react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { engine } from '@/engine/client'
import { cssFont, DEFAULT_STYLE, paragraphs } from '@/engine/text/layout'
import { rgba, unitFor } from '@/engine/text/raster'
import { updateClip } from '@/features/editor/actions'
import { textExtensions } from '@/features/inspector/text-extensions'
import type { Clip, Project, RichNode, TextData } from '@shared/model'
import { clipEnd } from '@shared/timeline'

/**
 * Paragraph strut matching the canvas layout: the first run's font and size, and a line height
 * never below the font's natural height (CSS would let lines overlap; the layout doesn't).
 */
function strut(text: TextData) {
  const first = paragraphs(text.doc).find((p) => p.runs.length)?.runs[0].style ?? DEFAULT_STYLE
  const ctx = new OffscreenCanvas(8, 8).getContext('2d')!
  ctx.font = cssFont(first, 1)
  const m = ctx.measureText('Hg')
  const natural = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / first.fontSize
  return {
    fontFamily: `"${first.fontFamily}", "Segoe UI", sans-serif`,
    fontSize: first.fontSize,
    lineHeight: Math.max(text.lineHeight ?? 1.15, natural || 0),
  }
}

export function InlineTextEditor({ clip, project, width, at, onDone }: {
  clip: Clip
  project: Project
  /** Preview frame width in CSS px. */
  width: number
  /** Viewport point that started editing; the caret goes there. */
  at: { x: number; y: number }
  onDone: () => void
}) {
  const text = clip.text!
  const id = clip.id
  const rootRef = useRef<HTMLDivElement>(null)
  const lastJson = useRef(JSON.stringify(text.doc))
  const done = useRef(onDone)
  done.current = onDone

  const editor = useTiptap({
    extensions: textExtensions(),
    content: text.doc,
    immediatelyRender: true,
    editorProps: {
      attributes: { style: 'white-space: pre-wrap' },
      // The frame clips overflow; scrolling it would shift the whole preview.
      handleScrollToSelection: () => true,
    },
    onUpdate: ({ editor }) => {
      const json = editor.getJSON() as RichNode
      const s = JSON.stringify(json)
      if (s === lastJson.current) return
      lastJson.current = s
      updateClip(id, 'Edit text', (c) => {
        if (c.text) c.text.doc = json
      }, 'text')
    },
  })

  // External changes (e.g. undo from the History popover) replace the content.
  useEffect(() => {
    const s = JSON.stringify(text.doc)
    if (s !== lastJson.current && editor) {
      lastJson.current = s
      editor.commands.setContent(text.doc, { emitUpdate: false })
    }
  }, [text.doc, editor])

  // Caret at the double-clicked point. Focus synchronously (TipTap's focus waits a frame), so
  // a key pressed right away can't reach the global shortcuts instead.
  useLayoutEffect(() => {
    if (!editor) return
    const hit = editor.view.posAtCoords({ left: at.x, top: at.y })
    editor.commands.setTextSelection(hit ? hit.pos : editor.state.doc.content.size)
    editor.view.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  useEffect(() => {
    engine().hideClip(id)
    return () => engine().hideClip(null)
  }, [id])

  // Click outside ends editing; the click still does whatever it does there.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) done.current()
    }
    document.addEventListener('pointerdown', down, true)
    const frame = rootRef.current?.parentElement
    const pin = () => frame && (frame.scrollTop = frame.scrollLeft = 0)
    frame?.addEventListener('scroll', pin)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      frame?.removeEventListener('scroll', pin)
    }
  }, [])

  // Playback, or the playhead leaving the clip, ends editing.
  const start = clip.start
  const end = clipEnd(clip)
  useEffect(() => engine().subscribe((t, playing) => {
    if (playing || t < start || t >= end) done.current()
  }), [start, end])

  const typo = useMemo(() => strut(text), [text])
  const { width: W, height: H } = project.settings
  const unit = unitFor(W, H)
  const s = Math.max(0.05, clip.transform.scale)
  const k = width / W
  // Box in reference units; `zoom` maps one unit to its on-screen size.
  const boxW = (text.box.width * W) / unit
  const innerW = Math.max(1, boxW - text.box.padding * 2)
  const left = (W / 2 + clip.transform.x * W - (text.box.width * W * s) / 2) * k
  const top = (H / 2 + clip.transform.y * H) * k

  return (
    <div
      ref={rootRef}
      data-testid="inline-text-editor"
      className="absolute left-0 top-0 z-10 cursor-text outline outline-1 outline-primary"
      style={{ transform: `translate(${left}px, ${top}px) translateY(-50%)` }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onDone()
      }}
    >
      <div
        style={{
          zoom: unit * s * k,
          width: boxW,
          padding: text.box.padding,
          // Knockout shows as plain letters while editing.
          background: !text.knockout && text.box.backgroundOpacity > 0 ? rgba(text.box.background, text.box.backgroundOpacity) : undefined,
          borderRadius: text.box.radius,
        }}
      >
        <EditorContent
          editor={editor}
          className="[&_.ProseMirror]:outline-none [&_p]:m-0"
          style={{
            width: innerW,
            ...typo,
            color: '#fff',
            userSelect: 'text',
            textShadow: text.knockout ? '0 2px 10px rgba(0,0,0,.55)' : undefined,
          }}
        />
      </div>
    </div>
  )
}
