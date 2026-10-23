// The session context, readable: one block per state, strings as markdown, arrays as bullet
// lists, objects as nested definition lists, long values clamped behind "Show more". The raw
// JSON is one click away but never the default.
import type { SessionDetail } from '@conductor/shared';
import { useState } from 'react';
import { Markdown } from './markdown.js';

const LIST_LIMIT = 8;
const SHORT_STRING = 120;
const LONG_STRING = 500;
const LONG_LINES = 8;
/** Nested lists/dls rendered before a subtree collapses to compact JSON. */
const MAX_DEPTH = 6;

export function ContextView({ context }: { context: SessionDetail['context'] }) {
  const [raw, setRaw] = useState(false);
  const states = Object.entries(context).filter(([, values]) => Object.keys(values).length > 0);
  if (states.length === 0) return <p className="muted">No context yet.</p>;
  return (
    <div className="ctx">
      {states.map(([state, values]) => (
        <div key={state} className="ctx-state">
          <h4>{state}</h4>
          <ObjectValue value={values} depth={1} />
        </div>
      ))}
      <button
        type="button"
        className="link ctx-raw-toggle"
        aria-expanded={raw}
        onClick={() => setRaw((v) => !v)}
      >
        {raw ? 'Hide raw JSON' : 'View raw JSON'}
      </button>
      {raw && <pre className="ctx-raw">{JSON.stringify(context, null, 2)}</pre>}
    </div>
  );
}

function ObjectValue({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="muted">empty</span>;
  return (
    <dl className="ctx-dl">
      {entries.map(([k, v]) => (
        <div key={k} className="ctx-row">
          <dt>{k}</dt>
          <dd>
            <Value value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Value({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined) return <span className="muted">none</span>;
  if (typeof value === 'string') return <StringValue text={value} />;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <code className="ctx-scalar">{String(value)}</code>;
  }
  if (typeof value === 'object' && depth > MAX_DEPTH) return <DeepValue value={value} />;
  if (Array.isArray(value)) return <ListValue items={value} depth={depth} />;
  if (typeof value === 'object') {
    return <ObjectValue value={value as Record<string, unknown>} depth={depth} />;
  }
  return <span className="muted">({typeof value})</span>;
}

/** Below MAX_DEPTH levels: the subtree as compact JSON, collapsed. */
function DeepValue({ value }: { value: object }) {
  const [open, setOpen] = useState(false);
  const n = Array.isArray(value) ? value.length : Object.keys(value).length;
  const what = Array.isArray(value) ? `list, ${n} items` : `${n} keys`;
  return (
    <span className="ctx-deep">
      <button
        type="button"
        className="link"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide nested value' : `Show nested value (${what})`}
      </button>
      {open && <code className="ctx-deep-json">{JSON.stringify(value)}</code>}
    </span>
  );
}

function StringValue({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  if (text === '') return <span className="muted">empty</span>;
  if (/^https?:\/\/\S+$/.test(text)) {
    return (
      <a href={text} target="_blank" rel="noreferrer">
        {text}
      </a>
    );
  }
  if (!text.includes('\n') && text.length <= SHORT_STRING) return <span>{text}</span>;
  const long = text.length > LONG_STRING || text.split('\n').length > LONG_LINES;
  return (
    <div className={`ctx-text${long && !all ? ' clamped' : ''}`}>
      <Markdown text={text} />
      {long && (
        <button
          type="button"
          className="link"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function ListValue({ items, depth }: { items: unknown[]; depth: number }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return <span className="muted">empty list</span>;
  const shown = all ? items : items.slice(0, LIST_LIMIT);
  return (
    <>
      <ul className="ctx-list">
        {shown.map((item, i) => (
          <li key={i}>
            <Value value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
      {items.length > LIST_LIMIT && (
        <button
          type="button"
          className="link"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show fewer' : `Show ${items.length - LIST_LIMIT} more`}
        </button>
      )}
    </>
  );
}
