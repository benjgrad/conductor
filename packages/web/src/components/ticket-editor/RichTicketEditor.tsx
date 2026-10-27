// The WYSIWYG ticket body (UX-3). Loaded lazily by TicketBodyField: this module is the only one
// that imports BlockNote, so the editor (and its CSS) is a separate chunk off the board's path.
import { BlockNoteView, type Theme } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { useCreateBlockNote } from '@blocknote/react';
import { useCallback, useEffect, useRef } from 'react';
import { editorMarkdown } from './markdown-io.js';
import { placeholderDecorations } from './placeholder-decorations.js';

export interface RichTicketEditorProps {
  /** Read once on mount; the editor is uncontrolled after that (mode switches remount it). */
  initialMarkdown: string;
  onChange: (markdown: string) => void;
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
// typing pauses, and right away on blur (before a submit click lands) and on unmount.
const EXPORT_DELAY_MS = 250;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function RichTicketEditor({ initialMarkdown, onChange }: RichTicketEditorProps) {
  const editor = useCreateBlockNote({
    animations: !prefersReducedMotion(),
    extensions: [placeholderDecorations],
    domAttributes: {
      editor: { 'aria-label': 'Description', class: 'ticket-editor-content' },
    },
  });

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    onChangeRef.current(editorMarkdown(editor));
  }, [editor]);
  const schedule = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChangeRef.current(editorMarkdown(editor));
    }, EXPORT_DELAY_MS);
  }, [editor]);
  useEffect(() => flush, [flush]);

  useEffect(() => {
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(initialMarkdown));
    // initialMarkdown is deliberately read once: see the prop's doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <BlockNoteView
      // TD: BlockNote 0.56's default schema doesn't satisfy its own BlockSchema constraint under
      // our exactOptionalPropertyTypes, so the view can't infer it; same object, wider type.
      editor={editor as unknown as ViewEditor}
      theme={{ light: APP_THEME, dark: APP_THEME }}
      onChange={schedule}
      onBlur={flush}
    />
  );
}
