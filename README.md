# pi-background-bash

Async/background `bash` for [Pi](https://github.com/earendil-works/pi): keep using the normal `bash` tool, but long-running commands stop blocking the agent.

`pi-background-bash` replaces Pi's bash execution with the PBB runner and adds two quality-of-life features:

- `background: true` starts a command in the background immediately.
- normal foreground commands automatically move to the background after 30 seconds.

As of v1, PBB-owned execution is the baseline: jobs are recorded with logs plus `pid`/`pgid`, and full output is available through `pbb tail`.

When a background command finishes, the extension injects a follow-up result into the session and wakes the agent.

## Fork notice

This is a **maintained fork** of [`sshkeda/pi-background-bash`](https://github.com/sshkeda/pi-background-bash) with two fixes:

1. **Installable out of the box.** The upstream package depends on the private repository `github:sshkeda/pi-context` (returns 404), so `pi install` fails for everyone. The three functions it uses (`piContext`, `truncateContextText`, `formatTruncationNotice`) are now inlined in [`extensions/pi-context-utils.ts`](extensions/pi-context-utils.ts) and the dependency is removed.
2. **No stale-ctx crashes.** The background-completion callbacks evaluated `ctx.cwd` lazily, after session teardown in headless one-shot mode, throwing `This extension ctx is stale after session replacement or reload`. `cwd` is now captured eagerly at job start.

Verified end-to-end (interactive + headless): `background: true`, automatic backgrounding after the configured threshold, detached pbb runner with full logs, follow-up injection into the session (`custom_message` entry with `kind="background_bash_result"`), and agent wake-up via `triggerTurn`.

## Why

AI coding agents often need to run slow commands: test suites, builds, dev servers, downloads, deploys, benchmark loops, and watchers. Without background execution, the agent gets stuck waiting. With this extension, the agent can continue useful work and handle the command output when it arrives.

## Install

Install from npm (recommended):

```bash
pi install npm:pi-background-bash
```

Or from this GitHub fork:

```bash
pi install git:github.com/mowenroot/pi-background-bash
```

Try without installing:

```bash
pi -e npm:pi-background-bash
```

> Upstream install (may fail due to the private `pi-context` dependency):
> `pi install git:github.com/sshkeda/pi-background-bash`

Local development:

```bash
git clone https://github.com/mowenroot/pi-background-bash.git
cd pi-background-bash
npm install
npm test
pi -e .
```

## Usage

Run a command normally. If it is still running after 30 seconds, it automatically moves to the background:

```ts
bash({ command: "npm test" })
```

Start a command in the background immediately:

```ts
bash({ command: "npm test", background: true })
```

Add a timeout if you want Pi to kill the command after a fixed number of seconds:

```ts
bash({ command: "npm test", background: true, timeout: 120 })
```

Completion results arrive as Pi context messages:

```xml
<pi_context source="pi-background-bash" kind="background_bash_result" id="bg001" outcome="exit" exit_code="0">
...
</pi_context>
```

Commands run through the PBB-owned bash runner (`bash -lc`) so background jobs have recorded `pid`/`pgid` and can be killed as process groups. Verbose completion messages are truncated in-session with a `pbb tail <job> --full` hint; the full output is kept in the PBB log. See [`docs/pbb-runner.md`](docs/pbb-runner.md) for the v1 runner contract.

## v1 migration

v1 is a hard migration to PBB-owned execution. The old native-runner compatibility path and `PI_BACKGROUND_BASH_RUNNER` switch are gone. If you depended on exact pre-v1 bash formatting, update callers to use `pbb tail <job> --full` for complete output and the recorded PBB job metadata for process control.

## `pbb` CLI

This package also installs `pbb`, a small inspector for background bash jobs.

```bash
pbb self
pbb list
pbb status bg001
pbb tail bg001 -n 80
pbb kill bg001
```

`pbb` is designed for agents: output is wrapped in compact `pi_context` envelopes and always includes session/instance identity. Local job IDs are fixed-width strings such as `bg001`, `bg002`, and `bg010` so listings sort chronologically. `pbb` uses [`pi-lane`](https://github.com/sshkeda/pi-lane) runtime identity env vars (`PI_LANE_SESSION_KEY`, `PI_LANE_INSTANCE_ID`, etc.) and defaults to the current live Pi instance, not every terminal attached to the same session.

Background job state is stored under:

```text
~/.pi/pbb/sessions/{sessionKey}/instances/{instanceId}/
  identity.json
  jobs/{jobId}.json
  events.jsonl
  logs/{jobId}.log
```

`pbb list` and `pbb status` show owner liveness through the tracked `pil` CLI from `pi-lane`, so stale/disconnected owners are visible instead of silently confused with the current runtime. If tracked `pi-lane`/`pil` is missing or fails, `pbb` hard-fails instead of silently degrading liveness to unknown.

`pbb kill` writes a kill request into the owning instance mailbox. A live `pi-background-bash` runtime polls that mailbox and aborts the matching in-process job. Jobs record `pid`/`pgid`, so the runtime kills the full process group. If the owner is stale, `pbb kill --stale --instance <id> <job>` can signal the recorded process group explicitly.

## Configuration

Default auto-background threshold: `30` seconds.

Configure the global threshold in `~/.pi-background-bash/config.json`:

```json
{
  "autoBackgroundAfterSeconds": 10
}
```

Disable automatic backgrounding while keeping `background: true` available:

```json
{
  "autoBackgroundAfterSeconds": 0
}
```

You can also override the threshold for a single project with `.pi/background-bash.json` in that project. Project config wins over global config.

## Agent prompt behavior

The extension updates the `bash` tool metadata exposed to models:

- the `background` boolean is part of the tool schema
- the tool description documents automatic backgrounding
- prompt snippets/guidelines teach the agent not to retry just to wait
- prompt guidelines teach the agent to use `pbb list/status/tail` for inspection
- background completion messages are described as final bash results

No global Pi prompt patch is required.

## Security

This is a Pi extension. Like any Pi package, it runs with your local user permissions and can execute shell commands requested by the agent. Review the source before installing third-party extensions.

## Development

```bash
npm install
npm run hooks:install
npm run typecheck
npm test
```

This repo uses Lefthook for local pre-commit checks. The test suite uses [`pi-mock`](https://github.com/sshkeda/pi-mock) to exercise the extension against a real Pi process.

## License

MIT
