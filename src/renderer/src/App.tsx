import { useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { engine } from '@/engine/client'
import { startAutomation } from '@/features/automation/automation'
import { Editor } from '@/features/editor/Editor'
import { HomeScreen } from '@/features/home/HomeScreen'
import { flushSave, savePoster, startSync } from '@/state/persistence'
import { closeProject, loadProject, useEditor } from '@/state/store'
import { toast } from 'sonner'

export function App() {
  const project = useEditor((s) => s.project)
  const [opening, setOpening] = useState(false)

  useEffect(() => startSync(), [])
  // Serve the in-app MCP server's editor calls (src/main/mcp).
  useEffect(() => startAutomation(), [])
  // Warm the GPU device, decoders' worker and audio graph while the user is on the home screen.
  useEffect(() => void engine(), [])
  useEffect(() => {
    void window.api.fonts.list().then((fonts) => useEditor.setState({ fonts }))
    void window.api.encoder.caps().then((caps) => useEditor.setState({ caps }))
  }, [])

  const open = async (id: string) => {
    setOpening(true)
    try {
      loadProject(await window.api.projects.read(id))
    } catch (e) {
      toast.error(`Couldn't open project: ${(e as Error).message}`)
    } finally {
      setOpening(false)
    }
  }

  const goHome = async () => {
    await savePoster().catch(() => {})
    await flushSave()
    closeProject()
  }

  return (
    <TooltipProvider delayDuration={400}>
      {project ? <Editor onHome={goHome} onOpen={open} /> : <HomeScreen onOpen={open} busy={opening} />}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
