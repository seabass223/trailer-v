/** TipTap setup shared by the inspector's text editor and inline editing on the preview. */
import { Extension, type Editor } from '@tiptap/core'
import { TextAlign } from '@tiptap/extension-text-align'
import { TextStyleKit } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textStyleExtras: {
      /** 400 and 700 use the plain / bold mark; other weights an explicit `font-weight`. */
      setFontWeight: (weight: number) => ReturnType
      /** Tracking in em (scales with the font size); 0 removes it. */
      setLetterSpacing: (em: number) => ReturnType
    }
  }
}

/** Effective weight at the selection, as the layout resolves it. */
export function weightAt(editor: Editor): number {
  const w = Number(editor.getAttributes('textStyle').fontWeight)
  return w > 0 ? w : editor.isActive('bold') ? 700 : 400
}

/** Letter spacing at the selection, in em. */
export function letterSpacingAt(editor: Editor): number {
  const v = editor.getAttributes('textStyle').letterSpacing as string | undefined
  return v?.endsWith('em') ? parseFloat(v) || 0 : 0
}

const styleAttr = (css: string, prop: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => el.style.getPropertyValue(css) || null,
  renderHTML: (a: Record<string, unknown>) => (a[prop] ? { style: `${css}: ${a[prop]}` } : {}),
})

/**
 * Font weight and letter spacing on the textStyle mark. Ctrl+B goes through the weight so it
 * also clears an explicit weight; Ctrl+A selects all *text* rather than the whole document, so
 * typing over it (or deleting it and typing) keeps the first run's styling and alignment.
 */
const TextStyleExtras = Extension.create({
  name: 'textStyleExtras',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: { fontWeight: styleAttr('font-weight', 'fontWeight'), letterSpacing: styleAttr('letter-spacing', 'letterSpacing') },
    }]
  },
  addCommands() {
    return {
      setFontWeight: (weight) => ({ chain }) => {
        const c = chain().setMark('textStyle', { fontWeight: weight === 400 || weight === 700 ? null : String(weight) })
        return (weight === 700 ? c.setBold() : c.unsetBold()).removeEmptyTextStyle().run()
      },
      setLetterSpacing: (em) => ({ chain }) =>
        chain().setMark('textStyle', { letterSpacing: em ? `${Math.round(em * 1000) / 1000}em` : null }).removeEmptyTextStyle().run(),
    }
  },
  addKeyboardShortcuts() {
    return {
      'Mod-b': ({ editor }) => editor.commands.setFontWeight(weightAt(editor) >= 600 ? 400 : 700),
      'Mod-a': ({ editor }) => editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 }),
    }
  },
})

export const textExtensions = () => [
  StarterKit.configure({ heading: false, blockquote: false, codeBlock: false, code: false, bulletList: false, orderedList: false, listItem: false, horizontalRule: false, link: false }),
  TextStyleKit,
  TextAlign.configure({ types: ['paragraph'], defaultAlignment: 'center' }),
  TextStyleExtras,
]
