/** TipTap setup shared by the inspector's text editor and inline editing on the preview. */
import { Extension } from '@tiptap/core'
import { TextAlign } from '@tiptap/extension-text-align'
import { TextStyleKit } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'

/**
 * Ctrl+A selects all *text* rather than the whole document, so typing over it (or deleting it
 * and typing) keeps the first run's font, size and colour and the paragraph alignment.
 */
const SelectAllText = Extension.create({
  name: 'selectAllText',
  addKeyboardShortcuts() {
    return {
      'Mod-a': ({ editor }) => editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 }),
    }
  },
})

export const textExtensions = () => [
  StarterKit.configure({ heading: false, blockquote: false, codeBlock: false, code: false, bulletList: false, orderedList: false, listItem: false, horizontalRule: false, link: false }),
  TextStyleKit,
  TextAlign.configure({ types: ['paragraph'], defaultAlignment: 'center' }),
  SelectAllText,
]
