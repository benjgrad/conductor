import { hash, verify } from '@node-rs/argon2';

// M2-T08: password hashing (ADR-0017 §Auth: behaviour). argon2id with the OWASP baseline
// parameters; the PHC string carries them, so a hash made with weaker ones is re-hashed on the
// next successful login.

/** `Algorithm.Argon2id`: the package's enum is a `const enum`, which isolatedModules can't inline. */
const ARGON2ID = 2;

export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/**
 * Verified against when the email is unknown, so that path costs one argon2 verify like the
 * others (no enumeration by timing). Made with ARGON2_PARAMS from a random, discarded password.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$7MUB3eTw01HWVrtjkuTymA$wpM4uosQOR/C4Geb/U+MG77hKH037BkbU2pk3M+Dvw4';

export interface PasswordHasher {
  hash: (password: string) => Promise<string>;
  /** False for a wrong password and for a malformed hash. */
  verify: (phc: string, password: string) => Promise<boolean>;
  /** True when `phc` isn't argon2id v19 with at least the current parameters. */
  needsRehash: (phc: string) => boolean;
}

const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

export function needsRehash(phc: string): boolean {
  const m = PHC_RE.exec(phc);
  if (!m) return true;
  return (
    Number(m[1]) < ARGON2_PARAMS.memoryCost ||
    Number(m[2]) < ARGON2_PARAMS.timeCost ||
    Number(m[3]) < ARGON2_PARAMS.parallelism
  );
}

export const argon2Hasher: PasswordHasher = {
  hash: (password) => hash(password, { algorithm: ARGON2ID, ...ARGON2_PARAMS }),
  verify: async (phc, password) => {
    try {
      return await verify(phc, password);
    } catch {
      return false;
    }
  },
  needsRehash,
};
