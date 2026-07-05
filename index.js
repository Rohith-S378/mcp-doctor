#!/usr/bin/env node

/**
 * mcp-doctor
 *
 * I built this after spending way too long debugging MCP server configs
 * for my OpenClaw setup. Turns out most failures fall into like 4-5
 * buckets - binary not on PATH, forgot to set an env var, server just
 * crashes on start, or (this one's sneaky) the server runs fine but
 * OpenClaw's sandbox quietly blocks its tools so it looks like nothing's
 * wrong. Every time this happened I'd end up manually running the command,
 * squinting at stderr, googling the error. This just automates that.
 *
 * Works with OpenClaw, Claude Desktop, and Cursor configs since they're
 * basically the same JSON shape with different key names.
 *
 * Usage:
 *   node index.js check <path-to-config.json> [flags]
 *
 * Flags:
 *   --json      machine-readable output, useful for CI or scripting
 *   --verbose   full stderr instead of the truncated 200-char version
 *   --fix       auto-fixes the sandbox allowlist thing (only that, for now -
 *               everything else needs a human to actually decide what's wrong)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Terminal colors (no dependency needed for a handful of ANSI codes)

const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function paint(text, c, jsonMode) {
  // Skip coloring in JSON mode or when not attached to a real terminal.
  if (jsonMode || !process.stdout.isTTY) return text;
  return `${c}${text}${color.reset}`;
}

// Status classification
const STATUS = {
  OK: 'OK',
  BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
  MISSING_ENV_VAR: 'MISSING_ENV_VAR',
  NONZERO_EXIT: 'NONZERO_EXIT',
  TIMEOUT: 'TIMEOUT',
  SANDBOX_BLOCKED: 'SANDBOX_BLOCKED',
  UNKNOWN: 'UNKNOWN',
};

const STATUS_COLOR = {
  [STATUS.OK]: color.green,
  [STATUS.BINARY_NOT_FOUND]: color.red,
  [STATUS.MISSING_ENV_VAR]: color.yellow,
  [STATUS.NONZERO_EXIT]: color.red,
  [STATUS.TIMEOUT]: color.yellow,
  [STATUS.SANDBOX_BLOCKED]: color.yellow,
  [STATUS.UNKNOWN]: color.dim,
};

// A server is considered "alive" once it has been running past this point
// without exiting. MCP servers over stdio typically sit idle waiting for
// JSON-RPC input, so simply "not having crashed yet" is a strong OK signal.
const ALIVE_THRESHOLD_MS = 2500;
const HARD_TIMEOUT_MS = 5000;
const STDERR_SNIPPET_LENGTH = 200;

// CLI flag parsing

function parseArgs(argv) {
  const [, , subcommand, ...rest] = argv;
  const flags = {
    json: rest.includes('--json'),
    verbose: rest.includes('--verbose'),
    fix: rest.includes('--fix'),
  };
  // The config path is whichever positional arg isn't a flag.
  const configPathArg = rest.find((arg) => !arg.startsWith('--'));
  return { subcommand, configPathArg, flags };
}

// Config detection + parsing

/**
 * Detects which tool a config file belongs to, based on its top-level shape,
 * and returns a normalized list of { name, command, args, env } servers,
 * plus the raw parsed config object (needed for sandbox allowlist checks
 * and for --fix to write changes back).
 \*/
function parseConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Could not parse ${configPath} as JSON: ${err.message}\n` +
      `Tip: OpenClaw configs are JSON5 and may contain comments or trailing ` +
      `commas that plain JSON.parse can't handle — strip those first.`
    );
  }

  let format = 'unknown';
  let serversBlock = null;

  if (data.mcp && typeof data.mcp === 'object' && data.mcp.servers) {
    format = 'openclaw';
    serversBlock = data.mcp.servers;
  } else if (data.mcpServers && typeof data.mcpServers === 'object') {
    // Claude Desktop and Cursor both use this flat key. We can't always
    // tell them apart from shape alone, so we label it generically.
    format = 'claude-desktop-or-cursor';
    serversBlock = data.mcpServers;
  } else {
    throw new Error(
      `Could not find a recognizable MCP server block in ${configPath}.\n` +
      `Expected either "mcp.servers" (OpenClaw) or "mcpServers" ` +
      `(Claude Desktop / Cursor) as a top-level key.`
    );
  }

  const servers = Object.entries(serversBlock).map(([name, cfg]) => ({
    name,
    command: cfg.command,
    args: Array.isArray(cfg.args) ? cfg.args : [],
    env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
  }));

  if (servers.length === 0) {
    throw new Error(`No servers found inside the MCP config block in ${configPath}.`);
  }

  return { format, servers, rawConfig: data };
}

// --------------------------------------------------------------------------
// Env var resolution

/**
 * Server configs often reference env vars using ${VAR_NAME} syntax rather
 * than hardcoding secrets. This finds every ${...} placeholder across the
 * command/args/env values and checks whether it's actually set in the
 * current shell environment.
 */
function findMissingEnvVars(server) {
  const placeholderPattern = /\$\{([A-Z0-9_]+)\}/g;
  const haystack = [
    server.command || '',
    ...(server.args || []),
    ...Object.values(server.env || {}),
  ].join(' ');

  const missing = new Set();
  let match;
  while ((match = placeholderPattern.exec(haystack)) !== null) {
    const varName = match[1];
    if (!process.env[varName]) {
      missing.add(varName);
    }
  }

  // Also check plain (non-${}) env keys declared in the server's own `env`
  // block whose value is empty/undefined — a common copy-paste mistake.
  for (const [key, value] of Object.entries(server.env || {})) {
    if (!placeholderPattern.test(value) && (value === '' || value === undefined)) {
      missing.add(key);
    }
    placeholderPattern.lastIndex = 0; // reset regex state after .test()
  }

  return Array.from(missing);
}


// Binary resolution (cross-platform "which")


function isBinaryOnPath(command) {
  // Absolute or relative paths are checked directly.
  if (command.includes(path.sep)) {
    return fs.existsSync(command);
  }

  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  const isWindows = os.platform() === 'win32';
  const candidates = isWindows
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`]
    : [command];

  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(dir, candidate))) {
        return true;
      }
    }
  }
  return false;
}


// Sandbox allowlist detection (OpenClaw-specific)
/**
 * OpenClaw supports running agents in a sandbox. When sandboxing is on,
 * MCP-provided tools are gated by an additional allowlist
 * (tools.sandbox.tools.alsoAllow). A server can spawn perfectly fine while
 * its tools remain invisible to the model, because the sandbox filters them
 * out silently — no error, no log line, nothing. This is one of the more
 * confusing MCP failure modes because everything *looks* healthy.
 *
 * This only applies to OpenClaw-format configs, since the sandbox/allowlist
 * concept doesn't exist in Claude Desktop or Cursor's config shape.
 *
 * Returns true if the given server's tools would be blocked.
 */
function isSandboxBlocked(rawConfig, serverName) {
  const sandboxMode = rawConfig?.agents?.defaults?.sandbox?.mode;
  const sandboxEnabled = sandboxMode && sandboxMode !== 'none';

  if (!sandboxEnabled) return false;

  const alsoAllow = rawConfig?.tools?.sandbox?.tools?.alsoAllow || [];

  const isAllowed = alsoAllow.some((entry) => {
    if (entry === '*' || entry === 'bundle-mcp') return true;
    // Per-server wildcard, e.g. "github__*"
    if (entry === `${serverName}__*`) return true;
    // Exact tool name match, e.g. "github__create_pr" — treat any match
    // starting with "<serverName>__" as covering this server.
    if (entry.startsWith(`${serverName}__`)) return true;
    return false;
  });

  return !isAllowed;
}

/**
 * Applies the one safe, unambiguous auto-fix this tool supports: adding a
 * missing "<serverName>__*" entry to tools.sandbox.tools.alsoAllow. Returns
 * the updated config object; does not write to disk itself (the caller
 * decides when/whether to persist).
 */
function applySandboxFix(rawConfig, serverName) {
  const updated = JSON.parse(JSON.stringify(rawConfig)); // deep clone, avoid mutating caller's object

  if (!updated.tools) updated.tools = {};
  if (!updated.tools.sandbox) updated.tools.sandbox = {};
  if (!updated.tools.sandbox.tools) updated.tools.sandbox.tools = {};
  if (!Array.isArray(updated.tools.sandbox.tools.alsoAllow)) {
    updated.tools.sandbox.tools.alsoAllow = [];
  }

  const entry = `${serverName}__*`;
  if (!updated.tools.sandbox.tools.alsoAllow.includes(entry)) {
    updated.tools.sandbox.tools.alsoAllow.push(entry);
  }

  return updated;
}

// Server spawn + classification-

/**
 * Spawns a single MCP server and watches it for a few seconds, resolving
 * with a diagnosis object rather than throwing — every failure mode here is
 * expected, not exceptional.
 */
function checkServer(server, rawConfig, format, flags) {
  return new Promise((resolve) => {
    // 1. Binary resolution check first — fail fast with a clear message
    //    rather than letting Node produce a raw ENOENT stack trace.
    if (!isBinaryOnPath(server.command)) {
      resolve({
        name: server.name,
        status: STATUS.BINARY_NOT_FOUND,
        detail: `"${server.command}" was not found in PATH.`,
        fix: `Run "which ${server.command}" (or "where" on Windows) yourself ` +
             `to confirm, then either install it or use its full absolute path ` +
             `in the config's "command" field.`,
        autoFixable: false,
      });
      return;
    }

    // 2. Missing env var check — also fail fast, since a server missing its
    //    API key will usually exit immediately anyway, but this gives a much
    //    more specific answer than parsing stderr text.
    const missingVars = findMissingEnvVars(server);
    if (missingVars.length > 0) {
      resolve({
        name: server.name,
        status: STATUS.MISSING_ENV_VAR,
        detail: `Missing/unset env var(s): ${missingVars.join(', ')}`,
        fix: `Export ${missingVars.join(', ')} in your shell profile or .env ` +
             `file before starting the gateway, then restart it fully ` +
             `(env vars are read at startup, not on reload).`,
        autoFixable: false,
      });
      return;
    }

    // 3. Actually spawn it and watch what happens.
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
    });

    let stderrBuffer = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(aliveTimer);
      clearTimeout(hardTimer);
      if (!child.killed) {
        try { child.kill(); } catch (_) { /* already exited */ }
      }

      // 4. Sandbox allowlist check — only meaningful once we know the
      //    process itself is healthy. A server that's already failing for
      //    another reason shouldn't also be flagged as sandbox-blocked.
      if (
        result.status === STATUS.OK &&
        format === 'openclaw' &&
        isSandboxBlocked(rawConfig, server.name)
      ) {
        resolve({
          name: server.name,
          status: STATUS.SANDBOX_BLOCKED,
          detail: `Process started fine, but sandboxing is enabled and ` +
                  `"${server.name}__*" isn't in tools.sandbox.tools.alsoAllow — ` +
                  `its tools are silently invisible to the agent.`,
          fix: `Add "${server.name}__*" to tools.sandbox.tools.alsoAllow in your ` +
               `config, or run with --fix to apply this automatically.`,
          autoFixable: true,
        });
        return;
      }

      resolve({ name: server.name, ...result });
    };

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.on('error', (err) => {
      // e.g. EACCES, or a race where the binary disappeared after our check
      finish({
        status: STATUS.UNKNOWN,
        detail: `Failed to spawn: ${err.message}`,
        fix: `Check file permissions on "${server.command}" and try running ` +
             `the exact command manually in your terminal.`,
        autoFixable: false,
      });
    });

    child.on('exit', (exitCode, signal) => {
      if (settled) return; // we already killed it ourselves after ALIVE_THRESHOLD
      if (exitCode === 0) {
        finish({
          status: STATUS.OK,
          detail: `Exited cleanly (code 0) — some servers do this after a quick handshake.`,
          fix: null,
          autoFixable: false,
        });
      } else {
        const trimmed = stderrBuffer.trim();
        const shownStderr = flags.verbose
          ? trimmed
          : trimmed.slice(0, STDERR_SNIPPET_LENGTH) +
            (trimmed.length > STDERR_SNIPPET_LENGTH ? ' … (run with --verbose for full output)' : '');
        finish({
          status: STATUS.NONZERO_EXIT,
          detail: `Exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}.` +
                  (trimmed ? ` stderr: ${shownStderr}` : ' No stderr output.'),
          fix: `Run "${server.command} ${server.args.join(' ')}" directly in your ` +
               `terminal to see the full error — nonzero exits are almost always ` +
               `a bad argument, an invalid API key, or a missing dependency.`,
          autoFixable: false,
        });
      }
    });

    // If the process is still alive after ALIVE_THRESHOLD_MS without exiting,
    // treat that as a healthy sign (most MCP servers over stdio just sit and
    // wait for JSON-RPC input — silence is success, not failure).
    const aliveTimer = setTimeout(() => {
      finish({
        status: STATUS.OK,
        detail: `Still running after ${ALIVE_THRESHOLD_MS}ms with no errors — looks healthy.`,
        fix: null,
        autoFixable: false,
      });
    }, ALIVE_THRESHOLD_MS);

    // Absolute upper bound so a hung process can't stall the whole report.
    const hardTimer = setTimeout(() => {
      finish({
        status: STATUS.TIMEOUT,
        detail: `Did not settle (exit or stable "alive") within ${HARD_TIMEOUT_MS}ms.`,
        fix: `This can be normal for slow-starting servers. Try increasing your ` +
             `gateway's startup timeout, or run the command manually and time it.`,
        autoFixable: false,
      });
    }, HARD_TIMEOUT_MS);
  });
}

// Reporting 

function printTextReport(format, results) {
  console.log('');
  console.log(paint(`mcp-doctor report`, color.bold + color.cyan));
  console.log(paint(`config format detected: ${format}`, color.dim));
  console.log('');

  for (const r of results) {
    const label = paint(r.status.padEnd(17), STATUS_COLOR[r.status] || color.reset);
    console.log(`${label} ${paint(r.name, color.bold)}`);
    console.log(`  ${paint(r.detail, color.dim)}`);
    if (r.fix) {
      console.log(`  ${paint('fix:', color.blue)} ${r.fix}`);
    }
    console.log('');
  }

  const failed = results.filter((r) => r.status !== STATUS.OK);
  const summaryColor = failed.length === 0 ? color.green : color.red;
  console.log(
    paint(
      `${results.length - failed.length}/${results.length} servers OK`,
      summaryColor + color.bold
    )
  );

  const fixableCount = results.filter((r) => r.autoFixable).length;
  if (fixableCount > 0) {
    console.log(
      paint(
        `${fixableCount} issue(s) can be auto-fixed — rerun with --fix to apply.`,
        color.blue
      )
    );
  }

  console.log('');

  return failed.length === 0;
}

function printJsonReport(format, results, configPath) {
  const failed = results.filter((r) => r.status !== STATUS.OK);
  const output = {
    configPath,
    format,
    summary: {
      total: results.length,
      ok: results.length - failed.length,
      failed: failed.length,
    },
    servers: results.map((r) => ({
      name: r.name,
      status: r.status,
      detail: r.detail,
      fix: r.fix,
      autoFixable: !!r.autoFixable,
    })),
  };
  console.log(JSON.stringify(output, null, 2));
  return failed.length === 0;
}

// --fix mode 

/**
 * Applies auto-fixes for every SANDBOX_BLOCKED result, writes the updated
 * config back to disk (after backing up the original), and returns the
 * list of server names that were fixed.
 */
function applyFixes(configPath, rawConfig, results) {
  const fixableResults = results.filter((r) => r.autoFixable && r.status === STATUS.SANDBOX_BLOCKED);
  if (fixableResults.length === 0) return [];

  let updatedConfig = rawConfig;
  for (const r of fixableResults) {
    updatedConfig = applySandboxFix(updatedConfig, r.name);
  }

  // Back up the original before writing, since this edits the user's real
  // config file — an auto-fixer that doesn't leave a way back is a
  // liability, not a convenience.
  const backupPath = `${configPath}.bak-${Date.now()}`;
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + '\n', 'utf8');

  return { fixed: fixableResults.map((r) => r.name), backupPath };
}

// CLI entry point

async function main() {
  const { subcommand, configPathArg, flags } = parseArgs(process.argv);

  if (subcommand !== 'check' || !configPathArg) {
    console.log('Usage: node index.js check <path-to-config.json> [--json] [--verbose] [--fix]');
    console.log('');
    console.log('Supported config formats:');
    console.log('  - OpenClaw:       { "mcp": { "servers": { ... } } }');
    console.log('  - Claude Desktop: { "mcpServers": { ... } }');
    console.log('  - Cursor:         { "mcpServers": { ... } }');
    console.log('');
    console.log('Flags:');
    console.log('  --json      Print machine-readable JSON instead of colored text');
    console.log('  --verbose   Show full stderr output instead of a truncated snippet');
    console.log('  --fix       Auto-apply safe fixes (currently: sandbox allowlist gaps)');
    process.exit(2);
  }

  const configPath = path.resolve(configPathArg);

  if (!fs.existsSync(configPath)) {
    console.error(paint(`Error: file not found: ${configPath}`, color.red, flags.json));
    process.exit(2);
  }

  let format, servers, rawConfig;
  try {
    ({ format, servers, rawConfig } = parseConfig(configPath));
  } catch (err) {
    console.error(paint(`Error: ${err.message}`, color.red, flags.json));
    process.exit(2);
  }

  if (!flags.json) {
    console.log(paint(`Checking ${servers.length} server(s)...`, color.dim));
  }

  const results = await Promise.all(
    servers.map((server) => checkServer(server, rawConfig, format, flags))
  );

  let allOk;
  if (flags.json) {
    allOk = printJsonReport(format, results, configPath);
  } else {
    allOk = printTextReport(format, results);
  }

  if (flags.fix) {
    const fixOutcome = applyFixes(configPath, rawConfig, results);
    if (Array.isArray(fixOutcome) && fixOutcome.length === 0) {
      if (!flags.json) console.log(paint('Nothing to auto-fix.', color.dim));
    } else if (fixOutcome.fixed) {
      if (flags.json) {
        console.log(JSON.stringify({ fixed: fixOutcome.fixed, backup: fixOutcome.backupPath }, null, 2));
      } else {
        console.log(
          paint(
            `Fixed sandbox allowlist for: ${fixOutcome.fixed.join(', ')}`,
            color.green
          )
        );
        console.log(paint(`Original config backed up to: ${fixOutcome.backupPath}`, color.dim));
        console.log(paint('Rerun the check to confirm the fix worked.', color.dim));
      }
    }
  }

  process.exit(allOk ? 0 : 1);
}

main();