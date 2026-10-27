// Greys the template's placeholder lines in the editor (UX-3 FR-2) with a ProseMirror decoration,
// so they stay ordinary text in the markdown (and are stripped on submit if left untouched).
import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { PLACEHOLDER_TEXTS } from './template.js';

const TEXTS = new Set<string>(PLACEHOLDER_TEXTS);
const key = new PluginKey<DecorationSet>('ticket-placeholders');

function decorate(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.content.size > 0 && TEXTS.has(node.textContent.trim())) {
      decorations.push(
        Decoration.inline(pos + 1, pos + 1 + node.content.size, { class: 'ticket-placeholder' }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const placeholderDecorations = createExtension({
  key: 'ticketPlaceholders',
  prosemirrorPlugins: [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => decorate(state.doc),
        apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
      },
      props: {
        decorations: (state) => key.getState(state),
      },
    }),
  ],
});
