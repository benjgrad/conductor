// UX-8 FR-2: the prerequisites step's checklist, per OS. help/add-a-machine.md says the same in
// prose; keep the two in step.

export type Os = 'macos' | 'linux' | 'windows';

export const OSES: readonly Os[] = ['macos', 'linux', 'windows'];

export const OS_LABELS: Record<Os, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
};

export interface Command {
  /** What it does, also the copy box's label. */
  label: string;
  command: string;
}

export interface Prerequisite {
  id: string;
  title: string;
  /** One line: why conductor needs it. */
  why: string;
  install: Record<Os, Command[]>;
  /** Extra text after the install commands (e.g. sign in), same on every OS. */
  then?: string;
  verify: Command[];
}

const NVM: Command[] = [
  {
    label: 'Install nvm',
    command: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash',
  },
  // nvm is a shell function: a terminal opened before its install doesn't have it yet.
  { label: 'Load nvm in this terminal (or open a new terminal)', command: '. ~/.nvm/nvm.sh' },
  { label: 'Install Node.js 22 with nvm', command: 'nvm install 22' },
];

const CLAUDE: Command[] = [
  { label: 'Install Claude Code', command: 'npm install -g @anthropic-ai/claude-code' },
  { label: 'Start Claude Code to sign in', command: 'claude' },
];

// MW-T11, in PowerShell. Windows needs the native claude.exe (U-110): npm's claude.cmd can't take
// the daemon's multi-line arguments, and install.ps1 refuses it.
const CLAUDE_WINDOWS: Command[] = [
  {
    label: 'Install Claude Code (native installer)',
    command: 'irm https://claude.ai/install.ps1 | iex',
  },
  { label: 'Start Claude Code to sign in', command: 'claude' },
];

export const PREREQUISITES: Prerequisite[] = [
  {
    id: 'node',
    title: 'Node.js 22 or newer',
    why: 'The daemon is a Node.js program.',
    install: {
      macos: [
        // Not node@22: that formula is keg-only, so it isn't on the PATH after installing.
        { label: 'Install Node.js with Homebrew', command: 'brew install node' },
        ...NVM,
      ],
      linux: NVM,
      windows: [
        {
          label: 'Install Node.js with winget, then open a new terminal',
          command: 'winget install OpenJS.NodeJS.LTS',
        },
      ],
    },
    verify: [{ label: 'Check Node.js (v22 or higher)', command: 'node -v' }],
  },
  {
    id: 'git',
    title: 'git',
    why: 'Sessions work in git worktrees of your repos.',
    install: {
      macos: [
        { label: 'Install git (Xcode tools)', command: 'xcode-select --install' },
        { label: 'Install git with Homebrew', command: 'brew install git' },
      ],
      linux: [{ label: 'Install git (Debian, Ubuntu)', command: 'sudo apt install git' }],
      windows: [
        {
          label: 'Install Git for Windows (with Git Bash)',
          command: 'winget install --id Git.Git -e',
        },
      ],
    },
    verify: [{ label: 'Check git', command: 'git --version' }],
  },
  {
    id: 'claude',
    title: 'Claude Code, signed in',
    why: 'The daemon runs your own Claude Code, with your settings.',
    install: { macos: CLAUDE, linux: CLAUDE, windows: CLAUDE_WINDOWS },
    then: 'In Claude Code, type /login and follow the prompts.',
    verify: [{ label: 'Check Claude Code', command: 'claude --version' }],
  },
  {
    id: 'gh',
    title: 'GitHub CLI 2.40 or newer, signed in',
    why: 'Conductor uses it to open pull requests for your tickets.',
    install: {
      macos: [
        { label: 'Install the GitHub CLI', command: 'brew install gh' },
        { label: 'Sign in to GitHub', command: 'gh auth login' },
      ],
      linux: [{ label: 'Sign in to GitHub', command: 'gh auth login' }],
      windows: [
        { label: 'Install the GitHub CLI', command: 'winget install --id GitHub.cli -e' },
        { label: 'Sign in to GitHub', command: 'gh auth login' },
      ],
    },
    verify: [
      { label: 'Check the GitHub CLI version', command: 'gh --version' },
      { label: 'Check the GitHub sign-in', command: 'gh auth status' },
    ],
  },
  {
    id: 'repos',
    title: 'A folder with your repos',
    why: 'For example ~/code. You point the daemon at it in step 4.',
    install: { macos: [], linux: [], windows: [] },
    verify: [{ label: 'List your repos folder', command: 'ls ~/code' }],
  },
];

/** Where to get gh on Linux (packages differ per distribution). */
export const GH_INSTALL_URL = 'https://github.com/cli/cli#installation';

export const DAEMON_BIN = '~/.conductor/bin/conductor-daemon';
export const ROOTS_COMMAND = `${DAEMON_BIN} config roots ~/code`;
/**
 * Signals only the daemon. The bin is a wrapper, so the running process is
 * `node ~/.conductor/daemon/current/dist/main.js` and has no `conductor-daemon` in it.
 * M2-T18 may make this exact (a process title or pid file).
 */
export const SIGHUP_COMMAND = 'pkill -HUP -f "$HOME/.conductor/daemon/current/dist/main.js"';

export interface DaemonCommands {
  /** Starts the daemon in the foreground. */
  start: string;
  roots: string;
  /** Rescans without a restart; null where there's no way yet (Windows has no SIGHUP, MW-T09). */
  rescan: string | null;
}

/**
 * Running the daemon, per OS. On Windows install.ps1 puts conductor-daemon on the PATH (that
 * PowerShell session's too), and `$HOME/code` expands in a PowerShell argument (forward slashes,
 * as in the help page, which has no backslashes).
 */
export const DAEMON_COMMANDS: Record<Os, DaemonCommands> = {
  macos: { start: DAEMON_BIN, roots: ROOTS_COMMAND, rescan: SIGHUP_COMMAND },
  linux: { start: DAEMON_BIN, roots: ROOTS_COMMAND, rescan: SIGHUP_COMMAND },
  windows: {
    start: 'conductor-daemon',
    roots: 'conductor-daemon config roots $HOME/code',
    rescan: null,
  },
};

/** What the browser runs on: Windows or Linux when it says so, else macOS. */
export function guessOs(): Os {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  // Not /win/: "darwin" has it.
  if (/windows|win32|win64/i.test(text)) return 'windows';
  return /linux/i.test(text) && !/android/i.test(text) ? 'linux' : 'macos';
}
