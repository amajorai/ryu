// The argv dispatcher: the seam that makes `ryu` behave like `gh`/`docker` —
// interactive when bare, a one-shot command when a subcommand is given.
//
// Flow (see index.tsx): parse process.argv → if it names a subcommand (and not
// --help/--version), run it non-interactively and process.exit with a code; if it
// names none, or the first token is "tui", fall through to the interactive
// WorkspaceShell (unchanged). `ryu` and `ryu tui` both open the TUI.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { buildTarget } from "../core/target.ts";
import { realCoreApi } from "./api.ts";
import { findCommand, renderHelp } from "./commands.ts";
import { errorToJson, formatError, formatTable } from "./output.ts";
import {
	type CliContext,
	type CliIO,
	type CoreApi,
	type GlobalFlags,
	type ParsedArgs,
	UsageError,
} from "./types.ts";
import { VERSION } from "./version.ts";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/** Parse `process.argv.slice(2)` into a command, its positional args, and flags.
 *  Flags may appear anywhere; `--node <url>` (or `--node=<url>`) consumes a value.
 *  The first non-flag token is the command; the rest are its positional args.
 *  Unknown `--flags` are ignored so they never masquerade as positional args. */
export function parseArgs(argv: string[]): ParsedArgs {
	const flags: GlobalFlags = {
		json: false,
		node: null,
		force: false,
		cascade: false,
		help: false,
		version: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === "--json") {
			flags.json = true;
		} else if (tok === "--force") {
			flags.force = true;
		} else if (tok === "--cascade") {
			flags.cascade = true;
		} else if (tok === "-h" || tok === "--help") {
			flags.help = true;
		} else if (tok === "--version") {
			flags.version = true;
		} else if (tok === "--node") {
			flags.node = argv[i + 1] ?? null;
			i++;
		} else if (tok.startsWith("--node=")) {
			flags.node = tok.slice("--node=".length);
		} else if (tok.startsWith("-")) {
			// Unknown flag — ignore (do not treat as a positional/command).
		} else {
			positional.push(tok);
		}
	}
	const [command = null, ...args] = positional;
	return { command, args, flags };
}

/** True when this invocation should open the interactive TUI rather than run a
 *  one-shot command: no subcommand (and no --help/--version), or an explicit
 *  `tui` subcommand. */
export function isInteractive(argv: string[]): boolean {
	const parsed = parseArgs(argv);
	if (parsed.flags.help || parsed.flags.version) {
		return false;
	}
	return parsed.command === null || parsed.command === "tui";
}

/** Resolve the target node: env (RYU_CORE_URL/TOKEN) with `--node <url>` overriding
 *  the URL for this one invocation (token still from env). */
function resolveTarget(flags: GlobalFlags): ApiTarget {
	const base = buildTarget();
	return flags.node ? { url: flags.node, token: base.token } : base;
}

const defaultIo: CliIO = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

interface RunOverrides {
	api?: CoreApi;
	io?: CliIO;
	target?: ApiTarget;
}

/** Run one non-interactive `ryu` command and resolve to its exit code. Never
 *  throws — every failure is rendered to stderr and mapped to a code (2 = usage,
 *  1 = runtime). Overrides let bun tests inject a capturing IO + a fake CoreApi. */
export async function runCli(
	argv: string[],
	overrides: RunOverrides = {}
): Promise<number> {
	const parsed = parseArgs(argv);
	const io = overrides.io ?? defaultIo;
	const { flags } = parsed;

	// --help / --version short-circuit any subcommand.
	if (flags.help) {
		io.out(`${renderHelp()}\n`);
		return EXIT_OK;
	}
	if (flags.version) {
		io.out(flags.json ? `${JSON.stringify({ version: VERSION })}\n` : `ryu ${VERSION}\n`);
		return EXIT_OK;
	}

	if (parsed.command === null) {
		// Reached only if a caller invokes runCli for an interactive argv; show help.
		io.out(`${renderHelp()}\n`);
		return EXIT_OK;
	}

	const ctx: CliContext = {
		api: overrides.api ?? realCoreApi,
		args: parsed.args,
		flags,
		io,
		target: overrides.target ?? resolveTarget(flags),
	};

	// Built-ins are matched FIRST and always win — this is the feature-parity
	// guarantee: an installed app whose id collides with a built-in (e.g. `list`,
	// `chat`) can never shadow it. App-contributed commands run ONLY on the miss
	// below (see runAppCommand / the extension seam note at the bottom).
	const command = findCommand(parsed.command);

	try {
		if (command) {
			return await command.run(ctx);
		}
		// No built-in matched → try to resolve `parsed.command` as an app that
		// contributes `ryu <app> <cmd>` subcommands (surfaces.cli.commands).
		return await runAppCommand(ctx, parsed.command);
	} catch (err) {
		if (flags.json) {
			io.err(`${JSON.stringify(errorToJson(err))}\n`);
		} else {
			io.err(`Error: ${formatError(err)}\n`);
		}
		// A bad/missing argument is a usage error (2); anything else is runtime (1).
		return err instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
	}
}

// ── Extension seam: app-contributed subcommands (`ryu <app> <cmd>`) ─────────────
//
// An installed, ENABLED app contributes terminal subcommands by declaring them in
// its manifest.json under `surfaces.cli` with `support: "commands"` +
// `commands: [{ name, method, path, summary }]`. Core serializes the whole manifest
// on `GET /api/plugins` (already surface-filtered to `cli` by the X-Ryu-Surface
// header the tui sends), core-client maps it into `AppInfo.commands`, and this
// fall-through routes the call to the app's sidecar through Core's generic
// `ext_proxy` (`<method> /api/ext/<appId><path>`). Built-ins are checked first and
// always win, so no app can shadow one.

/** Resolve `appId` to an installed+enabled app and dispatch its subcommand. Returns
 *  a process exit code. Mirrors the "unknown command" contract when nothing matches
 *  so existing behavior (and its test) is unchanged. */
async function runAppCommand(ctx: CliContext, appId: string): Promise<number> {
	// Resolve the app set to check whether `appId` is a command-contributing app.
	// If the node is unreachable (fetchApps throws), we cannot confirm it is an app
	// command, so we degrade to the EXACT pre-app "unknown command" behavior (exit 2)
	// rather than surfacing a network error — this keeps `ryu <unknown>` node-less in
	// spirit and preserves the historical contract for a genuinely unknown token.
	let apps: Awaited<ReturnType<typeof ctx.api.fetchApps>>;
	try {
		apps = await ctx.api.fetchApps(ctx.target);
	} catch {
		ctx.io.err(
			`Unknown command: ${appId}\nRun 'ryu help' to see available commands.\n`
		);
		return EXIT_USAGE;
	}
	// Only an ENABLED, present (installed or built-in) app contributes commands. A
	// disabled/absent app id falls straight through to the same "unknown command"
	// message + exit 2 as before — never a call to its sidecar.
	const app = apps.find(
		(a) => a.id === appId && a.enabled && (a.installed || a.builtIn)
	);
	if (!app) {
		ctx.io.err(
			`Unknown command: ${appId}\nRun 'ryu help' to see available commands.\n`
		);
		return EXIT_USAGE;
	}

	const subName = ctx.args[0];
	// `ryu <app>` with no subcommand → list what the app contributes. (Global
	// `--help`/`-h` is handled node-lessly at the top of runCli and never reaches
	// here, preserving the offline-help guarantee.)
	if (!subName) {
		if (app.commands.length === 0) {
			ctx.io.out(`${app.name} (${app.id}) contributes no commands.\n`);
			return EXIT_OK;
		}
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(app.commands, null, 2)}\n`);
			return EXIT_OK;
		}
		const rows = app.commands.map((c) => [
			`ryu ${app.id} ${c.name}`,
			c.summary ?? "",
		]);
		ctx.io.out(`${formatTable(["COMMAND", "SUMMARY"], rows)}\n`);
		return EXIT_OK;
	}

	const sub = app.commands.find((c) => c.name === subName);
	if (!sub) {
		const available = app.commands.map((c) => c.name).join(", ") || "(none)";
		ctx.io.err(
			`Unknown command '${subName}' for app '${app.id}'. Available: ${available}.\n`
		);
		return EXIT_USAGE;
	}

	const { status, body } = await ctx.api.execAppCommand(
		ctx.target,
		app.id,
		{ method: sub.method, path: sub.path },
		ctx.args.slice(1)
	);
	if (status >= 400) {
		ctx.io.err(body.endsWith("\n") ? body : `${body}\n`);
		return EXIT_ERROR;
	}
	ctx.io.out(body.endsWith("\n") || body === "" ? body : `${body}\n`);
	return EXIT_OK;
}
