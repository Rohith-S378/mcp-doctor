# mcp-doctor

A small, dependency-free CLI that diagnoses broken **MCP (Model Context
Protocol)** server configs — across **OpenClaw**, **Claude Desktop**, and
**Cursor**.

## The problem

MCP configs almost always break in the same handful of ways:

- The binary in `"command"` isn't on `PATH` → cryptic `spawn ENOENT` errors
- An `${API_KEY}`-style env var referenced in the config was never actually set
- The server process exits immediately with a nonzero code and a stack trace
  nobody wants to read
- The server *looks* like it started fine, but you have no way to tell without
  digging through logs

Every tool that supports MCP (OpenClaw, Claude Desktop, Cursor, etc.) uses a
nearly identical JSON shape for server configuration, but none of them give
you a single command that just tells you what's wrong in plain English.

## What it does

```bash
node index.js check ./path/to/your/config.json
```

`mcp-doctor` reads your config, auto-detects which tool it belongs to, spawns
each configured MCP server for a few seconds, and classifies the result into
one of:

| Status              | Meaning                                                       |
|----------------------|----------------------------------------------------------------|
| `OK`                 | Server started and is either running or exited cleanly         |
| `BINARY_NOT_FOUND`   | The command in `"command"` isn't resolvable on `PATH`           |
| `MISSING_ENV_VAR`    | A referenced `${VAR}` (or blank env value) isn't set            |
| `NONZERO_EXIT`       | The process ran and exited with a non-zero code                |
| `TIMEOUT`            | The process didn't settle (exit or stay alive) within 5 seconds |
| `UNKNOWN`            | Something else went wrong (e.g. a permissions error)             |

Each result comes with a one-line plain-English fix suggestion — not a raw
stack trace.

## Supported config formats

- **OpenClaw** — `{ "mcp": { "servers": { "<name>": { "command", "args", "env" } } } }`
- **Claude Desktop** — `{ "mcpServers": { "<name>": { "command", "args", "env" } } }`
- **Cursor** — `{ "mcpServers": { "<name>": { "command", "args", "env" } } }`

Format is auto-detected from the file's top-level shape — you don't need to
tell it which tool the config came from.

## Try it out

Two example configs are included so you can see every failure type without
touching your real setup:

```bash
# Everything green
npm run test:working

# Every failure type triggered on purpose
npm run test:broken
```

Sample output against the broken config:

```
BINARY_NOT_FOUND  nonexistent-binary
  "this-binary-does-not-exist-xyz" was not found in PATH.
  fix: Run "which this-binary-does-not-exist-xyz" ...

MISSING_ENV_VAR   missing-api-key
  Missing/unset env var(s): SOME_FAKE_API_KEY
  fix: Export SOME_FAKE_API_KEY in your shell profile or .env file ...

NONZERO_EXIT      crashes-immediately
  Exited with code 1. stderr: fatal: bad config
  fix: Run the command directly in your terminal to see the full error ...

0/3 servers OK
```

Exit code is `0` when every server is healthy, and `1` otherwise — so it's
CI-friendly.

## Installation

No install required — just clone and run:

```bash
git clone https://github.com/<your-username>/mcp-doctor.git
cd mcp-doctor
node index.js check /path/to/your/config.json
```

Requires Node.js 16+. Zero external dependencies.

## Roadmap

- [✓] Detect the "server started fine but its tools are invisible" sandbox
      allowlist gap (OpenClaw-specific, but a common failure category)
- [✓] `--fix` flag to auto-resolve easy cases (e.g. rewrite `"command": "npx"`
      to its full resolved path)
- [ ] Publish to npm so `npx mcp-doctor check <config>` works with zero clone
- [ ] Optional JSON output mode for piping into other tools

## Why this exists

Built while debugging a real, broken [OpenClaw](https://github.com/openclaw)
gateway setup — every failure category here is one I actually hit, not a
hypothetical.

## License

MIT
