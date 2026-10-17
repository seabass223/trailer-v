import { AudioLines, FolderOpen, Image as ImageIcon, RotateCcw, Type, Video, X } from 'lucide-react'
import { useDeferredValue } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { deleteSelection, nextNeighbour, setCrossfade, setDuck, toggleMute, updateClip } from '@/features/editor/actions'
import { chooseMediaFolder } from '@/features/library/useLibrary'
import { formatDb } from '@/lib/utils'
import { commit, selectedClip, useEditor } from '@/state/store'
import { DEFAULT_DUCK } from '@shared/envelope'
import type { Clip, Project, Track } from '@shared/model'
import { DEFAULT_XFADE, FPS_OPTIONS } from '@shared/presets'
import { isMain, projectDuration, transitionBetween } from '@shared/timeline'
import { formatDuration, formatTimecode } from '@shared/time'
import { ColorField, Row, Section, SliderRow } from './fields'
import { TextInspector } from './TextInspector'

const KIND_ICON = { video: Video, image: ImageIcon, text: Type, audio: AudioLines }

/** An audio track's "duck under clip audio" setting. */
function DuckControls({ track, named }: { track: Track; named?: boolean }) {
  const d = { ...DEFAULT_DUCK, ...track.duck }
  const on = !!track.duck?.enabled
  return (
    <>
      <Row label={named ? track.name : 'Duck'}>
        <Switch aria-label={`Duck ${track.name} under clip audio`} checked={on} onCheckedChange={(v) => setDuck(track.id, { enabled: v })} />
        <span className="truncate text-xs text-muted-foreground">{on ? `Dips under video sound` : 'Duck under clip audio'}</span>
      </Row>
      {on && (
        <>
          <SliderRow label="Amount" value={d.amount} min={1} max={40} step={1} format={(v) => `−${v} dB`}
            onChange={(v) => setDuck(track.id, { amount: v }, 'duck-amount')} onReset={() => setDuck(track.id, { amount: DEFAULT_DUCK.amount })} />
          <SliderRow label="Attack" value={d.attack} min={0} max={2000} step={10} format={(v) => `${v} ms`}
            onChange={(v) => setDuck(track.id, { attack: v }, 'duck-attack')} onReset={() => setDuck(track.id, { attack: DEFAULT_DUCK.attack })} />
          <SliderRow label="Release" value={d.release} min={0} max={4000} step={10} format={(v) => `${v} ms`}
            onChange={(v) => setDuck(track.id, { release: v }, 'duck-release')} onReset={() => setDuck(track.id, { release: DEFAULT_DUCK.release })} />
        </>
      )}
    </>
  )
}

function ProjectInspector({ project }: { project: Project }) {
  const s = project.settings
  return (
    <>
      <Section title="Project">
        <Row label="Name">
          <Input key={project.name} defaultValue={project.name} className="h-8"
            onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && commit('Rename project', (d) => { d.name = e.target.value.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </Row>
        <Row label="Format"><span className="text-sm tabular">{s.aspect} · {s.width}×{s.height}</span></Row>
        <Row label="Frame rate">
          <Select value={String(s.fps)} onValueChange={(v) => commit(`Frame rate ${v}`, (d) => { d.settings.fps = Number(v) })}>
            <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{FPS_OPTIONS.map((f) => <SelectItem key={f} value={String(f)}>{f} fps</SelectItem>)}</SelectContent>
          </Select>
        </Row>
        <Row label="Background">
          <ColorField value={s.background} onChange={(v) => commit('Background colour', (d) => { d.settings.background = v }, { coalesceKey: 'bg' })} />
          <span className="text-xs text-muted-foreground">Behind letterboxed media</span>
        </Row>
        <Row label="Duration"><span className="text-sm tabular">{formatTimecode(projectDuration(project), s.fps)}</span></Row>
      </Section>
      <Section title="Ducking">
        {project.tracks.filter((t) => t.kind === 'audio').map((t) => <DuckControls key={t.id} track={t} named />)}
        <p className="text-xs text-muted-foreground">Lowers the audio track wherever a video clip's own sound plays. Mute a clip to keep the music up over it.</p>
      </Section>
      <Section title="Media folder">
        <button onClick={chooseMediaFolder} className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-left text-sm hover:bg-accent">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{project.mediaFolder ?? 'Choose folder…'}</span>
        </button>
      </Section>
      <Section title="History">
        <Row label="Undo levels">
          <Input type="number" min={10} max={2000} className="h-8 w-24 tabular" defaultValue={s.historyDepth}
            onBlur={(e) => {
              const v = Math.max(10, Math.min(2000, Number(e.target.value) || 200))
              if (v !== s.historyDepth) commit(`Undo levels ${v}`, (d) => { d.settings.historyDepth = v })
            }} />
        </Row>
      </Section>
      <p className="px-4 py-3 text-xs text-muted-foreground">Select a clip to edit volume, fades, transitions, position and text.</p>
    </>
  )
}

export function ClipInspector({ clip, project }: { clip: Clip; project: Project }) {
  const Icon = KIND_ICON[clip.kind]
  // Video tracks fade to a colour, or on an upper track dissolve into the video below; overlays to transparent.
  const onVideoTrack = project.tracks.find((t) => t.id === clip.trackId)?.kind === 'video'
  const upperVideo = onVideoTrack && !isMain(project, clip.trackId)
  const visual = clip.kind !== 'audio'
  const hasSound = clip.kind === 'audio' || (clip.kind === 'video' && clip.hasAudio)
  const audioTrack = project.tracks.find((t) => t.id === clip.trackId && t.kind === 'audio')
  const next = nextNeighbour(project, clip.id)
  const xfade = next ? transitionBetween(project, clip.id, next.id) : undefined
  const maxFade = Math.min(5_000_000, clip.duration)
  const set = (label: string, fn: (c: Clip) => void, key?: string) => updateClip(clip.id, label, fn, key)

  return (
    <>
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{clip.name}</div>
          <div className="text-xs tabular text-muted-foreground">
            {formatTimecode(clip.start, project.settings.fps)} · {formatDuration(clip.duration)}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="size-8" onClick={deleteSelection} aria-label="Delete clip"><X /></Button>
      </div>

      {clip.kind === 'text' && <TextInspector key={clip.id} clip={clip} />}

      {hasSound && (
        <Section title="Audio">
          <SliderRow label="Volume" value={clip.volume * 100} min={0} max={200} step={1} format={(v) => `${Math.round(v)}%`}
            onChange={(v) => set('Volume', (c) => { c.volume = v / 100 }, 'vol')} onReset={() => set('Volume', (c) => { c.volume = 1 })} />
          <Row label=""><span className="text-xs tabular text-muted-foreground">{formatDb(clip.volume)}</span></Row>
          <Row label="Mute">
            <Switch aria-label="Mute clip audio" checked={!!clip.muted} onCheckedChange={() => toggleMute([clip.id])} />
            <span className="text-xs text-muted-foreground">{clip.muted ? 'Silent in preview and export' : 'Shortcut: M'}</span>
          </Row>
          <Row label="Envelope">
            {clip.volumeKeys?.length ? (
              <>
                <span className="text-xs tabular text-muted-foreground">{clip.volumeKeys.length} point{clip.volumeKeys.length === 1 ? '' : 's'}</span>
                <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => set('Clear volume points', (c) => { delete c.volumeKeys })}>
                  <RotateCcw className="size-3" /> Clear
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Alt-click the volume line to add points</span>
            )}
          </Row>
        </Section>
      )}

      {clip.kind === 'audio' && audioTrack && (
        <Section title="Ducking">
          <DuckControls track={audioTrack} />
        </Section>
      )}

      <Section title="Fades">
        <SliderRow label="Fade in" value={clip.fadeIn.duration} min={0} max={maxFade} step={50_000} format={(v) => `${(v / 1e6).toFixed(2)}s`}
          onChange={(v) => set('Fade in', (c) => { c.fadeIn.duration = Math.min(v, c.duration - c.fadeOut.duration) }, 'fi')} />
        <SliderRow label="Fade out" value={clip.fadeOut.duration} min={0} max={maxFade} step={50_000} format={(v) => `${(v / 1e6).toFixed(2)}s`}
          onChange={(v) => set('Fade out', (c) => { c.fadeOut.duration = Math.min(v, c.duration - c.fadeIn.duration) }, 'fo')} />
        {onVideoTrack && visual ? (
          <>
            <Row label="Fade colour">
              <ColorField value={clip.fadeIn.color} onChange={(v) => set('Fade-in colour', (c) => { c.fadeIn.color = v }, 'fic')} />
              <span className="text-xs text-muted-foreground">in</span>
              <ColorField value={clip.fadeOut.color} onChange={(v) => set('Fade-out colour', (c) => { c.fadeOut.color = v }, 'foc')} />
              <span className="text-xs text-muted-foreground">out</span>
            </Row>
            {upperVideo && <p className="text-xs text-muted-foreground">Over another video, fades dissolve into it. The colour shows only where nothing is below.</p>}
          </>
        ) : (
          visual && <p className="text-xs text-muted-foreground">Overlays fade to transparent.</p>
        )}
      </Section>

      {next && clip.kind !== 'audio' && (
        <Section title="Transition to next">
          <Row label="Cross-fade">
            <Switch checked={!!xfade} onCheckedChange={(v) => setCrossfade(clip.id, next.id, v ? Math.min(DEFAULT_XFADE, clip.duration, next.duration) : null)} />
            <span className="truncate text-xs text-muted-foreground">into {next.name}</span>
          </Row>
          {xfade && (
            <SliderRow label="Duration" value={xfade.duration} min={100_000} max={Math.min(clip.duration, next.duration)} step={50_000}
              format={(v) => `${(v / 1e6).toFixed(2)}s`} onChange={(v) => setCrossfade(clip.id, next.id, v)} />
          )}
        </Section>
      )}

      {visual && (
        <Section title="Transform" action={
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground"
            onClick={() => set('Reset transform', (c) => { c.transform = { ...c.transform, x: 0, y: 0, scale: 1 } })}>
            <RotateCcw className="size-3" /> Reset
          </Button>
        }>
          {clip.kind !== 'text' && (
            <Row label="Fit">
              <ToggleGroup type="single" variant="outline" size="sm" value={clip.transform.fit}
                onValueChange={(v) => v && set(v === 'cover' ? 'Fill frame' : 'Fit frame', (c) => { c.transform.fit = v as 'contain' | 'cover' })}>
                <ToggleGroupItem value="contain">Fit</ToggleGroupItem>
                <ToggleGroupItem value="cover">Fill</ToggleGroupItem>
              </ToggleGroup>
            </Row>
          )}
          <SliderRow label="Scale" value={clip.transform.scale * 100} min={10} max={400} step={1} format={(v) => `${Math.round(v)}%`}
            onChange={(v) => set('Scale', (c) => { c.transform.scale = v / 100 }, 'sc')} onReset={() => set('Scale', (c) => { c.transform.scale = 1 })} />
          <SliderRow label="Position X" value={clip.transform.x * 100} min={-100} max={100} step={0.5} format={(v) => `${v.toFixed(1)}%`}
            onChange={(v) => set('Position', (c) => { c.transform.x = v / 100 }, 'px')} onReset={() => set('Position', (c) => { c.transform.x = 0 })} />
          <SliderRow label="Position Y" value={clip.transform.y * 100} min={-100} max={100} step={0.5} format={(v) => `${v.toFixed(1)}%`}
            onChange={(v) => set('Position', (c) => { c.transform.y = v / 100 }, 'py')} onReset={() => set('Position', (c) => { c.transform.y = 0 })} />
        </Section>
      )}
    </>
  )
}

export function InspectorPanel() {
  // Deferred: switching the inspector (mounting its controls) must never delay the frame that
  // starts a drag on the timeline; React renders it in an interruptible background pass.
  const project = useDeferredValue(useEditor((s) => s.project))
  const clip = useDeferredValue(useEditor(selectedClip))
  const count = useDeferredValue(useEditor((s) => s.selection.length))
  if (!project) return null
  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-xl bg-panel">
      <div className="flex h-11 shrink-0 items-center border-b px-4 text-sm font-medium">
        {clip ? 'Clip' : count > 1 ? `${count} clips selected` : 'Project'}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {clip ? (
          <ClipInspector clip={clip} project={project} />
        ) : count > 1 ? (
          <div className="grid gap-3 p-4">
            <p className="text-sm text-muted-foreground">Select a single clip to edit its settings.</p>
            <Button variant="secondary" onClick={deleteSelection}>Delete {count} clips</Button>
          </div>
        ) : (
          <ProjectInspector project={project} />
        )}
      </div>
    </aside>
  )
}
