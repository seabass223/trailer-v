import { useEffect } from 'react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ExportDialog } from '@/features/export/ExportDialog'
import { GenerateAudioDialog } from '@/features/generate/GenerateAudioDialog'
import { useGenerateJobs } from '@/features/generate/jobs'
import { PerfHud } from '@/features/hud/PerfHud'
import { InspectorPanel } from '@/features/inspector/InspectorPanel'
import { LibraryPanel } from '@/features/library/LibraryPanel'
import { useLibrary } from '@/features/library/useLibrary'
import { PreviewPanel } from '@/features/preview/PreviewPanel'
import { ShortcutsDialog } from '@/features/shortcuts/ShortcutsDialog'
import { useShortcuts } from '@/features/shortcuts/useShortcuts'
import { Prewarm } from '@/features/timeline/Prewarm'
import { Timeline } from '@/features/timeline/Timeline'
import { useEditor } from '@/state/store'
import { engine } from '@/engine/client'
import { TopBar } from './TopBar'

export function Editor({ onHome, onOpen }: { onHome: () => void; onOpen: (id: string) => void }) {
  const inspectorOpen = useEditor((s) => s.inspectorOpen)
  const hud = useEditor((s) => s.hud)
  useLibrary()
  useShortcuts()
  useGenerateJobs()

  useEffect(() => {
    const p = useEditor.getState().project
    if (p) {
      engine().setProject(p)
      engine().seek(0)
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-background">
      <TopBar onHome={onHome} onOpen={onOpen} />
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="58" minSize={260}>
          <ResizablePanelGroup orientation="horizontal" className="gap-0 px-2 pb-1">
            <ResizablePanel defaultSize={560} minSize={300} maxSize="45">
              <LibraryPanel />
            </ResizablePanel>
            <ResizableHandle className="mx-1 w-1 bg-transparent" />
            <ResizablePanel minSize={420}>
              <PreviewPanel />
            </ResizablePanel>
            {inspectorOpen && (
              <>
                <ResizableHandle className="mx-1 w-1 bg-transparent" />
                <ResizablePanel defaultSize={330} minSize={280} maxSize={480}>
                  <InspectorPanel />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle className="h-1 bg-transparent" />
        <ResizablePanel minSize={200}>
          <Timeline />
        </ResizablePanel>
      </ResizablePanelGroup>
      <ExportDialog />
      <GenerateAudioDialog />
      <ShortcutsDialog />
      <Prewarm />
      {hud && <PerfHud />}
    </div>
  )
}
