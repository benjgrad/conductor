import type { EnrollmentTokenCreated, MachineDetail } from '@conductor/shared';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { SETUP_GUIDE_URL } from '../machines/format.js';
import '../machines/machines.css';
import './onboarding.css';
import { Done, Install, Prerequisites, RepoCaps, WaitForMachine } from './steps.js';

const STEPS = [
  'Check the prerequisites',
  'Install and enroll',
  'Connect',
  'Repos and checks',
  'Done',
] as const;

interface SetupGuideProps {
  api: ApiClient;
  /** True when the account has no machines yet: the first-run wording. */
  first: boolean;
  /** "I'll do this later". */
  onDismiss: () => void;
  /** The done step's "Create your first ticket". */
  onCreateTicket: () => void;
  /** The done step's link to the Machines page. */
  onFinish: () => void;
}

/**
 * UX-8: the guided setup of a machine, from prerequisites to "ready to take tickets". The
 * one-time install command lives only in this component's state (NFR-2): it is never stored,
 * logged or put in a URL, and it is gone once the guide unmounts.
 */
export function SetupGuide({ api, first, onDismiss, onCreateTicket, onFinish }: SetupGuideProps) {
  const [step, setStep] = useState(0);
  const [enrollment, setEnrollment] = useState<EnrollmentTokenCreated | null>(null);
  /** The account's machine ids when the guide opened: only a machine not in it is "new". */
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const [machine, setMachine] = useState<MachineDetail | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.listMachines().then(
      (rows) => {
        if (!cancelled) setBaseline(new Set(rows.map((r) => r.id)));
      },
      () => {
        if (!cancelled) setBaseline(new Set());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    // Move focus to the new step's heading, but not on first render (don't steal focus).
    if (moved.current) heading.current?.focus();
  }, [step]);

  function goTo(next: number) {
    moved.current = true;
    setStep(Math.max(0, Math.min(STEPS.length - 1, next)));
  }

  const title = first ? 'Set up your first machine' : 'Add a machine';

  return (
    <section className="setup-guide" aria-labelledby="setup-guide-title">
      <header className="setup-head">
        <h2 id="setup-guide-title">{title}</h2>
        <button type="button" onClick={onDismiss}>
          I'll do this later
        </button>
      </header>
      <p className="setup-intro">
        Conductor runs Claude Code on your own computers. Each one runs the <b>daemon</b>: a small
        background program that runs Claude Code on this machine for conductor. This takes about 10
        minutes.{' '}
        <a href={SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
          Read the full guide ↗
        </a>
      </p>

      <nav aria-label="Setup steps">
        <ol className="setup-steps">
          {STEPS.map((name, i) => (
            <li key={name} className={i < step ? 'setup-step-done' : undefined}>
              <button
                type="button"
                aria-current={i === step ? 'step' : undefined}
                onClick={() => goTo(i)}
              >
                <span className="setup-step-num" aria-hidden="true">
                  {i < step ? '✓' : i + 1}
                </span>{' '}
                {name}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <p className="visually-hidden" role="status" aria-live="polite">
        {`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
      </p>

      <div className="setup-body">
        <h3 ref={heading} tabIndex={-1}>
          {`${step + 1}. ${STEPS[step]}`}
        </h3>
        {step === 0 && <Prerequisites />}
        {step === 1 && <Install api={api} enrollment={enrollment} onEnrollment={setEnrollment} />}
        {step === 2 && (
          <WaitForMachine
            api={api}
            baseline={baseline}
            machine={machine}
            onFound={setMachine}
            onNewCommand={() => goTo(1)}
          />
        )}
        {step === 3 && (
          <RepoCaps api={api} machine={machine} onMachine={setMachine} onConnect={() => goTo(2)} />
        )}
        {step === 4 && <Done onCreateTicket={onCreateTicket} onFinish={onFinish} />}
      </div>

      <div className="setup-nav">
        {step > 0 && (
          <button type="button" onClick={() => goTo(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS.length - 1 && (
          <button type="button" className="primary" onClick={() => goTo(step + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  );
}
