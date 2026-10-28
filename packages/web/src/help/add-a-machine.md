# Add a machine

Conductor runs Claude Code on your own computers. Each one runs the **daemon**: a small background program that runs Claude Code on this machine for conductor. This guide takes one computer from nothing to "online and ready to take tickets". It takes about 10 minutes.

In the examples, `https://conductor.example.com` is this conductor server. macOS and Linux are supported. Windows isn't yet.

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

At the end it suggests adding `~/.conductor/bin` to your PATH, for example in `~/.zshrc` or `~/.profile`:

```
export PATH="$HOME/.conductor/bin:$PATH"
```

## 3. Start the daemon

Start it in a terminal and keep that terminal open:

```
~/.conductor/bin/conductor-daemon
```

It prints what it does in that terminal. Stop it with Ctrl-C. Starting it automatically at login is coming soon.

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

To see the current settings, run `~/.conductor/bin/conductor-daemon config show`.

## 5. Check that it's online

Open **Machines** in conductor. Your computer shows as **online** within a few seconds of starting the daemon. Press **Details** to see what it reported:

- **Repos**: the repos it found under your repo roots. A repo without a remote can't take tickets.
- **Capabilities**: claude, and gh with its version and whether it's signed in. Pull requests need gh 2.40 or newer, signed in.

It reports repo paths and remotes, and the names and versions of the tools it found. It never reports secrets, tokens or account names.

## Troubleshooting

- **The machine never shows up.** Is the daemon running? Look at the terminal from step 3. If you closed it, start the daemon again.
- **Node.js is too old or missing.** Run `node -v` in the same terminal as the daemon. It must be 22 or newer and on that terminal's PATH (with nvm, run `nvm use 22` first).
- **The install command failed with "enrollment failed".** The command expired or was already used. Generate a new one on the Machines page and run it again; the daemon is already installed, so this is quick.
- **"missing prerequisites".** The installer lists what's missing. Install it (step 1) and run the command again.
- **A company proxy or firewall.** The daemon needs an outgoing WebSocket connection (wss) to this server, `https://conductor.example.com`. Ask your IT team to allow it.
- **Reading the daemon's output.** The daemon prints its errors in the terminal it runs in. Copy the last lines when you ask for help.
- **Pull requests don't open.** Run `gh auth status`. If it says you aren't signed in, run `gh auth login`. If `gh --version` is older than 2.40, upgrade gh.

## Stuck agent?

When an agent stops without finishing (it crashed, timed out, or failed too many times), its ticket moves to **Needs input** with a question like *"implement: the agent exited (exit code 1: No conversation found with session ID: …) without calling complete_state"*. The text in brackets is how the agent's process ended, followed by the last line it printed as an error. That line usually says what went wrong.

Open the ticket and choose one:

- **Retry** (or reply in the box) sends the agent back to work in the same conversation, with your reply as its next message. Use it when the problem is fixed or was a one-off (a network blip, a check that failed once).
- **Start fresh conversation…** starts the agent over with its instructions and your message, without its earlier chat. The ticket's branch and worktree stay as they are. Use it when the agent can't resume: its conversation was on another machine, or it keeps failing on start (the same error after every Retry). Say in your message what it had done so far, since it won't remember. On a failure this button is shown first.

If the question says a machine stopped responding or is offline, open **Machines** and check that machine is **online**. If it isn't, start its daemon again (step 3). Once it's back, the **Continue on …** button picks up where the agent left off.

## Remove a machine

1. Stop the daemon (Ctrl-C in its terminal).
2. Delete its files: `rm -rf ~/.conductor`.
3. In conductor, open **Machines** and press **Revoke** on the machine. It disconnects at once and can't reconnect. Any session running on it goes to you as Needs input.

You can do these in any order. To use the computer again later, add it as a new machine.
