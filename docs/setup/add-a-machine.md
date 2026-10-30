<!--
  A copy of packages/web/src/help/add-a-machine.md, which the web app shows at /help/add-a-machine
  (UX-8). Edit that file and copy it here; a test keeps the two identical. In the examples,
  https://conductor.example.com stands for your conductor server (e.g. https://conductor.gradyserver.com);
  the web page shows its own address instead.
-->

# Add a machine

Conductor runs Claude Code on your own computers. Each one runs the **daemon**: a small background program that runs Claude Code on this machine for conductor. This guide takes one computer from nothing to "online and ready to take tickets". It takes about 10 minutes.

In the examples, `https://conductor.example.com` is this conductor server. macOS, Linux and Windows 10 or 11 are supported. On Windows, run every command in PowerShell.

## 1. Prerequisites

You need five things on the computer. Install what's missing, then run each check in a terminal.

### On macOS

- **Node.js 22 or newer** runs the daemon. Install it with Homebrew: `brew install node`. Or use nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`, then open a new terminal (or run `. ~/.nvm/nvm.sh`) and run `nvm install 22`. Check: `node -v` prints v22 or higher.
- **git** works on your repos. Install it with `xcode-select --install` or `brew install git`. Check: `git --version`.
- **Claude Code**, installed and signed in: the daemon runs your own Claude Code with your settings. Install it with `npm install -g @anthropic-ai/claude-code`, run `claude`, then type `/login`. Check: `claude --version`.
- **GitHub CLI 2.40 or newer**, signed in: conductor uses it to open pull requests. Install it with `brew install gh`, then run `gh auth login`. Check: `gh --version` and `gh auth status`.
- **A folder with your repos**, for example `~/code`. You tell the daemon about it in step 4. Check: `ls ~/code`.

### On Linux

- **Node.js 22 or newer** runs the daemon. Install it with nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`, then open a new terminal (or run `. ~/.nvm/nvm.sh`) and run `nvm install 22`. Check: `node -v` prints v22 or higher.
- **git** works on your repos. Install it with your package manager, for example `sudo apt install git`. Check: `git --version`.
- **Claude Code**, installed and signed in: the daemon runs your own Claude Code with your settings. Install it with `npm install -g @anthropic-ai/claude-code`, run `claude`, then type `/login`. Check: `claude --version`.
- **GitHub CLI 2.40 or newer**, signed in: conductor uses it to open pull requests. Install it as shown on [cli.github.com](https://cli.github.com/), then run `gh auth login`. Check: `gh --version` and `gh auth status`.
- **A folder with your repos**, for example `~/code`. You tell the daemon about it in step 4. Check: `ls ~/code`.

### On Windows

- **Node.js 22 or newer** runs the daemon. Install it with `winget install OpenJS.NodeJS.LTS`, then open a new PowerShell window. Check: `node -v` prints v22 or higher.
- **Git for Windows** works on your repos. It includes Git Bash, which Claude Code and conductor need. Install it with `winget install --id Git.Git -e`. Check: `git --version`.
- **Claude Code, the native install**, signed in. Install it with `irm https://claude.ai/install.ps1 | iex`, run `claude`, then type `/login`. The npm package (`claude.cmd`) doesn't work with conductor on Windows: the installer refuses it. Check: `claude --version`, and `(Get-Command claude).Source` ends in `claude.exe`.
- **GitHub CLI 2.40 or newer**, signed in. Install it with `winget install --id GitHub.cli -e`, then run `gh auth login`. Check: `gh --version` and `gh auth status`.
- **A folder with your repos**, for example `~/code` (in your user folder). Check: `ls ~/code`.

### Optional

Agents use the tools you have signed in to on this computer. If your tickets need them, also set up the Azure CLI (`az login`) and a Jira CLI or a Jira MCP server in Claude Code. The daemon reports which of these it found (step 5).

## 2. Install and enroll

In conductor, open **Machines** and press **Add a machine** (or follow the guided setup from **Add a machine** in the top bar). You get a one-time install command like this:

```
curl -fsSL https://conductor.example.com/install.sh | sh -s -- --token <one-time token>
```

Run it in a terminal on the computer. The command is shown once, works once, and expires after 30 minutes. If it expires, generate a new one.

What the installer does:

- downloads the daemon and checks its SHA-256 fingerprint before installing anything;
- installs it in `~/.conductor` (no sudo, nothing outside your home folder);
- enrolls the computer: it connects it to your conductor account.

It installs none of the prerequisites. If something is missing, it lists what and stops.

On macOS and Linux, add `--service` to the end of the command to also start the daemon at login (step 3):

```
curl -fsSL https://conductor.example.com/install.sh | sh -s -- --token <one-time token> --service
```

At the end it suggests adding `~/.conductor/bin` to your PATH, for example in `~/.zshrc` or `~/.profile`:

```
export PATH="$HOME/.conductor/bin:$PATH"
```

### On Windows

Choose the **Windows** tab. The command runs in PowerShell and looks like this:

```
$env:CONDUCTOR_ENROLL_TOKEN='<one-time token>'; irm https://conductor.example.com/install.ps1 | iex
```

It does the same as on macOS and Linux. It installs in the `.conductor` folder in your user folder, without administrator rights, and makes that folder private to you. It also adds `conductor-daemon` to your PATH, for this PowerShell window and new ones. The token is passed to enrollment and then removed from the window.

## 3. Start the daemon

Start it in a terminal and keep that terminal open:

```
~/.conductor/bin/conductor-daemon
```

On Windows, run `conductor-daemon` in PowerShell.

It prints what it does in that terminal. Stop it with Ctrl-C.

### Start it at login (macOS and Linux)

Instead of a terminal, let your computer run the daemon in the background. It starts at login and restarts if it crashes. No sudo is needed:

```
~/.conductor/bin/conductor-daemon service install
```

On macOS this adds a launch agent (`~/Library/LaunchAgents/com.conductor.daemon.plist`), and the daemon writes to `~/.conductor/logs/daemon.log`. On Linux it adds a systemd user service (`~/.config/systemd/user/conductor-daemon.service`), and the log is in `journalctl --user -u conductor-daemon`. On Linux, to keep it running while you are logged out, also run `loginctl enable-linger "$USER"`.

The service remembers the Node.js you installed it with and your PATH at that moment (so it finds `claude`, `git` and `gh`). If `node -v` in your terminal is older than 22, choose Node 22 yourself: with nvm, `CONDUCTOR_NODE="$(nvm which 22)" ~/.conductor/bin/conductor-daemon service install`. After you change Node.js or move a tool, run `service install` again.

Other commands: `service status` (is it running, and where is the log), `service restart`, and `service uninstall` (stops it and removes the service). Windows has no service yet: keep the PowerShell window open.

## 4. Tell it where your repos are

The daemon looks for git repos under its repo roots. Set yours (one or more folders):

```
~/.conductor/bin/conductor-daemon config roots ~/code
```

A running daemon rescans every 10 minutes. To apply the change now, restart it: press Ctrl-C in its terminal, then start it again with `~/.conductor/bin/conductor-daemon`.

Or, without restarting, send it a hang-up signal. This signals only the conductor daemon:

```
pkill -HUP -f "$HOME/.conductor/daemon/current/dist/main.js"
```

If the daemon runs as a service, restart it with `~/.conductor/bin/conductor-daemon service restart`.

To see the current settings, run `~/.conductor/bin/conductor-daemon config show`.

### Per-repo mode

Agents always work in their own git worktrees, never in your folder itself. By default (mode `reference`) those worktrees come from a separate clone the daemon keeps, which borrows objects from your repo, so your repo's `.git` folder is never touched. For a repo where you'd rather have worktrees of your own checkout (for example a personal project, so the branches show up in it), turn that on per repo:

```
~/.conductor/bin/conductor-daemon config repo ~/code/my-app --mode checkout
```

The risk: in `checkout` mode the worktrees share your repo's `.git/config` and hooks, so an agent could change them, and a planted hook would later run when you use the repo yourself. The daemon watches both and raises an alert when they change. Use it only for repos you are happy to share that way. Set it back with `--mode reference`.

On Windows, set the roots with `conductor-daemon config roots $HOME/code`. Windows has no hang-up signal, so restart the daemon to apply the change now.

## 5. Check that it's online

Open **Machines** in conductor. Your computer shows as **online** within a few seconds of starting the daemon. Press **Details** to see what it reported:

- **Repos**: the repos it found under your repo roots. A repo without a remote can't take tickets.
- **Capabilities**: claude, and gh with its version and whether it's signed in. Pull requests need gh 2.40 or newer, signed in.

It reports repo paths and remotes, and the names and versions of the tools it found. It never reports secrets, tokens, account names or the contents of your files.

## Upgrade

Run the install command from **Add a machine** again, without a token: `curl -fsSL https://conductor.example.com/install.sh | sh`. It installs the new version next to the old one and keeps the enrollment. If the daemon runs as a service, it restarts on the new version by itself. Otherwise restart it yourself.

## Troubleshooting

- **The machine never shows up.** Is the daemon running? Look at the terminal from step 3. If you closed it, start the daemon again. As a service, run `~/.conductor/bin/conductor-daemon service status` and read the log it names.
- **"enrollment token is expired, already used or unknown" (HTTP 401).** The token is valid once, for 30 minutes. Generate a new one on the Machines page and run the command again.
- **"ws closed 4001" or "machine revoked".** Someone revoked this machine. The daemon stops, and the service doesn't restart it (it exits with code 78). To use the computer again, add it as a new machine: generate a token, run `CONDUCTOR_ENROLL_TOKEN=<token> ~/.conductor/bin/conductor-daemon enroll --url https://conductor.example.com --force`, then `~/.conductor/bin/conductor-daemon service restart`.
- **"ws closed 4005" or "protocol version not supported".** The daemon is too old for this server. Upgrade it (see Upgrade); the service starts again on the new version.
- **The service starts and stops at once.** Read the log (`service status` names it). Exit code 78 means the machine's credential was refused or revoked: enroll again as above.
- **Node.js is too old or missing.** Run `node -v` in the same terminal as the daemon. It must be 22 or newer and on that terminal's PATH (with nvm, run `nvm use 22` first).
- **The install command failed with "enrollment failed".** The command expired or was already used. Generate a new one on the Machines page and run it again; the daemon is already installed, so this is quick.
- **"missing prerequisites".** The installer lists what's missing. Install it (step 1) and run the command again.
- **A company proxy or firewall.** The daemon needs an outgoing WebSocket connection (wss) to this server, `https://conductor.example.com`. Ask your IT team to allow it.
- **Reading the daemon's output.** The daemon prints its errors in the terminal it runs in. Copy the last lines when you ask for help.
- **Windows: "the native Claude Code (claude.exe) is required".** `claude` is npm's `claude.cmd`. Install the native Claude Code (step 1). If both are installed, uninstall the npm one with `npm uninstall -g @anthropic-ai/claude-code`.
- **Windows: "Git Bash is required".** Install Git for Windows (step 1). If it's in an unusual folder, set `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe`.
- **Pull requests don't open.** Run `gh auth status`. If it says you aren't signed in, run `gh auth login`. If `gh --version` is older than 2.40, upgrade gh.

## Stuck agent?

When an agent stops without finishing (it crashed, timed out, or failed too many times), its ticket moves to **Needs input** with a question like *"implement: the agent exited (exit code 1: No conversation found with session ID: …) without calling complete_state"*. The text in brackets is how the agent's process ended, followed by the last line it printed as an error. That line usually says what went wrong.

Open the ticket and choose one:

- **Retry** (or reply in the box) sends the agent back to work in the same conversation, with your reply as its next message. Use it when the problem is fixed or was a one-off (a network blip, a check that failed once).
- **Start fresh conversation…** starts the agent over with its instructions and your message, without its earlier chat. The ticket's branch and worktree stay as they are. Use it when the agent can't resume: its conversation was on another machine, or it keeps failing on start (the same error after every Retry). Say in your message what it had done so far, since it won't remember. On a failure this button is shown first.

If the question says a machine stopped responding or is offline, open **Machines** and check that machine is **online**. If it isn't, start its daemon again (step 3). Once it's back, the **Continue on …** button picks up where the agent left off.

## Remove a machine

1. Stop the daemon (Ctrl-C in its terminal, or `~/.conductor/bin/conductor-daemon service uninstall` if it runs as a service).
2. Delete its files: `rm -rf ~/.conductor`. On Windows: `Remove-Item -Recurse -Force ~/.conductor`, then remove its `bin` folder from your PATH (Settings, "Edit environment variables for your account").
3. In conductor, open **Machines** and press **Revoke** on the machine. It disconnects at once and can't reconnect. Any session running on it goes to you as Needs input.

You can do these in any order. To use the computer again later, add it as a new machine.
