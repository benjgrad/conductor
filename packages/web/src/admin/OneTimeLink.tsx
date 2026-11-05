import { useState } from 'react';
import { useCopy } from '../components/use-copy.js';
import { formatExpiry } from './format.js';

interface OneTimeLinkProps {
  /** "Invite link" or "Reset link": the dialog's name. */
  title: string;
  url: string;
  expiresAt: string;
  onClose: () => void;
}

/**
 * An invite or reset URL, shown once (ADR-0017: the token is only ever in this response). The
 * parent keeps the URL in state only while this is open; Close drops it.
 */
export function OneTimeLink({ title, url, expiresAt, onClose }: OneTimeLinkProps) {
  const [failed, setFailed] = useState(false);
  const copyText = useCopy();

  // UXR-55: success is the shared "Copied" toast.
  function copy() {
    void copyText(url).then((ok) => setFailed(!ok));
  }

  return (
    <div className="one-time-link" role="dialog" aria-label={title}>
      <h3>{title}</h3>
      <p>
        This link is shown once. It expires {formatExpiry(expiresAt)}. Copy it now and pass it on.
      </p>
      <div className="one-time-url">
        <input readOnly value={url} aria-label="Link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={copy}>
          Copy
        </button>
      </div>
      {failed && <p className="error" role="alert">Couldn't copy. Select the link and copy it.</p>}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
