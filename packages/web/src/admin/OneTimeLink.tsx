import { useState } from 'react';
import { useCopy } from '../components/use-copy.js';
import { formatExpiry } from './format.js';

/** ADR-0046: an invite with an email was emailed to `to`, or the send failed (copy the link). */
export interface LinkDelivery {
  to: string;
  emailed: boolean;
}

interface OneTimeLinkProps {
  /** "Invite link" or "Reset link": the dialog's name. */
  title: string;
  url: string;
  expiresAt: string;
  /** Null: no email was asked for (or a reset link): copy and pass it on, as before. */
  delivery?: LinkDelivery | null;
  onClose: () => void;
}

/**
 * An invite or reset URL, shown once (ADR-0017: the token is only ever in this response). The
 * parent keeps the URL in state only while this is open; Close drops it.
 */
export function OneTimeLink({ title, url, expiresAt, delivery = null, onClose }: OneTimeLinkProps) {
  const [failed, setFailed] = useState(false);
  const copyText = useCopy();

  // UXR-55: success is the shared "Copied" toast.
  function copy() {
    void copyText(url).then((ok) => setFailed(!ok));
  }

  return (
    <div className="one-time-link" role="dialog" aria-label={title}>
      <h3>{title}</h3>
      {delivery?.emailed === true && (
        <p className="success" role="status">
          Invite emailed to {delivery.to}.
        </p>
      )}
      {delivery?.emailed === false && (
        <p className="error" role="alert">
          Couldn't email the invite to {delivery.to}. Copy the link below and send it yourself.
        </p>
      )}
      <p>
        This link is shown once. It expires {formatExpiry(expiresAt)}. Copy it now and pass it on.
      </p>
      <div className="one-time-url">
        <input readOnly value={url} aria-label="Link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={copy}>
          Copy
        </button>
      </div>
      {failed && (
        <p className="error" role="alert">
          Couldn't copy. Select the link and copy it.
        </p>
      )}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
