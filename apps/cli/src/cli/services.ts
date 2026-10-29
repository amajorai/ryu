// `ryu services <args…>`: delegates to the `ryu-services` command line from
// `@ryuhq/services-cli` so the main CLI reaches Ryu's standalone services
// (Managed Agents, Messaging, Mail, Notify, Box, Gateway, Connect, Passport,
// Sites) without a second binary on PATH.
//
// Delegation is verbatim: every token after `services` is handed to
// `runCli` from `@ryuhq/services-cli` unparsed, so `ryu services mail send
// --help` shows ryu-services help (not `ryu help`) and `--json`, `--dry-run`,
// `--base-url` keep ryu-services semantics, and `ryu services -- …` hands the
// literal `--` on too. `services` is found in the raw argv before ryu's own
// parser runs (`findServicesCommand`), so a ryu-services value flag written
// with a space (`ryu --base-url URL services …`) takes its value instead of
// becoming ryu's command. A ryu-services global flag before `services`
// (`--json`, `--dry-run`, `-h`/`--help`, `--base-url URL`, `--timeout=5000`)
// is forwarded, because ryu-services reads global flags anywhere; any other
// token before it is refused with exit 2 and the exact command with it moved
// after `services`, never silently dropped (`--version` with a command, or a
// value flag with no value, gets a plain message instead). The dispatcher
// routes `services` before its own `--help`/`--version` short-circuit for
// that reason (see dispatch.ts).
//
// The `ryu` entry point (index.tsx) must list `services` among its
// access-free commands so the Ryu sign-in/waitlist gate never runs first.
//
// Configuration is the ryu-services contract: env vars and flags only, nothing
// written to disk, and no Core node involved. Exit codes are ryu-services' own
// (0 ok, 1 service error, 2 usage/configuration, 4 webhook verification).

import {
	type CliIo,
	EXIT_CODES,
	type FlagSpec,
	GLOBAL_FLAGS,
	matchCommand,
	runCli as runServicesCli,
	SERVICE_COMMANDS,
	type ServiceCommand,
} from "@ryuhq/services-cli";
import type { CliContext, CliIO, Command } from "./types.ts";
import { VERSION } from "./version.ts";

/** The `ryu` subcommand token that delegates to ryu-services. */
export const SERVICES_COMMAND_NAME = "services";

/** How users invoke the delegated CLI: `ryu-cli` is the bin `apps/cli`
 *  installs. ryu-services prints it in `mcp --help`, so the MCP client entry
 *  there runs with only ryu-cli installed (no `ryu-services` on PATH). */
export const SERVICES_PROGRAM = `ryu-cli ${SERVICES_COMMAND_NAME}`;

/** What ryu-services' npm-status note names as its origin: the delegated
 *  CLI is compiled into ryu-cli (a release binary), not a workspace build. */
export const SERVICES_BUNDLED_WITH = `ryu-cli ${VERSION}`;

/** Injected process surfaces for one delegated `ryu services` run. Unset
 *  fields fall back to the real process inside `@ryuhq/services-cli`. */
export interface ServicesDelegateIo {
	/** Environment the service clients read keys and base URLs from. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** HTTP for the service clients; default `globalThis.fetch`. */
	readonly fetch?: CliIo["fetch"];
	/** The `ryu` output sink; stdout/stderr are adapted onto it. */
	readonly io?: CliIO;
	/** `mcp` only: JSON-RPC streams; default `process.stdin` / `process.stdout`. */
	readonly mcpStdio?: CliIo["mcpStdio"];
	/** stdin for commands that read `-`; default raw `process.stdin` bytes. */
	readonly stdin?: CliIo["stdin"];
}

/** Adapts the `ryu` string sink onto the `{ write }` writers ryu-services uses. */
function servicesIo(delegate: ServicesDelegateIo): CliIo {
	const io: {
		-readonly [K in keyof CliIo]: CliIo[K];
	} = { bundledWith: SERVICES_BUNDLED_WITH, program: SERVICES_PROGRAM };
	if (delegate.io) {
		const { out, err } = delegate.io;
		io.stdout = { write: (chunk: string) => out(chunk) };
		io.stderr = { write: (chunk: string) => err(chunk) };
	}
	if (delegate.env) {
		io.env = delegate.env;
	}
	if (delegate.fetch) {
		io.fetch = delegate.fetch;
	}
	if (delegate.stdin !== undefined) {
		io.stdin = delegate.stdin;
	}
	if (delegate.mcpStdio) {
		io.mcpStdio = delegate.mcpStdio;
	}
	return io;
}

/**
 * Runs `ryu-services` with `argv` (the tokens after `ryu services`) and
 * resolves to its exit code. With no tokens it prints the ryu-services root
 * help to stdout and exits 0, mirroring `ryu <app>` listing what it offers.
 * Never throws: `runCli` already maps every failure to an exit code.
 */
export function runServices(
	argv: readonly string[],
	delegate: ServicesDelegateIo = {}
): Promise<number> {
	const tokens = argv.length === 0 ? ["--help"] : argv;
	return runServicesCli(tokens, servicesIo(delegate));
}

type SpecTable = Readonly<Record<string, FlagSpec | undefined>>;

/** The spec in `specs` for `token` (`--name`, `--name=value`, or a short
 *  `-x`), with its inline value; null when `specs` has no such flag. */
function lookupFlag(
	specs: SpecTable,
	token: string
): { spec: FlagSpec; inline: string | null } | null {
	if (token.startsWith("--")) {
		const equals = token.indexOf("=");
		const spec = specs[token.slice(2, equals === -1 ? undefined : equals)];
		return spec
			? { spec, inline: equals === -1 ? null : token.slice(equals + 1) }
			: null;
	}
	if (/^-[A-Za-z]$/u.test(token)) {
		const short = token.slice(1);
		const spec = Object.values(specs).find((entry) => entry?.short === short);
		return spec ? { spec, inline: null } : null;
	}
	return null;
}

const GLOBALS = GLOBAL_FLAGS as SpecTable;

/** True when `token` is a ryu-services global flag that takes a value and
 *  does not carry it inline (`--base-url URL`, `--api-key K`). */
function takesSeparateValue(token: string): boolean {
	const found = lookupFlag(GLOBALS, token);
	return (
		found !== null && found.spec.type !== "boolean" && found.inline === null
	);
}

/**
 * The index of the `services` command word in a whole `ryu` argv, or -1.
 * Runs before ryu's own `parseArgs`, which ignores unknown flags as booleans:
 * `ryu --base-url URL services …` would otherwise make `URL` the command (and
 * `--api-key K services …` would echo the key as an unknown command). Here
 * the ryu-services value flags and ryu's own value flags (`ryuValueFlags`,
 * plus `-f`) consume the next token, so the first remaining word decides.
 */
export function findServicesCommand(
	argv: readonly string[],
	ryuValueFlags: ReadonlySet<string>
): number {
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token === "--") {
			return argv[i + 1] === SERVICES_COMMAND_NAME ? i + 1 : -1;
		}
		if (!token.startsWith("-")) {
			return token === SERVICES_COMMAND_NAME ? i : -1;
		}
		if (
			token === "-f" ||
			ryuValueFlags.has(token) ||
			takesSeparateValue(token)
		) {
			i++;
		}
	}
	return -1;
}

/** One flag (with its value, when it takes one) written before `services`. */
interface LeadingFlag {
	/** `forward`: a ryu-services global flag, passed on as is. `version`:
	 *  `--version`/`-V`, valid only with no command. `dangling`: a value flag
	 *  with no value. `move`: anything else. */
	readonly kind: "dangling" | "forward" | "move" | "version";
	readonly tokens: readonly string[];
}

const VERSION_FLAGS = new Set(["--version", "-V"]);

/** Groups the tokens before `services` into flags. `commandFlags` are the
 *  flag specs of the command being run, so a command value flag written
 *  without a value (`--limit services …`) is reported, not moved. */
function leadingFlags(
	leading: readonly string[],
	commandFlags: SpecTable
): LeadingFlag[] {
	const flags: LeadingFlag[] = [];
	for (let i = 0; i < leading.length; i++) {
		const token = leading[i] ?? "";
		if (VERSION_FLAGS.has(token)) {
			flags.push({ kind: "version", tokens: [token] });
			continue;
		}
		const global = lookupFlag(GLOBALS, token);
		if (global === null) {
			const own = lookupFlag(commandFlags, token);
			const dangling =
				own !== null && own.spec.type !== "boolean" && own.inline === null;
			flags.push({ kind: dangling ? "dangling" : "move", tokens: [token] });
		} else if (global.spec.type === "boolean") {
			flags.push({
				kind: global.inline === null ? "forward" : "move",
				tokens: [token],
			});
		} else if (global.inline !== null) {
			flags.push({ kind: "forward", tokens: [token] });
		} else if (i + 1 < leading.length) {
			flags.push({ kind: "forward", tokens: [token, leading[i + 1] ?? ""] });
			i++;
		} else {
			flags.push({ kind: "dangling", tokens: [token] });
		}
	}
	return flags;
}

/** The flag specs of the command `words` name (`notify events list`), or {}. */
function commandFlagSpecs(words: readonly string[]): SpecTable {
	const [service, ...path] = words;
	const commands =
		service === undefined
			? undefined
			: (SERVICE_COMMANDS as Record<string, readonly ServiceCommand[]>)[
					service
				];
	return (commands && matchCommand(commands, path)?.command.flags) ?? {};
}

const HELP_FLAGS = new Set(["-h", "--help"]);

/** `token` quoted for a POSIX shell when it needs it. */
function shellWord(token: string): string {
	return /^[\w@%+=:,./-]+$/u.test(token)
		? token
		: `'${token.replaceAll("'", `'\\''`)}'`;
}

/** `tokens` for echoing: the `--api-key` value is replaced by `<key>`. */
function redactKey(tokens: readonly string[]): string[] {
	return tokens.map((token, index) => {
		if (token.startsWith("--api-key=")) {
			return "--api-key=<key>";
		}
		return tokens[index - 1] === "--api-key" ? "<key>" : shellWord(token);
	});
}

/**
 * The dispatcher's entry: `leading` is the `ryu` argv before `services` and
 * `rawArgs` the tokens after it. Global ryu-services flags before `services`
 * (with their values) are forwarded. Anything else there is a usage error
 * (exit 2, matching ryu-services' contract): an unknown token prints the
 * corrected command with it after the command words and before a literal
 * `--`; `--version` with a command, or a value flag with no value, prints a
 * plain message. An `--api-key` value is never echoed.
 */
export function runServicesFromRyu(
	leading: readonly string[],
	rawArgs: readonly string[],
	delegate: ServicesDelegateIo = {}
): Promise<number> {
	const write =
		delegate.io?.err ?? ((chunk: string) => process.stderr.write(chunk));
	const refuse = (message: string): Promise<number> => {
		write(`ryu-cli services: ${message}\n`);
		return Promise.resolve(EXIT_CODES.usage);
	};
	const dashes = rawArgs.indexOf("--");
	const head = dashes === -1 ? rawArgs : rawArgs.slice(0, dashes);
	const tail = dashes === -1 ? [] : rawArgs.slice(dashes);
	// A literal `--` before `services` only ended ryu's own options.
	const flags = leadingFlags(
		leading.filter((token) => token !== "--"),
		commandFlagSpecs(head)
	);
	const dangling = flags.find((flag) => flag.kind === "dangling");
	if (dangling) {
		return refuse(
			`${dangling.tokens[0]} before \`services\` has no value. Put it after the command with its value, for example: ryu-cli services <service> <command> ${dangling.tokens[0]} <value>`
		);
	}
	const forwarded = flags
		.filter((flag) => flag.kind !== "move")
		.flatMap((flag) => flag.tokens);
	const moved = flags
		.filter((flag) => flag.kind === "move")
		.flatMap((flag) => flag.tokens);
	if (flags.some((flag) => flag.kind === "version") && rawArgs.length > 0) {
		return refuse(
			"--version takes no service or command. Run: ryu-cli services --version"
		);
	}
	if (moved.length === 0) {
		// Like `runServices`: no command words prints the root help, unless
		// `--version` asked for the version.
		const wantsVersion = flags.some((flag) => flag.kind === "version");
		const tokens =
			rawArgs.length === 0 && !wantsVersion
				? ["--help", ...forwarded.filter((token) => !HELP_FLAGS.has(token))]
				: [...forwarded, ...rawArgs];
		return runServicesCli(tokens, servicesIo(delegate));
	}
	// Every echoed token goes through the redactor: an `--api-key` written
	// after `services` (either spelling) is as secret as one before it.
	const echoed = [...forwarded, ...head, ...moved, ...tail];
	const corrected = ["ryu-cli", "services", ...redactKey(echoed)].join(" ");
	const keyNote = echoed.some((token) => token.startsWith("--api-key"))
		? "\n  (replace <key> with your key, or set the service's key env var instead)"
		: "";
	return refuse(
		`${moved.map(shellWord).join(" ")} before \`services\` is not a ryu-services global flag, so it is not forwarded. Put it after the command:\n  ${corrected}${keyNote}`
	);
}

/** `ryu services …`: listed in `ryu help`. The dispatcher calls
 *  {@link runServices} directly with the raw argv (see the header note); this
 *  registry entry is the same delegation for any caller that resolves it. */
export const servicesCommand: Command = {
	name: SERVICES_COMMAND_NAME,
	summary: "Call Ryu's standalone services (delegates to ryu-services)",
	usage: "ryu services <service> <command> …",
	run: (ctx: CliContext) =>
		runServices(ctx.rawArgs, { env: ctx.env, io: ctx.io }),
};
