import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useEditor } from '@/state/store'
import { ipcMessage, setViewOpen } from './jobs'

const PROFILE = 'dev.micro-ui/jobs'
const N = {
  started: 'micro-ui-jobs/notifications/started',
  status: 'micro-ui-jobs/notifications/status',
  completed: 'micro-ui-jobs/notifications/completed',
  delivered: 'micro-ui-jobs/notifications/delivered',
}
const HOST = { name: 'trailer-v', title: 'Trailer-V', version: '0.1.0' }

export function GenerateAudioDialog() {
  const open = useEditor((s) => s.generateOpen)
  return (
    <Dialog open={open} onOpenChange={(o) => useEditor.setState({ generateOpen: o })}>
      <DialogContent className="gap-3 sm:max-w-xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Generate audio</DialogTitle>
          <DialogDescription>
            Made by YuE2 Studio on your GPU. Songs save to <span className="text-foreground/80">AI Audio</span> in your media folder; you can
            close this while it works.
          </DialogDescription>
        </DialogHeader>
        <YueView />
      </DialogContent>
    </Dialog>
  )
}

/** Hosts YuE2's MCP Apps View; the main process tracks and delivers the job independently. */
function YueView() {
  const folder = useEditor((s) => s.project?.mediaFolder ?? null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<'connecting' | 'ready' | { error: string }>('connecting')
  const [height, setHeight] = useState(320)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const frame = frameRef.current
    if (!folder || !frame) return
    let alive = true
    let viewId: string | null = null
    let bridge: AppBridge | null = null
    let offEvents: (() => void) | null = null
    setState('connecting')

    void (async () => {
      const view = await window.api.generate.openView(folder)
      viewId = view.viewId
      if (!alive) return window.api.generate.closeView(view.viewId)
      setViewOpen(view.viewId, true)
      const gen = window.api.generate
      bridge = new AppBridge(
        null,
        HOST,
        { serverTools: {}, serverResources: {}, openLinks: {}, updateModelContext: { text: {} }, experimental: { [PROFILE]: { version: '0.1.0' } } },
        { hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'desktop' } },
      )
      bridge.oncalltool = async (p) => (await gen.callTool(view.viewId, p.name, (p.arguments ?? {}) as Record<string, unknown>)) as never
      bridge.onreadresource = async (p) => (await gen.readResource(p.uri)) as never
      bridge.onupdatemodelcontext = async () => ({})
      bridge.onopenlink = async ({ url }) => {
        await gen.openLink(url)
        return {}
      }
      bridge.onsizechange = ({ height: h }) => {
        if (h) setHeight(Math.min(640, Math.max(160, Math.ceil(h))))
      }
      const loose = z.looseObject({ jobId: z.string() })
      bridge.setNotificationHandler(N.started, { params: loose }, (h) => gen.adopt(view.viewId, h))
      bridge.setNotificationHandler(N.status, { params: loose }, () => {})
      bridge.setNotificationHandler(N.completed, { params: loose.extend({ state: z.string() }) }, (c) => {
        if (c.state === 'completed') gen.deliverNow(c.jobId)
      })
      offEvents = gen.onEvent((e) => {
        if (e.type === 'delivered' && e.viewId === view.viewId) {
          void bridge?.notification({ method: N.delivered, params: { jobId: e.jobId, artifacts: e.artifacts } })
        }
      })

      const ready = new Promise<void>((r) => (bridge!.oninitialized = () => r()))
      await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!))
      frame.src = view.url // load only once the bridge is listening
      await ready
      if (!alive) return
      // No arguments: YuE2 answers input_required and its View shows the song form.
      const args = {}
      const result = await gen.callTool(view.viewId, view.startTool, args)
      await bridge.sendToolInput({ arguments: args })
      await bridge.sendToolResult(result as never)
      if (alive) setState('ready')
    })().catch((e) => alive && setState({ error: ipcMessage(e) }))

    return () => {
      alive = false
      offEvents?.()
      void bridge?.close()
      if (viewId) {
        setViewOpen(viewId, false)
        window.api.generate.closeView(viewId)
      }
    }
  }, [folder, attempt])

  if (!folder) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Choose a media folder first; generated songs are saved there.</p>
  }
  return (
    <div className="relative">
      <iframe
        ref={frameRef}
        title="YuE2 Studio"
        sandbox="allow-scripts"
        className="w-full rounded-lg border-0 bg-transparent transition-[height] duration-150"
        style={{ height, visibility: state === 'ready' ? 'visible' : 'hidden' }}
      />
      {state === 'connecting' && (
        <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
          <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Connecting to YuE2 Studio…</span>
        </div>
      )}
      {typeof state === 'object' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm">
          <AlertTriangle className="size-6 text-amber-400" />
          <p className="text-muted-foreground">{state.error}</p>
          <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        </div>
      )}
    </div>
  )
}
