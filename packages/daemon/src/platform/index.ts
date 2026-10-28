// The platform seam (ADR-0024 §1): every OS branch in the daemon lives under platform/, and call
// sites import from here instead of testing `process.platform`.
export {
  spawnCli,
  execFileCliSync,
  type CliSpawnOptions,
  type CliExecSyncOptions,
} from './spawn.js';
export { killTree, type KillTreeOptions, type KillTreeHandle } from './kill-tree.js';
export { workflowShell, type WorkflowShell } from './shell.js';
export { readProcInfo, type ProcInfo } from './procinfo.js';
export {
  writePrivateFile,
  mkdirPrivate,
  assertOwnerOnly,
  currentUserSid,
  AclError,
  type AclKind,
  type AclRefusal,
  type AssertOwnerOnlyOptions,
} from './acl.js';
export { execFileCli, isOnPath, nativeExeProblem, type CliExecOptions } from './spawn.js';
export { gitHooksOffArgs, gitSystemConfigEnv, nullDevice } from './git.js';
