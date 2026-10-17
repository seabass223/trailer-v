import { EditorContent, useEditor as useTiptap, useEditorState } from '@tiptap/react'
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Strikethrough, Underline } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { unitFor } from '@/engine/text/raster'
import { updateClip } from '@/features/editor/actions'
import { useEditor } from '@/state/store'
import type { Clip, RichNode } from '@shared/model'
import { ColorField, Row, Section, SliderRow } from './fields'
import { FontPicker } from './FontPicker'
import { textExtensions } from './text-extensions'

/** Rich text editing with TipTap; preview is scaled so line breaks match the render. */
export function TextInspector({ clip }: { clip: Clip }) {
  const text = clip.text!
  const settings = useEditor((s) => s.project!.settings)
  const editingId = useEditor((s) => s.editingTextId)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(280)
  const lastJson = useRef(JSON.stringify(text.doc))
  const idRef = useRef(clip.id)
  idRef.current = clip.id

  const editor = useTiptap({
    extensions: textExtensions(),
    content: text.doc,
    immediatelyRender: true,
    onUpdate: ({ editor }) => {
      const json = editor.getJSON() as RichNode
      const s = JSON.stringify(json)
      if (s === lastJson.current) return
      lastJson.current = s
      updateClip(idRef.current, 'Edit text', (c) => {
        if (c.text) c.text.doc = json
      }, 'text')
    },
  })

  // External changes (undo/redo, other clip) replace the editor content.
  useEffect(() => {
    const s = JSON.stringify(text.doc)
    if (s !== lastJson.current && editor) {
      lastJson.current = s
      editor.commands.setContent(text.doc, { emitUpdate: false })
    }
  }, [text.doc, editor])

  useEffect(() => {
    if (editingId === clip.id && editor) {
      editor.commands.focus('end')
      useEditor.setState({ editingTextId: null })
    }
  }, [editingId, clip.id, editor])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const a = e.getAttributes('textStyle')
      return {
        font: (a.fontFamily as string | undefined)?.replace(/["']/g, '') ?? 'Segoe UI',
        size: parseFloat((a.fontSize as string | undefined) ?? '96') || 96,
        color: (a.color as string | undefined) ?? '#ffffff',
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        align: (['left', 'center', 'right'].find((x) => e.isActive({ textAlign: x })) ?? 'center') as string,
      }
    },
  })

  // Apply to the selection, or to all text when nothing is selected.
  const apply = (fn: (c: ReturnType<NonNullable<typeof editor>['chain']>) => ReturnType<NonNullable<typeof editor>['chain']>) => {
    if (!editor) return
    let chain = editor.chain().focus()
    if (editor.state.selection.empty) chain = chain.selectAll()
    fn(chain).run()
  }

  const set = (label: string, fn: (c: Clip) => void, key?: string) => updateClip(clip.id, label, fn, key)

  // Scale the editor so its width equals the rendered text box: identical wrapping.
  const unit = unitFor(settings.width, settings.height)
  const boxRef = (text.box.width * settings.width) / unit
  const innerRef = Math.max(40, boxRef - text.box.padding * 2)
  const zoom = Math.max(0.05, (avail - 2) / boxRef)
  const lh = text.lineHeight ?? 1.15

  return (
    <>
      <Section title="Text">
        <div ref={wrapRef} className="overflow-hidden rounded-md border bg-[repeating-conic-gradient(#1b1e24_0_25%,#15171c_0_50%)_0_0/16px_16px]">
          <div
            style={{
              zoom,
              width: boxRef,
              padding: text.box.padding,
              background: !text.knockout && text.box.backgroundOpacity > 0 ? `${text.box.background}${Math.round(text.box.backgroundOpacity * 255).toString(16).padStart(2, '0')}` : undefined,
              borderRadius: text.box.radius,
            }}
          >
            <EditorContent
              editor={editor}
              className="[&_.ProseMirror]:outline-none [&_p]:m-0"
              style={{ width: innerRef, fontFamily: '"Segoe UI"', fontSize: 96, lineHeight: lh, color: '#fff', userSelect: 'text' }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <FontPicker value={st?.font ?? 'Segoe UI'} onChange={(f) => apply((c) => c.setFontFamily(f))} />
          <Input type="number" min={8} max={600} className="h-8 w-[72px] tabular" value={Math.round(st?.size ?? 96)}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v >= 4 && v <= 1000) apply((c) => c.setFontSize(`${v}px`))
            }} />
          <ColorField value={st?.color ?? '#ffffff'} onChange={(v) => apply((c) => c.setColor(v))} />
        </div>
        <div className="flex items-center gap-1">
          <Toggle size="sm" pressed={st?.bold} onPressedChange={() => apply((c) => c.toggleBold())} aria-label="Bold"><Bold /></Toggle>
          <Toggle size="sm" pressed={st?.italic} onPressedChange={() => apply((c) => c.toggleItalic())} aria-label="Italic"><Italic /></Toggle>
          <Toggle size="sm" pressed={st?.underline} onPressedChange={() => apply((c) => c.toggleUnderline())} aria-label="Underline"><Underline /></Toggle>
          <Toggle size="sm" pressed={st?.strike} onPressedChange={() => apply((c) => c.toggleStrike())} aria-label="Strikethrough"><Strikethrough /></Toggle>
          <ToggleGroup type="single" size="sm" className="ml-auto" value={st?.align}
            onValueChange={(v) => v && editor?.chain().focus().selectAll().setTextAlign(v).run()}>
            <ToggleGroupItem value="left" aria-label="Align left"><AlignLeft /></ToggleGroupItem>
            <ToggleGroupItem value="center" aria-label="Align center"><AlignCenter /></ToggleGroupItem>
            <ToggleGroupItem value="right" aria-label="Align right"><AlignRight /></ToggleGroupItem>
          </ToggleGroup>
        </div>
        <SliderRow label="Line height" value={lh} min={0.7} max={2.5} step={0.05} format={(v) => v.toFixed(2)}
          onChange={(v) => set('Line height', (c) => { if (c.text) c.text.lineHeight = v }, 'lh')} onReset={() => set('Line height', (c) => { if (c.text) c.text.lineHeight = 1.15 })} />
      </Section>

      <Section title="Box">
        <SliderRow label="Width" value={text.box.width} min={0.1} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set('Text box width', (c) => { c.text!.box.width = v }, 'bw')} />
        <SliderRow label="Padding" value={text.box.padding} min={0} max={160} step={1} format={(v) => `${v}`}
          onChange={(v) => set('Text padding', (c) => { c.text!.box.padding = v }, 'bp')} />
        <Row label="Background">
          <ColorField value={text.box.background} onChange={(v) => set('Text background', (c) => { c.text!.box.background = v }, 'bg')} />
          <span className="text-xs text-muted-foreground">Opacity</span>
        </Row>
        <SliderRow label="" value={text.box.backgroundOpacity} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set('Background opacity', (c) => { c.text!.box.backgroundOpacity = v }, 'bo')} />
        <SliderRow label="Corners" value={text.box.radius} min={0} max={80} step={1} format={(v) => `${v}`}
          onChange={(v) => set('Corner radius', (c) => { c.text!.box.radius = v }, 'br')} />
      </Section>

      <Section title="Knockout">
        <Row label="Knockout">
          <Switch checked={text.knockout} onCheckedChange={(v) => set(v ? 'Knockout on' : 'Knockout off', (c) => {
            c.text!.knockout = v
            if (v && c.text!.box.backgroundOpacity === 0) c.text!.box.backgroundOpacity = 1
          })} />
          <span className="text-xs text-muted-foreground">Letters reveal the video</span>
        </Row>
        {text.knockout && (
          <Row label="Plate">
            <ToggleGroup type="single" variant="outline" size="sm" value={text.box.fullFrame ? 'frame' : 'box'}
              onValueChange={(v) => v && set('Knockout plate', (c) => { c.text!.box.fullFrame = v === 'frame' })}>
              <ToggleGroupItem value="box">Box</ToggleGroupItem>
              <ToggleGroupItem value="frame">Full frame</ToggleGroupItem>
            </ToggleGroup>
          </Row>
        )}
      </Section>
    </>
  )
}
