// ADR-0024 §5: how the daemon runs git on each OS. Call sites import these instead of testing
// `process.platform`.
//
// - Hooks off: `core.hooksPath` points at the null device, where no hook file can exist. On win32
//   that must be `NUL`: Git for Windows reads `/dev/null` as the drive-relative `C:\dev\null`,
//   which any local user may create, so a planted `C:\dev\null\pre-push` would run.
// - System config: POSIX drops it (`GIT_CONFIG_NOSYSTEM`). win32 keeps it: it lives under Program
//   Files (admin-writable only) and carries Git for Windows' `credential.helper=manager`,
//   `http.sslBackend=schannel` and corporate CAs, without which `open_pr` can't push.

const isWin32 = (): boolean => process.platform === 'win32';

/** The null device for `core.hooksPath`: `NUL` on win32, `/dev/null` elsewhere. */
export function nullDevice(): string {
  return isWin32() ? 'NUL' : '/dev/null';
}

/** `git -c` args that turn every hook off. */
export function gitHooksOffArgs(): string[] {
  return ['-c', `core.hooksPath=${nullDevice()}`];
}

/** Env added to every daemon git/gh run: drop the system gitconfig on POSIX only. */
export function gitSystemConfigEnv(): Record<string, string> {
  return isWin32() ? {} : { GIT_CONFIG_NOSYSTEM: '1' };
}
