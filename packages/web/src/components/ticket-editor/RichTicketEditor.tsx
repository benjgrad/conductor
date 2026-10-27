// The WYSIWYG ticket body (UX-3). Loaded lazily by TicketBodyField: this module is the only one
// that imports BlockNote, so the editor (and its CSS) is a separate chunk off the board's path.
import { BlockNoteView, type Theme } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { useCreateBlockNote } from '@blocknote/react';
import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { editorMarkdown, importMarkdown } from './markdown-io.js';
import { placeholderDecorations } from './placeholder-decorations.js';

/** Lets the field (and the form, on submit) pull the latest markdown out synchronously. */
export interface RichEditorHandle {
  /** Exports pending edits now; returns the markdown, or null if nothing was pending. */
  flush(): string | null;
}

export interface RichTicketEditorProps {
  /** Read once on mount; the editor is uncontrolled after that (mode switches remount it). */
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  ref?: Ref<RichEditorHandle>;
}

// The app's tokens (styles.css) already switch with prefers-color-scheme, so one theme serves
// light and dark. BlockNote sets these on its container and on its floating menus' portal roots.
const APP_THEME: Theme = {
  colors: {
    editor: { text: 'var(--text)', background: 'var(--panel)' },
    menu: { text: 'var(--text)', background: 'var(--panel)' },
    tooltip: { text: 'var(--text)', background: 'var(--bg)' },
    hovered: { text: 'var(--text)', background: 'var(--inline-code-bg)' },
    selected: { text: 'var(--panel)', background: 'var(--accent)' },
    disabled: { text: 'var(--muted)', background: 'var(--bg)' },
    shadow: 'var(--border)',
    border: 'var(--border)',
    sideMenu: 'var(--muted)',
  },
  borderRadius: 6,
  fontFamily: 'inherit',
};

type ViewEditor = Parameters<typeof BlockNoteView>[0]['editor'];

// Markdown export walks the whole document (a 2,000-row table takes seconds), so it runs once
// typing pauses, and right away on blur, on submit and before a mode switch (via `handle`).
const EXPORT_DELAY_MS = 250;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function RichTicketEditor({
  initialMarkdown,
  onChange,
  ref,
}: RichTicketEditorProps) {
  const editor = useCreateBlockNote({
    animations: !prefersReducedMotion(),
    extensions: [placeholderDecorations],
    domAttributes: {
      editor: { 'aria-label': 'Description', class: 'ticket-editor-content' },
    },
    // Markdown and plain-text paste go through importMarkdown, like the initial load, so `<…>`
    // text isn't dropped as HTML. Code blocks, files, VS Code and BlockNote's own clipboard keep
    // the default; so does rich HTML, which BlockNote reads faithfully.
    pasteHandler: ({ event, editor, defaultPasteHandler }) => {
      const data = event.clipboardData;
      const types = data ? [...data.types] : [];
      const inCode = editor.transact((tr) => tr.selection.$from.parent.type.spec.code === true);
      const special = ['vscode-editor-data', 'blocknote/html', 'Files'];
      if (!data || inCode || types.some((t) => special.includes(t))) return defaultPasteHandler();
      const markdown = types.includes('text/markdown')
        ? data.getData('text/markdown')
        : types.includes('text/html')
          ? null
          : data.getData('text/plain');
      if (markdown === null) return defaultPasteHandler({ prioritizeMarkdownOverHTML: false });
      editor.pasteHTML(editor.blocksToHTMLLossy(importMarkdown(editor, markdown)));
      return true;
    },
  });

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback((): string | null => {
    if (timer.current === null) return null;
    clearTimeout(timer.current);
    timer.current = null;
    const md = editorMarkdown(editor);
    onChangeRef.current(md);
    return md;
  }, [editor]);
  const schedule = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChangeRef.current(editorMarkdown(editor));
    }, EXPORT_DELAY_MS);
  }, [editor]);

  useImperativeHandle(ref, () => ({ flush }), [flush]);
  useEffect(
    () => () => {
      // Unmounting (form reset, mode switch) never writes back: the owner flushed first if it
      // wanted the text, and a late write would clobber the reset template.
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  useEffect(() => {
    editor.replaceBlocks(editor.document, importMarkdown(editor, initialMarkdown));
    // initialMarkdown is deliberately read once: see the prop's doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <BlockNoteView
      // TD-121: BlockNote 0.56's default schema doesn't satisfy its own BlockSchema constraint
      // under our exactOptionalPropertyTypes, so the view can't infer it; same object, wider type.
      editor={editor as unknown as ViewEditor}
      theme={{ light: APP_THEME, dark: APP_THEME }}
      // No emoji picker: ticket bodies don't need it, and it pulls emoji-mart (~110 kB gzip).
      emojiPicker={false}
      onChange={schedule}
      onBlur={() => void flush()}
    />
  );
}
