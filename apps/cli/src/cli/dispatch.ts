// The argv dispatcher: the seam that makes `ryu` behave like `gh`/`docker` —
// interactive when bare, a one-shot command when a subcommand is given.
//
// Flow (see index.tsx): parse process.argv → if it names a subcommand (and not
// --help/--version), run it non-interactively and process.exit with a code; if it
// names none, or the first token is "tui", fall through to the interactive
// WorkspaceShell (unchanged). `ryu` and `ryu tui` both open the TUI.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { resolveNodeTarget, UnknownNodeError } from "../core/nodeTarget.ts";
import { tf, tr } from "../i18n/translate.ts";
import {
	promptLine,
	readStdin,
	realCoreApi,
	realScaffold,
	runProcess,
} from "./api.ts";
import { findCommand, renderHelp } from "./commands.ts";
import { errorToJson, formatError, formatTable } from "./output.ts";
import {
	findServicesCommand,
	runServicesFromRyu,
	SERVICES_COMMAND_NAME,
} from "./services.ts";
import type { TroubleshootHost } from "./troubleshoot.ts";
import {
	type CliContext,
	type CliIO,
	type CoreApi,
	type FetchLike,
	type GlobalFlags,
	type LinePrompter,
	type ParsedArgs,
	type ProcessRunner,
	type ScaffoldRunner,
	UsageError,
} from "./types.ts";
import type { ContainerHost } from "./vaultIsolation.ts";
import { VERSION } from "./version.ts";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/** The flags that consume a VALUE (`--flag v` or `--flag=v`), mapped to the field
 *  they set. A table keeps the parse loop flat: each new value-flag is one entry
 *  here instead of two more branches in an ever-growing else-if chain. */
type ValueFlag = "agent" | "file" | "kind" | "node" | "template";
const VALUE_FLAGS = new Map<string, ValueFlag>([
	["--agent", "agent"],
	["--file", "file"],
	["--kind", "kind"],
	["--node", "node"],
	["--template", "template"],
]);

/** Parse `process.argv.slice(2)` into a command, its positional args, and flags.
 *  Flags may appear anywhere; the value flags in {@link VALUE_FLAGS} (`--agent`,
 *  `--file`, `--node`, `--kind`, `--template`) each consume the following token, or take it inline
 *  after an `=`. The first non-flag token is the command; the rest are its
 *  positional args. Unknown `--flags` are ignored so they never masquerade as
 *  positional args. A value flag given with no value stays null — its owner then
 *  applies its own default (or reports a usage error), so a truncated argv can
 *  never silently pick up the NEXT token as its value. */
export function parseArgs(argv: string[]): ParsedArgs {
	const flags: GlobalFlags = {
		agent: null,
		file: null,
		json: false,
		kind: null,
		node: null,
		print: false,
		template: null,
		tokenEnv: false,
		force: false,
		cascade: false,
		dryRun: false,
		fix: false,
		includeSecrets: false,
		help: false,
		version: false,
	};
	const positional: string[] = [];
	let commandIndex = -1;
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === "--") {
			// End of options: everything after is positional, never a global flag,
			// so `ryu secrets run -- node --version` cannot trigger `--version`.
			if (commandIndex === -1 && i + 1 < argv.length) {
				commandIndex = i + 1;
			}
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (tok === "--json") {
			flags.json = true;
		} else if (tok === "--force") {
			flags.force = true;
		} else if (tok === "--cascade") {
			flags.cascade = true;
		} else if (tok === "--dry-run") {
			flags.dryRun = true;
		} else if (tok === "--fix") {
			flags.fix = true;
		} else if (tok === "--include-secrets") {
			flags.includeSecrets = true;
		} else if (tok === "--print") {
			flags.print = true;
		} else if (tok === "--token-env") {
			flags.tokenEnv = true;
		} else if (tok === "-f") {
			flags.file = argv[i + 1] ?? null;
			i++;
		} else if (tok === "-h" || tok === "--help") {
			flags.help = true;
		} else if (tok === "--version") {
			flags.version = true;
		} else if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const name = eq === -1 ? tok : tok.slice(0, eq);
			const key = VALUE_FLAGS.get(name);
			if (!key) {
				// Unknown long flag — ignore (do not treat as a positional/command).
			} else if (eq === -1) {
				flags[key] = argv[i + 1] ?? null;
				i++;
			} else {
				flags[key] = tok.slice(eq + 1);
			}
		} else if (tok.startsWith("-")) {
			// Unknown short flag — ignore (do not treat as a positional/command).
		} else {
			if (commandIndex === -1) {
				commandIndex = i;
			}
			positional.push(tok);
		}
	}
	const [command = null, ...args] = positional;
	const rawArgs = commandIndex === -1 ? [] : argv.slice(commandIndex + 1);
	return { command, args, flags, rawArgs };
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

/** Resolve the target node through the saved node registry (core/nodeTarget.ts):
 *  `--node <name|url>` picks a saved node (with its own token) or an http(s) URL;
 *  without it RYU_CORE_URL wins, else the active node set by `ryu node use`. A
 *  `--node` value that is neither is a usage error, not a bogus URL. */
function resolveTarget(flags: GlobalFlags): ApiTarget {
	try {
		return resolveNodeTarget(flags.node);
	} catch (err) {
		if (err instanceof UnknownNodeError) {
			throw new UsageError(err.message);
		}
		throw err;
	}
}

/** Render a command failure to stderr and map it to an exit code (2 = usage). */
function reportFailure(io: CliIO, flags: GlobalFlags, err: unknown): number {
	if (flags.json) {
		io.err(`${JSON.stringify(errorToJson(err))}\n`);
	} else {
		io.err(`${tf("Error: {message}", { message: formatError(err) })}\n`);
	}
	return err instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
}

const defaultIo: CliIO = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

interface RunOverrides {
	api?: CoreApi;
	/** Fake Docker/host seams for `ryu secrets run --isolation=container`. */
	containerHost?: ContainerHost;
	/** Environment for credential lookups (`RYU_VAULT_TOKEN`). */
	env?: Record<string, string | undefined>;
	/** Fake HTTP for `ryu doctor agents` endpoint probes. */
	fetch?: FetchLike;
	io?: CliIO;
	/** Fake terminal answers for interactive commands (`ryu-cli agents access <id> pick`). */
	promptLine?: LinePrompter;
	/** Fake stdin for `ryu secrets set NAME -`. */
	readStdin?: () => Promise<string | null>;
	/** Fake scaffolder for `ryu init` — see {@link ScaffoldRunner}. */
	scaffold?: ScaffoldRunner;
	/** Fake child-process runner for `ryu secrets run`. */
	spawn?: ProcessRunner;
	target?: ApiTarget;
	/** Fake filesystem/network seams for `ryu troubleshoot`. */
	troubleshootHost?: TroubleshootHost;
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
	// `services` is located in the raw argv first: ryu-services value flags
	// before it (`--base-url URL`) take their value (see services.ts).
	const servicesAt = findServicesCommand(argv, new Set(VALUE_FLAGS.keys()));
	if (servicesAt !== -1 || parsed.command === SERVICES_COMMAND_NAME) {
		const at =
			servicesAt === -1 ? argv.length - parsed.rawArgs.length - 1 : servicesAt;
		return runServicesFromRyu(argv.slice(0, at), argv.slice(at + 1), {
			env: overrides.env,
			io,
		});
	}

	// --help / --version short-circuit any subcommand.
	if (flags.help) {
		io.out(`${renderHelp()}\n`);
		return EXIT_OK;
	}
	if (flags.version) {
		io.out(
			flags.json
				? `${JSON.stringify({ version: VERSION })}\n`
				: `ryu-cli ${VERSION}\n`
		);
		return EXIT_OK;
	}

	if (parsed.command === null) {
		// Reached only if a caller invokes runCli for an interactive argv; show help.
		io.out(`${renderHelp()}\n`);
		return EXIT_OK;
	}

	let target: ApiTarget;
	try {
		target = overrides.target ?? resolveTarget(flags);
	} catch (err) {
		return reportFailure(io, flags, err);
	}

	const ctx: CliContext = {
		api: overrides.api ?? realCoreApi,
		args: parsed.args,
		containerHost: overrides.containerHost,
		env: overrides.env ?? process.env,
		fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
		flags,
		io,
		promptLine: overrides.promptLine ?? promptLine,
		rawArgs: parsed.rawArgs,
		readStdin: overrides.readStdin ?? readStdin,
		scaffold: overrides.scaffold ?? realScaffold,
		spawn: overrides.spawn ?? runProcess,
		target,
		troubleshootHost: overrides.troubleshootHost,
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
		// A bad/missing argument is a usage error (2); anything else is runtime (1).
		return reportFailure(io, flags, err);
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

/** The "unknown command" contract shared by a missing app and a node that cannot
 *  list its apps. */
function reportUnknownCommand(io: CliIO, name: string): void {
	io.err(
		`${tf("Unknown command: {name}", { name })}\n${tr("Run 'ryu-cli help' to see available commands.")}\n`
	);
}

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
		reportUnknownCommand(ctx.io, appId);
		return EXIT_USAGE;
	}
	// Only an ENABLED, present (installed or built-in) app contributes commands. A
	// disabled/absent app id falls straight through to the same "unknown command"
	// message + exit 2 as before — never a call to its sidecar.
	const app = apps.find(
		(a) => a.id === appId && a.enabled && (a.installed || a.builtIn)
	);
	if (!app) {
		reportUnknownCommand(ctx.io, appId);
		return EXIT_USAGE;
	}

	const subName = ctx.args[0];
	// `ryu <app>` with no subcommand → list what the app contributes. (Global
	// `--help`/`-h` is handled node-lessly at the top of runCli and never reaches
	// here, preserving the offline-help guarantee.)
	if (!subName) {
		if (app.commands.length === 0) {
			ctx.io.out(
				`${tf("{name} ({id}) contributes no commands.", { id: app.id, name: app.name })}\n`
			);
			return EXIT_OK;
		}
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify(app.commands, null, 2)}\n`);
			return EXIT_OK;
		}
		const rows = app.commands.map((c) => [
			`ryu-cli ${app.id} ${c.name}`,
			c.summary ?? "",
		]);
		ctx.io.out(`${formatTable(["COMMAND", "SUMMARY"], rows)}\n`);
		return EXIT_OK;
	}

	const sub = app.commands.find((c) => c.name === subName);
	if (!sub) {
		const available =
			app.commands.map((c) => c.name).join(", ") || tr("(none)");
		ctx.io.err(
			`${tf("Unknown command '{command}' for app '{app}'. Available: {available}.", { app: app.id, available, command: subName })}\n`
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
