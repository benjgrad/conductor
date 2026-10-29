# MR-T01 spike: Rust daemon risk probes

Throwaway code ([ADR-0026](../../docs/adr/0026-rust-daemon.md) §5, milestone MR). It is outside every workspace,
lint and typecheck, and it is never shipped. It tests the three risky parts of a Rust daemon before any port work:

| Probe | What | Answers |
|---|---|---|
| `ws-probe` | register (protocol 2) → `registered` → 3 heartbeats → clean close, against the real orchestrator, with an enrolled machine credential | FR-1 |
| `mcp-probe` | an `rmcp` streamable-HTTP outcome server on `/mcp/<token>`, called by fake-claude, by a call held 65 s, and (opt-in) by real `claude -p` | FR-2, **U-113** |
| `job-probe` | a kill-on-close Job Object kills `cmd /c` → `node` → `node` (exits) → detached `node` grandchild (reparented) | FR-3, **U-116** |

## Verdicts

- **WS / tokio-tungstenite: GO.** Hand-written serde frames were accepted by the real gateway in password mode. A wrong credential is refused with 401 at the upgrade.
- **U-113 (rmcp maturity): GO, with one condition: the real-claude run.** `rmcp` 3.8.0 covers everything the TS outcome server does:
  - stateless JSON replies;
  - a per-session path, with a 404 for an unknown token;
  - Host-header DNS-rebinding protection (403), built in;
  - `_meta` on tools (`anthropic/alwaysLoad`);
  - a call held for 65 s while other calls on the same token answer in 2 ms.

  fake-claude, which uses the official TS MCP SDK client, completes `complete_state` against it. ADR-0026 asks for real `claude -p` too, and that run spends money, so it is opt-in. **It has not been run yet.** Run `E2E_REAL_CLAUDE=1 ./target/release/mcp-probe --skip-hold`. If it fails, ADR-0026 §5's axum fallback applies.
- **U-116 (Job Objects): GO if the `spike-rust-daemon` workflow is green on `windows-latest`.** Variants a, b and c must leave no survivor. Variant d records the `taskkill /T` gap (TD-189) for comparison. The Windows code was written against `windows-sys` 0.61.2 and has only been compiled by that workflow; no Windows machine was used. See [the workflow run](../../.github/workflows/spike-rust-daemon.yml) on the MR-T01 PR for the log.

## How to run

Requirements: Rust stable (B-005), Node 22 and `pnpm i` at the repo root, because fake-claude imports `@modelcontextprotocol/sdk`.

```bash
cd spikes/rust-daemon
cargo build --release
./target/release/mcp-probe                     # --hold-secs 65 by default; --skip-hold to iterate
E2E_REAL_CLAUDE=1 ./target/release/mcp-probe   # + real `claude -p --model haiku` (spends cents)
./target/release/job-probe                     # Windows: asserted; Linux/macOS: the process-group contrast
scripts/run-ws-probe.sh                        # needs the dev Postgres (pnpm db:up), see below
```

`scripts/run-ws-probe.sh` does the following:
1. Creates a throwaway database on the dev server (`scripts/db.sh url`) and migrates it.
2. Runs `pnpm typecheck` (that emits `packages/orchestrator/dist`).
3. Starts the real orchestrator with `CONDUCTOR_AUTH=password` and `CONDUCTOR_PUBLIC_URL=http://127.0.0.1:7499`.
4. Inserts an `enrollment_token` row. No CLI mints one, and the REST route needs a signed-in user.
5. Enrolls through the real `POST /api/machines/enroll`.
6. Runs `ws-probe` twice: once with the credential, once with a wrong one.
7. Prints the `machine` row.

Everything is torn down on exit. SQL goes through `scripts/pg.mjs`, which uses the orchestrator's `pg`, so `psql` isn't needed.

The `spike-rust-daemon` workflow runs `fmt`, `clippy -D warnings`, a release build, `job-probe` and `mcp-probe --hold-secs 65` on `windows-latest` and `ubuntu-latest`. It writes the binary sizes to the job summary. `ws-probe` is built there but not run, because it needs Postgres.

## Versions

rustc 1.99.1 (stable, 2026-10-13). Release profile: `strip = true`, `lto = "thin"`, `codegen-units = 1`.

| crate | version | notes |
|---|---|---|
| rmcp | 3.8.0 | features `server`, `macros`, `transport-streamable-http-server` |
| axum | 0.8.9 | the router in front of the per-token rmcp services |
| tokio | 1.54.1 | |
| tokio-tungstenite | 0.30.0 | `rustls-tls-webpki-roots` (rustls 0.23.46, aws-lc-rs provider) |
| reqwest | 0.13.5 | no TLS: only the probe's raw loopback client |
| schemars | 1.2.3 | the tool input schemas |
| windows-sys | 0.61.2 | `Win32_System_JobObjects`, `_Threading`, `Foundation`, `Security` |

## FR-1 · ws-probe (local, Linux x64, 2026-10-29)

```
{"ok":true,"db":true,"version":"0.0.0+4d07791"}
enrolled machine 552e7ce1-f835-4893-9e17-d9efd92a1192 (credential 43 chars, not shown)
== ws-probe
[+  0.000s] connect ws://127.0.0.1:7499/ws/daemon
[+  0.010s] upgraded: HTTP 101 Switching Protocols
[+  0.011s] -> {"fencing_token":null,"msg_id":"dbf33812-…","payload":{"arch":"x64","budget_cpu":2,"budget_mem_mb":4096,"claude_code_version":null,"cpu_total":4,"daemon_version":"0.0.0-rust-spike","disk_free_mb":10000,"hostname":"bengrady","machine_id":"552e7ce1-f835-4893-9e17-d9efd92a1192","max_concurrent_builds":1,"max_sessions":0,"mem_total_mb":8192,"os":"linux","protocol_version":2,"tags":[]},"seq":null,"session_id":null,"type":"register"}
[+  0.028s] <- {"type":"registered","msg_id":"7b267c96-…","seq":null,"session_id":null,"fencing_token":null,"payload":{"machine_id":"552e7ce1-f835-4893-9e17-d9efd92a1192","last_seq":null,"heartbeat_interval_ms":10000}}
[+  0.028s] registered: last_seq=None heartbeat_interval_ms=10000
[+  0.028s] -> heartbeat #1 {"fencing_token":null,"msg_id":"c1c39eb8-…","payload":{"cpu_free":2.0,"disk_free_mb":10000,"mem_free_mb":4096,"sessions":[]},"seq":null,"session_id":null,"type":"heartbeat"}
[+ 10.030s] -> heartbeat #2 {… "type":"heartbeat"}
[+ 20.032s] -> heartbeat #3 {… "type":"heartbeat"}
[+ 20.533s] -> close 1000
[+ 20.536s] <- close Some(Some(CloseFrame { code: Normal, reason: Utf8Bytes(b"probe done") }))
ws-probe: PASS registered + 3 heartbeats, closed cleanly
== ws-probe, wrong credential
[+  0.005s] upgrade refused: HTTP 401
ws-probe: PASS wrong credential refused with 401
== machine row
[{"id":"552e7ce1-…","status":"offline","os":"linux","arch":"x64","daemon_version":"0.0.0-rust-spike","last_heartbeat_at":"2026-10-29T18:54:35.981Z"}]
```

`status` is `offline` because the probe had already closed when the row was read. `last_heartbeat_at` is the last heartbeat. No `protocol_error` arrived. The probe sends no `enrollment_token` (an enrolled daemon authenticates on the upgrade).

**Go.** TLS: rustls is compiled in, but `ws://` on loopback doesn't exercise it. No external `wss://` endpoint was contacted.

## FR-2 · mcp-probe (local, Linux x64, 2026-10-29)

```
PASS tools/list: ["ask_user", "complete_state", "permission"], reply content-type application/json
PASS complete_state _meta alwaysLoad
PASS unknown token -> 404: HTTP 404
PASS foreign Host -> 403: HTTP 403
  fake-claude> {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_fake_eed5f744","name":"mcp__conductor__complete_state","input":{"result":{"probe":"ok"},"transition":"done","reason":"probe"}}]},…}
  fake-claude> {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fake_eed5f744","content":[{"type":"text","text":"Recorded. Stop now: do not call any other tool and end your turn."}],"is_error":false}]},…}
  fake-claude> {"type":"result","subtype":"success","is_error":false,"num_turns":1,…}
PASS fake-claude complete_state recorded: Some(Object {"reason": String("probe"), "result": Object {"probe": String("ok")}, "transition": String("done")})
PASS fake-claude tool_result: {… "text":"Recorded. Stop now: do not call any other tool and end your turn.", "is_error":false …}
PASS fake-claude exit 0: exit status: 0
[1793299814.310] initialize -> "2025-06-18"
[1793299814.313] permission: holding Bash (Some("toolu_probe")) for 65s
PASS call during a held call answers at once: 2 ms
PASS permission held >= 65s: HTTP 200 application/json after 65.0 s: {"behavior":"allow","updatedInput":{"command":"echo hi"}}
SKIP real claude (set E2E_REAL_CLAUDE=1; spends cents)
```

Real claude: **not run** (opt-in; Ben hasn't enabled it). The probe passes the flags `cli-driver.ts` uses: `-p --model haiku --output-format stream-json --verbose --mcp-config <file> --strict-mcp-config --allowedTools mcp__conductor__complete_state`. It asserts the server recorded `{"probe":"real"}`.

**Go for fake-claude and the held call. The real-claude run is still to do** (see Verdicts).

## FR-3 · job-probe

- **Windows: from the workflow run.** Each of variants a, b and c prints, for every process (`cmd`, `parent`, `grandchild`), that it was alive and in the job before the kill, then `gone` or `SURVIVED`. Variant d prints what `taskkill /T /F` left behind.
- **Linux, local (the contrast, not the assertion):**

```
job-probe (unix, informational): process-group kill, as the TS daemon does
    parent pid 2676816 (group leader), grandchild pid 2676833 (setsid)
    parent alive after killpg: false
    grandchild alive after killpg: true (expected true: setsid left the group)
```

A detached grandchild escapes a process-group kill on POSIX too. That is worth knowing for MR-T04: Linux would need cgroups or a subreaper (`PR_SET_CHILD_SUBREAPER`) for parity with the Job Object.

## Release binary sizes

| OS | ws-probe | mcp-probe | job-probe |
|---|---:|---:|---:|
| Linux x64 (local, rustc 1.99.1) | 2.07 MiB (2,167,696) | 4.60 MiB (4,818,344) | 0.40 MiB (423,168) |
| ubuntu-latest / windows-latest | the workflow's job summary | | |

A daemon with both the WS client and the MCP server would be about the size of `mcp-probe` plus the TLS half of `ws-probe`: roughly 6 MiB stripped. That is compared with the ~100 MB of a Node runtime.

## Findings for the port

1. **rmcp 3.8 already has the TS server's guards.**
   - `StreamableHttpServerConfig::with_allowed_hosts` gives the loopback Host check (403), so outcome-server.ts's hand-written check isn't needed.
   - `with_legacy_session_mode(false)` + `with_json_response(true)` is the TS shape (stateless, `enableJsonResponse`). `GET` is answered with 405.
   - The per-session path is an axum route `/mcp/{token}` in front of one `StreamableHttpService` per token, via `tower::ServiceExt::oneshot`. An unknown token is our 404.
2. **Tool `_meta` works:** `#[tool(meta = …)]` with an `rmcp::model::MetaObject` puts `anthropic/alwaysLoad` in `tools/list`.
3. **Schemas differ slightly.** schemars renders `Option<String>` as `"type": ["string", "null"]`, while zod has `type: string` and leaves it out of `required`. The caps (`minLength`/`maxLength`) only document the limits, so the handler checks them itself. fake-claude doesn't care. MR-T03's generated types should decide whether to match zod exactly.
4. **fake-claude can't hold a call for 60 s or more.** The TS SDK client's default request timeout is 60 s, and the fixture is frozen. The held-call probe uses a raw JSON-RPC client instead. Real Claude reads `MCP_TOOL_TIMEOUT`, so MR-T08's real-claude permission test must set it.
5. **rmcp 3.x speaks MCP `2026-07-28` (stateless, SEP-2567) as well as the older versions.** fake-claude negotiated `2025-06-18`. Leave `stateless_protocol_metadata_required` off, or older clients are rejected.
6. **Job Object start must be atomic.** `CreateProcessW(CREATE_SUSPENDED)` → `AssignProcessToJobObject` → `ResumeThread`. Assigning after `std::process::Command::spawn` lets cmd start node outside the job. `PROC_THREAD_ATTRIBUTE_JOB_LIST` is the alternative.
7. **Crash safety comes from the OS (variant c).** When the daemon dies, the kernel closes the job handle, and kill-on-close takes the tree with it. Whether the orphan sweep (TD-189) can shrink to a backstop is MR-T04's call. Note one consequence: a daemon restart kills running agents unless the job handle is handed over.
8. **The rustls default provider is aws-lc-rs.** It builds with the `cc` crate on Linux, and the Windows workflow shows whether it does there. If it is a problem, `ring` is a feature switch away.
