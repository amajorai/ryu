// packages/services-cli/src/cli.ts
//
// `runCli(argv, io)`: the whole `ryu-services` command line as a function.
// stdout, stderr, env, fetch and stdin are injected, so `apps/cli` can
// delegate to it later and tests never touch the process. Config comes from
// env and flags only; nothing is written to disk.
//
// Exit codes: 0 success; 1 RyuError (code, message, requestId, hint); 2 usage
// or configuration error; 4 webhook verification failure.

import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { RyuFetch, RyuOptions, RyuService } from "@ryuhq/services";
import {
	isRyuError,
	NPM_PUBLISHED_VERSION,
	Ryu,
	RyuConfigurationError,
	type RyuError,
	SDK_DOCS_URL,
	serviceDocsUrl,
	toResult,
} from "@ryuhq/services";
import {
	assertKnownFlags,
	booleanFlag,
	CliUsageError,
	countFlag,
	type FlagSpecs,
	firstPositional,
	GLOBAL_FLAGS,
	mergeFlagSpecs,
	type ParsedArgs,
	type ParsedFlags,
	parseTokens,
	stringFlag,
} from "./args.ts";
import { DOCTOR_FLAGS, runDoctor } from "./commands/doctor.ts";
import {
	runWebhooksVerify,
	WEBHOOKS_VERIFY_FLAGS,
	WEBHOOKS_VERIFY_USAGE,
} from "./commands/webhooks.ts";
import {
	type CapturedRequest,
	collectSecrets,
	createCaptureFetch,
	dryRunCredentials,
	mailKeyField,
	placeholder,
	primaryKeyEnv,
	redactRequest,
	toCurl,
} from "./curl.ts";
import { serveServicesMcp } from "./mcp/server.ts";
import {
	type ErrorIo,
	EXIT_CODES,
	type ExitCode,
	printError,
	printStreamItem,
	printSuccess,
	printUsageError,
	toJson,
	writeLine,
} from "./output.ts";
import {
	DEFAULT_PROGRAM,
	shellWord,
	withProgram,
	workspaceLauncher,
	workspaceProgram,
} from "./program.ts";
import {
	bindCallOptions,
	CLI_SERVICES,
	type CliService,
	type CliWriter,
	type CommandContext,
	type CommandIo,
	commandLine,
	matchCommand,
	type ServiceCommand,
} from "./registry.ts";
import { unwrapSettled } from "./settled.ts";
import { CLI_VERSION, npmStatusNote } from "./version.ts";

/** Injected process surfaces. Every field defaults to the real process. */
export interface CliIo {
	/**
	 * The host that bundles this CLI, as users name it (`ryu-cli 0.4.0`).
	 * While `@ryuhq/services` is unpublished, `--version` and `doctor` then
	 * say the command line is bundled with it instead of calling it a
	 * workspace build. Unset for `ryu-services` itself.
	 */
	readonly bundledWith?: string;
	/** Environment; default `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** HTTP; default `globalThis.fetch`. */
	readonly fetch?: RyuFetch;
	/** `mcp` only: JSON-RPC streams; default `process.stdin` / `process.stdout`. */
	readonly mcpStdio?: { input: Readable; output: Writable };
	/**
	 * The `@ryuhq/services` npm version `--version` and `doctor` report;
	 * default `NPM_PUBLISHED_VERSION` (null while unpublished).
	 */
	readonly npmPublishedVersion?: string | null;
	/**
	 * The command line that invokes this CLI, as a user types it: default
	 * `ryu-services`. A host that delegates to `runCli` (`ryu-cli services`)
	 * sets it so every help, usage, example and hint line, the MCP server's
	 * instructions and its stderr lines name a command that host installs,
	 * and `mcp --help` prints a client entry that runs on a machine with only
	 * that host installed (its first word becomes the entry's `command`; the
	 * rest go first in `args`).
	 */
	readonly program?: string;
	/** File reads; default `node:fs/promises` readFile. */
	readonly readFile?: (path: string) => Promise<string>;
	readonly stderr?: CliWriter;
	/** stdin contents, a chunk stream, or a reader; default `process.stdin`. */
	readonly stdin?:
		| string
		| AsyncIterable<string | Uint8Array>
		| (() => Promise<string>);
	readonly stdout?: CliWriter;
}

/** `mcp` flags. */
export const MCP_FLAGS: FlagSpecs = {
	services: {
		type: "string",
		valueName: "a,b",
		description: "Only these services (CLI or SDK names, comma separated).",
	},
	"allow-writes": {
		type: "boolean",
		description:
			"Also register the tools that write, send, or delete (default: read-only tools only).",
	},
	"read-only": {
		type: "boolean",
		description:
			"Accepted for older configurations; read-only is already the default.",
	},
	timeout: GLOBAL_FLAGS.timeout,
	"max-retries": GLOBAL_FLAGS["max-retries"],
	help: GLOBAL_FLAGS.help,
};

/** The command line that runs this CLI when no host overrides it. */
export { DEFAULT_PROGRAM } from "./program.ts";

/**
 * The MCP client entry `<program> mcp --help` prints: the `mcpServers` shape
 * that `claude_desktop_config.json`, a project `.mcp.json` and most other MCP
 * clients read. `program` is the command line that invokes this CLI
 * (`ryu-services`, or `ryu-cli services` when ryu-cli delegates); its first
 * word is the `command` and the rest go first in `args`, so the entry runs
 * with only that program installed. Keys go in `env`; only the services you
 * set get tools.
 */
export function mcpClientExample(
	program: string | readonly string[] = DEFAULT_PROGRAM
): string[] {
	const words =
		typeof program === "string"
			? program.split(" ").filter(Boolean)
			: program.filter(Boolean);
	const [command = DEFAULT_PROGRAM, ...prefix] = words;
	const args = [...prefix, "mcp", "--services", "notify,box"];
	return [
		"MCP client configuration (claude_desktop_config.json, .mcp.json):",
		"  {",
		'    "mcpServers": {',
		'      "ryu-services": {',
		`        "command": ${JSON.stringify(command)},`,
		`        "args": [${args.map((arg) => JSON.stringify(arg)).join(", ")}],`,
		'        "env": { "RYU_NOTIFY_API_KEY": "<key>", "RYU_BOX_API_KEY": "<key>" }',
		"      }",
		"    }",
		"  }",
		"Add --allow-writes to the args to also expose the tools that write, send, or delete.",
		`In Claude Code: claude mcp add ryu-services --env RYU_NOTIFY_API_KEY=<key> -- ${[command, ...prefix].map(shellWord).join(" ")} mcp --services notify`,
		`Docs: ${SDK_DOCS_URL}/mcp`,
	];
}

/**
 * The entry a workspace build's `mcp --help` prints: it installs no
 * `ryu-services` executable, so the entry launches this checkout's bin.
 */
export function workspaceMcpExample(
	launcher: readonly string[] = workspaceLauncher()
): string[] {
	const [runtime = "bun"] = launcher;
	return [
		...mcpClientExample(launcher),
		`This is a workspace build, which installs no ryu-services executable, so the entry runs this checkout's bin with ${runtime}.`,
	];
}

/** The entry `ryu-services mcp --help` prints; see {@link mcpClientExample}. */
export const MCP_CLIENT_EXAMPLE: readonly string[] = mcpClientExample();

/**
 * `doctor` flags. It sends no service call of its own, so the request flags
 * (`--dry-run`, `--api-key`, `--base-url`, `--idempotency-key`,
 * `--max-retries`) are rejected rather than silently ignored.
 */
export const DOCTOR_COMMAND_FLAGS: FlagSpecs = {
	...DOCTOR_FLAGS,
	json: GLOBAL_FLAGS.json,
	timeout: {
		...GLOBAL_FLAGS.timeout,
		description: "Per-probe timeout for --check, in ms (default 10000).",
	},
	help: GLOBAL_FLAGS.help,
};

/** `webhooks verify` flags. It is offline, so no request flag applies. */
export const WEBHOOKS_COMMAND_FLAGS: FlagSpecs = {
	...WEBHOOKS_VERIFY_FLAGS,
	json: GLOBAL_FLAGS.json,
	help: GLOBAL_FLAGS.help,
};

/**
 * Parses a command that is not a service call. Global request flags parse
 * (so `--dry-run` is not reported as an unknown spelling) and are then
 * rejected by name with exit 2.
 */
function parseLocalCommand(
	tokens: readonly string[],
	allowed: FlagSpecs,
	commandName: string
): ParsedArgs {
	const parsed = parseTokens(tokens, mergeFlagSpecs(GLOBAL_FLAGS, allowed));
	assertKnownFlags(parsed.flags, allowed, commandName);
	return parsed;
}

/** Optional seams for embedding `runCli` (for example `apps/cli` delegation or tests). */
export interface RunCliOptions {
	/** Services and commands to use instead of {@link CLI_SERVICES}. */
	readonly services?: readonly CliService[];
}

interface ResolvedIo extends CommandIo {
	readonly fetch: RyuFetch | undefined;
	/**
	 * The command line usage and error hints name: `program`, or in a
	 * workspace build the `bun <checkout>/src/bin.ts` launch line that
	 * `mcp --help` prints, since no `ryu-services` executable exists there.
	 */
	readonly hintProgram: string;
	readonly mcpStdio: CliIo["mcpStdio"];
	/** `npmStatusNote` for this run: null once published. */
	readonly npmNote: string | null;
	readonly npmPublishedVersion: string | null;
	readonly program: string;
	readonly services: readonly CliService[];
	/**
	 * A workspace build run as `ryu-services`: no host named itself and
	 * `@ryuhq/services` is unpublished, so no `ryu-services` executable is
	 * installed and `mcp --help` prints a `bun <bin.ts>` entry instead.
	 */
	readonly workspaceBuild: boolean;
}

/** Collects a chunk stream as raw bytes; string chunks are UTF-8 encoded. */
async function readAllBytes(
	source: AsyncIterable<string | Uint8Array>
): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of source) {
		const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
		chunks.push(bytes);
		total += bytes.byteLength;
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function resolveIo(io: CliIo, services: readonly CliService[]): ResolvedIo {
	const { stdin } = io;
	let readStdinBytes: () => Promise<Uint8Array>;
	if (typeof stdin === "string") {
		readStdinBytes = () => Promise.resolve(new TextEncoder().encode(stdin));
	} else if (typeof stdin === "function") {
		readStdinBytes = async () => new TextEncoder().encode(await stdin());
	} else {
		const source = stdin ?? process.stdin;
		readStdinBytes = () => readAllBytes(source);
	}
	const npmPublishedVersion =
		io.npmPublishedVersion === undefined
			? NPM_PUBLISHED_VERSION
			: io.npmPublishedVersion;
	const program = io.program?.trim() || DEFAULT_PROGRAM;
	const workspaceBuild =
		npmPublishedVersion === null &&
		io.bundledWith === undefined &&
		program === DEFAULT_PROGRAM;
	return {
		env: io.env ?? process.env,
		fetch: io.fetch,
		mcpStdio: io.mcpStdio,
		npmNote: npmStatusNote({
			publishedVersion: npmPublishedVersion,
			...(io.bundledWith === undefined ? {} : { bundledWith: io.bundledWith }),
		}),
		npmPublishedVersion,
		program,
		readFile: io.readFile ?? ((path) => readFile(path, "utf8")),
		readStdin: async () => new TextDecoder().decode(await readStdinBytes()),
		readStdinBytes,
		services,
		stderr: io.stderr ?? process.stderr,
		stdout: io.stdout ?? process.stdout,
		workspaceBuild,
		hintProgram: workspaceBuild ? workspaceProgram() : program,
	};
}

/** The global flags, read once. */
interface GlobalOptions {
	readonly apiKey: string | undefined;
	readonly baseUrl: string | undefined;
	readonly dryRun: boolean;
	readonly help: boolean;
	readonly idempotencyKey: string | undefined;
	readonly json: boolean;
	readonly maxRetries: number | undefined;
	readonly timeoutMs: number | undefined;
}

function readGlobals(flags: ParsedFlags): GlobalOptions {
	return {
		apiKey: stringFlag(flags, "api-key"),
		baseUrl: stringFlag(flags, "base-url"),
		dryRun: booleanFlag(flags, "dry-run"),
		help: booleanFlag(flags, "help"),
		idempotencyKey: stringFlag(flags, "idempotency-key"),
		json: booleanFlag(flags, "json"),
		maxRetries: countFlag(flags, "max-retries"),
		timeoutMs: countFlag(flags, "timeout"),
	};
}

/** The exit code for a RyuError: 4 for webhook verification, 2 for configuration, else 1. */
export function exitCodeFor(error: RyuError): ExitCode {
	if (error.code.startsWith("webhook_")) {
		return EXIT_CODES.webhookVerification;
	}
	if (error instanceof RyuConfigurationError) {
		return EXIT_CODES.usage;
	}
	return EXIT_CODES.error;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { [Symbol.asyncIterator]?: unknown })[
			Symbol.asyncIterator
		] === "function"
	);
}

/**
 * Builds the client options for one service from env and the global flags.
 * `--base-url` and `--api-key` apply to that service only.
 */
export function buildRyuOptions(
	service: RyuService,
	globals: Pick<
		GlobalOptions,
		"apiKey" | "baseUrl" | "maxRetries" | "timeoutMs"
	>,
	env: Readonly<Record<string, string | undefined>>,
	fetch: RyuFetch | undefined
): RyuOptions<"throw"> {
	const base: RyuOptions<"throw"> = { env: { ...env } };
	if (fetch !== undefined) {
		base.fetch = fetch;
	}
	if (globals.maxRetries !== undefined) {
		base.maxRetries = globals.maxRetries;
	}
	if (globals.timeoutMs !== undefined) {
		base.timeoutMs = globals.timeoutMs;
	}
	const connection: { apiKey?: string; baseUrl?: string } = {};
	if (globals.baseUrl !== undefined) {
		connection.baseUrl = globals.baseUrl;
	}
	if (globals.apiKey !== undefined) {
		connection.apiKey = globals.apiKey;
	}
	switch (service) {
		case "mail": {
			const mail: NonNullable<RyuOptions["mail"]> = {};
			if (connection.baseUrl !== undefined) {
				mail.baseUrl = connection.baseUrl;
			}
			if (connection.apiKey !== undefined) {
				mail[mailKeyField(env, connection.baseUrl)] = connection.apiKey;
			}
			return { ...base, mail };
		}
		case "managedAgents":
			return { ...base, managedAgents: connection };
		case "messaging":
			return { ...base, messaging: connection };
		case "notify":
			return { ...base, notify: connection };
		case "box":
			return { ...base, box: connection };
		case "gateway":
			return { ...base, gateway: connection };
		case "connect":
			return { ...base, connect: connection };
		case "passport":
			return { ...base, passport: connection };
		case "sites":
			return { ...base, sites: connection };
		default:
			return base;
	}
}

function flagHelp(specs: FlagSpecs): string[] {
	return Object.entries(specs).map(([name, spec]) => {
		const short = spec.short ? `-${spec.short}, ` : "";
		const value =
			spec.type === "boolean" ? "" : ` <${spec.valueName ?? "value"}>`;
		const repeat = spec.type === "strings" ? " (repeatable)" : "";
		const required = spec.required === true ? " (required)" : "";
		return `  ${`${short}--${name}${value}`.padEnd(30)} ${spec.description}${repeat}${required}`;
	});
}

/** Flags accepted only with no command (`ryu-services --version`), never after one. */
const ROOT_ONLY_FLAGS: FlagSpecs = {
	version: {
		type: "boolean",
		short: "V",
		description:
			"Print the @ryuhq/services-cli version and exit. While @ryuhq/services is not on npm, a note on stderr says where this build came from.",
	},
};

const ROOT_FLAGS = mergeFlagSpecs(GLOBAL_FLAGS, ROOT_ONLY_FLAGS);

/** `ryu-services --help`. */
export function rootHelp(
	entries: readonly CliService[] = CLI_SERVICES
): string {
	const services = entries.map((entry) => {
		const count = entry.commands.length;
		const detail = entry.pointer
			? "MCP pointer"
			: `${count} command${count === 1 ? "" : "s"}`;
		return `  ${entry.name.padEnd(16)} ${entry.title} (${detail})`;
	});
	return [
		"ryu-services: command line and stdio MCP server for Ryu's standalone services",
		"",
		"Usage:",
		"  ryu-services <service> <command> [args] [flags]",
		"  ryu-services doctor [--check]",
		`  ${WEBHOOKS_VERIFY_USAGE}`,
		"  ryu-services mcp [--services notify,box] [--allow-writes]",
		"",
		"Services:",
		...services,
		"",
		"Global flags:",
		...flagHelp(GLOBAL_FLAGS),
		"",
		"With no command only (`ryu-services --version`, not after a service or command):",
		...flagHelp(ROOT_ONLY_FLAGS),
		"",
		"Exit codes: 0 success, 1 service error, 2 usage or configuration error, 4 webhook verification failed.",
		"Configuration comes from env vars and flags only; run `ryu-services doctor` to see what resolves.",
	].join("\n");
}

function commandSynopsis(entry: CliService, command: ServiceCommand): string {
	return [commandLine(entry.name, command), command.usage]
		.filter(Boolean)
		.join(" ");
}

/** `ryu-services <service> --help`. */
export function serviceHelp(entry: CliService): string {
	const lines = [`${entry.title}`, ""];
	if (entry.commands.length === 0) {
		lines.push("No commands yet.");
	} else {
		lines.push("Commands:");
		for (const command of entry.commands) {
			lines.push(
				`  ${commandSynopsis(entry, command).padEnd(48)} ${command.summary}`
			);
		}
	}
	return lines.join("\n");
}

/** `ryu-services <service> <command> --help`. */
export function commandHelp(
	entry: CliService,
	command: ServiceCommand
): string {
	const lines = [
		`Usage: ${commandSynopsis(entry, command)} [flags]`,
		"",
		command.summary,
	];
	if (command.effect !== undefined) {
		lines.push("", `Effect: ${command.effect}`);
	}
	const flags = command.flags ?? {};
	if (Object.keys(flags).length > 0) {
		lines.push("", "Flags:", ...flagHelp(flags));
	}
	lines.push("", "Global flags:", ...flagHelp(GLOBAL_FLAGS));
	if (command.example !== undefined) {
		lines.push("", "Example:", `  ${command.example}`);
	}
	lines.push("", `Docs: ${serviceDocsUrl(entry.service)}`);
	return lines.join("\n");
}

function printHelp(io: ResolvedIo, text: string, requested: boolean): ExitCode {
	writeLine(requested ? io.stdout : io.stderr, withProgram(text, io.program));
	return requested ? EXIT_CODES.ok : EXIT_CODES.usage;
}

function rejectPositionals(parsed: ParsedArgs, command: string): void {
	const extra = [...parsed.positionals, ...parsed.rest];
	if (extra.length > 0) {
		throw new CliUsageError(
			`${command} takes no arguments (got ${JSON.stringify(extra.join(" "))}).`
		);
	}
}

async function runDryRun(
	io: ResolvedIo,
	command: ServiceCommand,
	ctx: CommandContext,
	requests: readonly CapturedRequest[],
	curlOptions: { keyPlaceholder: string; secrets: string[] }
): Promise<ExitCode> {
	let failure: unknown;
	try {
		const value = await Promise.resolve(command.run(ctx));
		if (isAsyncIterable(value)) {
			const iterator = value[Symbol.asyncIterator]();
			try {
				await iterator.next();
			} finally {
				Promise.resolve(iterator.return?.()).catch(() => undefined);
			}
		}
	} catch (error) {
		failure = error;
	}
	if (requests.length > 0) {
		// A note means the printed requests stop before the command's last step.
		const note = command.dryRunNote?.(ctx) ?? null;
		if (ctx.json) {
			writeLine(
				io.stdout,
				toJson({
					data: {
						dryRun: true,
						complete: note === null,
						note,
						requests: requests.map((request) =>
							redactRequest(request, curlOptions)
						),
						curl: requests.map((request) => toCurl(request, curlOptions)),
					},
					meta: null,
				})
			);
		} else {
			writeLine(
				io.stdout,
				requests.map((request) => toCurl(request, curlOptions)).join("\n\n")
			);
		}
		if (note !== null) {
			writeLine(io.stderr, note);
		}
		return EXIT_CODES.ok;
	}
	if (failure !== undefined) {
		throw failure;
	}
	writeLine(io.stderr, "dry run: the command made no request.");
	return EXIT_CODES.ok;
}

async function printOutcome(
	io: ResolvedIo,
	json: boolean,
	run: () => unknown
): Promise<ExitCode> {
	const outcome = unwrapSettled(await toResult(Promise.resolve(run())));
	if (outcome.error !== null) {
		printError(hintIo(io), json, outcome.error);
		return exitCodeFor(outcome.error);
	}
	if (!isAsyncIterable(outcome.data)) {
		printSuccess(io.stdout, json, outcome.data, outcome.meta);
		return EXIT_CODES.ok;
	}
	try {
		for await (const item of outcome.data) {
			printStreamItem(io.stdout, item);
		}
	} catch (error) {
		if (!isRyuError(error)) {
			throw error;
		}
		printError(hintIo(io), json, error);
		return exitCodeFor(error);
	}
	return EXIT_CODES.ok;
}

/** Where errors print, naming the command line that actually runs this CLI. */
function hintIo(io: ResolvedIo): ErrorIo {
	return { program: io.hintProgram, stderr: io.stderr, stdout: io.stdout };
}

function runServiceCommand(
	io: ResolvedIo,
	entry: CliService,
	command: ServiceCommand,
	parsed: ParsedArgs,
	args: readonly string[]
): Promise<ExitCode> {
	const globals = readGlobals(parsed.flags);
	const service = entry.service;
	const capture = globals.dryRun ? createCaptureFetch() : null;
	let options: RyuOptions<"throw">;
	if (capture === null) {
		options = buildRyuOptions(service, globals, io.env, io.fetch);
	} else {
		const credentials = dryRunCredentials(service, io.env, {
			apiKey: globals.apiKey,
			baseUrl: globals.baseUrl,
		});
		options = {
			...buildRyuOptions(
				service,
				{ ...globals, apiKey: credentials.apiKey },
				credentials.env,
				capture.fetch
			),
			maxRetries: 0,
		};
	}
	const call: CommandContext["call"] = {};
	if (globals.idempotencyKey !== undefined) {
		call.idempotencyKey = globals.idempotencyKey;
	}
	if (globals.timeoutMs !== undefined) {
		call.timeoutMs = globals.timeoutMs;
	}
	const ctx: CommandContext = {
		args,
		call,
		dryRun: capture !== null,
		flags: parsed.flags,
		io,
		json: globals.json,
		options,
		rest: parsed.rest,
		ryu: bindCallOptions(new Ryu(options), call),
	};
	if (capture !== null) {
		return runDryRun(io, command, ctx, capture.requests, {
			keyPlaceholder: placeholder(
				primaryKeyEnv(
					service,
					io.env,
					globals.baseUrl,
					globals.apiKey !== undefined
				)
			),
			secrets: collectSecrets(io.env, globals.apiKey),
		});
	}
	return printOutcome(io, globals.json, () => command.run(ctx));
}

async function dispatchService(
	io: ResolvedIo,
	entry: CliService,
	tokens: readonly string[]
): Promise<ExitCode> {
	const specs = mergeFlagSpecs(
		GLOBAL_FLAGS,
		...entry.commands.map((command) => command.flags ?? {})
	);
	const parsed = parseTokens(tokens, specs);
	const globals = readGlobals(parsed.flags);
	const match = matchCommand(entry.commands, parsed.positionals);
	if (match === null) {
		const bare = parsed.positionals.length === 0;
		if (entry.pointer) {
			const text = entry.pointer(io.env);
			if (bare) {
				printSuccess(io.stdout, globals.json, text, null);
				return EXIT_CODES.ok;
			}
			throw new CliUsageError(
				`Unknown ${entry.name} command ${JSON.stringify(parsed.positionals.join(" "))}. ${text.replaceAll("\n", " ")}`
			);
		}
		if (bare) {
			return printHelp(io, serviceHelp(entry), globals.help);
		}
		const group = entry.commands.filter((command) =>
			parsed.positionals.every(
				(word, index) =>
					index < command.path.length - 1 && command.path[index] === word
			)
		);
		if (group.length > 0) {
			return printHelp(
				io,
				serviceHelp({ ...entry, commands: group }),
				globals.help
			);
		}
		throw new CliUsageError(
			`Unknown ${entry.name} command ${JSON.stringify(parsed.positionals.join(" "))}. Run ryu-services ${entry.name} --help.`
		);
	}
	const { command, args } = match;
	if (globals.help) {
		return printHelp(io, commandHelp(entry, command), true);
	}
	try {
		assertKnownFlags(
			parsed.flags,
			mergeFlagSpecs(GLOBAL_FLAGS, command.flags ?? {}),
			commandLine(entry.name, command)
		);
		return await runServiceCommand(io, entry, command, parsed, args);
	} catch (error) {
		// A usage mistake in a known command points at that command's help,
		// which lists its flags, rather than at the root help.
		if (error instanceof CliUsageError && error.hint === undefined) {
			throw new CliUsageError(error.message, {
				hint: `Run ${commandLine(entry.name, command)} --help for usage.`,
			});
		}
		throw error;
	}
}

function parseServiceList(
	value: string | undefined,
	entries: readonly CliService[]
): RyuService[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const services: RyuService[] = [];
	for (const name of value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)) {
		const entry = entries.find(
			(item) => item.name === name || item.service === name
		);
		if (entry === undefined) {
			throw new CliUsageError(
				`Unknown service ${JSON.stringify(name)} in --services. Known: ${entries.map((item) => item.name).join(", ")}.`
			);
		}
		services.push(entry.service);
	}
	return services;
}

async function dispatchMcp(
	io: ResolvedIo,
	tokens: readonly string[]
): Promise<ExitCode> {
	const parsed = parseTokens(tokens, MCP_FLAGS);
	if (booleanFlag(parsed.flags, "help")) {
		return printHelp(
			io,
			[
				`Usage: ${io.program} mcp [flags]`,
				"",
				"Serves only the read-only tools unless --allow-writes is passed.",
				`Only services whose env vars are set get tools, except the credential-free status tools (mail_status, messaging_status), which are registered even when Mail or Messaging is not configured unless --services leaves that service out; run \`${io.program} doctor\` to check.`,
				"",
				"Flags:",
				...flagHelp(MCP_FLAGS),
				"",
				...(io.workspaceBuild
					? workspaceMcpExample()
					: mcpClientExample(io.program)),
			].join("\n"),
			true
		);
	}
	rejectPositionals(parsed, "ryu-services mcp");
	const allowWrites = booleanFlag(parsed.flags, "allow-writes");
	if (allowWrites && booleanFlag(parsed.flags, "read-only")) {
		throw new CliUsageError(
			"Pass either --allow-writes or --read-only to ryu-services mcp, not both."
		);
	}
	const config: RyuOptions<"throw"> = { env: { ...io.env } };
	if (io.fetch !== undefined) {
		config.fetch = io.fetch;
	}
	const maxRetries = countFlag(parsed.flags, "max-retries");
	if (maxRetries !== undefined) {
		config.maxRetries = maxRetries;
	}
	const timeoutMs = countFlag(parsed.flags, "timeout");
	if (timeoutMs !== undefined) {
		config.timeoutMs = timeoutMs;
	}
	await serveServicesMcp({
		config,
		services: parseServiceList(
			stringFlag(parsed.flags, "services"),
			io.services
		),
		readOnly: !allowWrites,
		// Tool-error hints, instructions and log lines name commands to run.
		program: io.hintProgram,
		log: (line) => writeLine(io.stderr, withProgram(line, io.hintProgram)),
		...(io.mcpStdio ?? {}),
	});
	return EXIT_CODES.ok;
}

async function dispatch(
	io: ResolvedIo,
	argv: readonly string[]
): Promise<ExitCode> {
	const head = firstPositional(argv, GLOBAL_FLAGS);
	if (head === null) {
		const parsed = parseTokens(argv, ROOT_FLAGS);
		rejectPositionals(parsed, "ryu-services");
		if (
			booleanFlag(parsed.flags, "version") &&
			!booleanFlag(parsed.flags, "help")
		) {
			if (booleanFlag(parsed.flags, "json")) {
				writeLine(
					io.stdout,
					toJson({
						data: {
							name: "ryu-services",
							npmNote: io.npmNote,
							npmPublishedVersion: io.npmPublishedVersion,
							version: CLI_VERSION,
						},
						meta: null,
					})
				);
				return EXIT_CODES.ok;
			}
			// stdout stays the bare version for scripts; the npm note goes to stderr.
			writeLine(io.stdout, CLI_VERSION);
			if (io.npmNote !== null) {
				writeLine(io.stderr, `note: ${io.npmNote}`);
			}
			return EXIT_CODES.ok;
		}
		return printHelp(
			io,
			rootHelp(io.services),
			booleanFlag(parsed.flags, "help")
		);
	}
	const tokens = [...argv.slice(0, head.index), ...argv.slice(head.index + 1)];
	switch (head.value) {
		case "help": {
			const topic = parseTokens(tokens, GLOBAL_FLAGS).positionals[0];
			const entry = io.services.find((item) => item.name === topic);
			return printHelp(
				io,
				entry ? serviceHelp(entry) : rootHelp(io.services),
				true
			);
		}
		case "doctor": {
			const parsed = parseLocalCommand(
				tokens,
				DOCTOR_COMMAND_FLAGS,
				"ryu-services doctor"
			);
			const globals = readGlobals(parsed.flags);
			if (globals.help) {
				return printHelp(
					io,
					[
						"Usage: ryu-services doctor [--check] [--json] [--timeout ms]",
						"",
						"Flags:",
						...flagHelp(DOCTOR_COMMAND_FLAGS),
					].join("\n"),
					true
				);
			}
			rejectPositionals(parsed, "ryu-services doctor");
			return await runDoctor({
				check: booleanFlag(parsed.flags, "check"),
				fetch: io.fetch ?? globalThis.fetch,
				// Doctor's hints and report lines are commands to run, so in a
				// workspace build they name the `bun <bin.ts>` launch line.
				io: { ...io, program: io.hintProgram },
				json: globals.json,
				npmNote: io.npmNote,
				npmPublishedVersion: io.npmPublishedVersion,
				...(globals.timeoutMs === undefined
					? {}
					: { timeoutMs: globals.timeoutMs }),
			});
		}
		case "webhooks": {
			const parsed = parseLocalCommand(
				tokens,
				WEBHOOKS_COMMAND_FLAGS,
				"ryu-services webhooks verify"
			);
			const globals = readGlobals(parsed.flags);
			const [sub, ...extra] = parsed.positionals;
			if (globals.help || sub === undefined) {
				return printHelp(
					io,
					[
						`Usage: ${WEBHOOKS_VERIFY_USAGE}`,
						"",
						"Flags:",
						...flagHelp(WEBHOOKS_COMMAND_FLAGS),
					].join("\n"),
					globals.help
				);
			}
			if (sub !== "verify" || extra.length > 0) {
				throw new CliUsageError(
					`Unknown webhooks command ${JSON.stringify(parsed.positionals.join(" "))}. Use: ryu-services webhooks verify.`
				);
			}
			return await runWebhooksVerify(parsed.flags, io, globals.json);
		}
		case "mcp":
			return await dispatchMcp(io, tokens);
		default: {
			const entry = io.services.find((item) => item.name === head.value);
			if (entry === undefined) {
				throw new CliUsageError(
					`Unknown command ${JSON.stringify(head.value)}.`
				);
			}
			return await dispatchService(io, entry, tokens);
		}
	}
}

/**
 * Runs `ryu-services` with `argv` (without the node and script paths) and
 * resolves to the exit code. Never calls `process.exit`.
 */
export async function runCli(
	argv: readonly string[],
	io: CliIo = {},
	options: RunCliOptions = {}
): Promise<number> {
	const resolved = resolveIo(io, options.services ?? CLI_SERVICES);
	const json = argv.includes("--json");
	try {
		return await dispatch(resolved, argv);
	} catch (error) {
		if (error instanceof CliUsageError) {
			printUsageError(hintIo(resolved), json, error.message, error.hint);
			return EXIT_CODES.usage;
		}
		if (isRyuError(error)) {
			printError(hintIo(resolved), json, error);
			return exitCodeFor(error);
		}
		const message = error instanceof Error ? error.message : String(error);
		if (json) {
			writeLine(
				resolved.stdout,
				toJson({ error: { code: "internal_error", message } })
			);
		} else {
			writeLine(resolved.stderr, `error internal_error: ${message}`);
		}
		return EXIT_CODES.error;
	}
}
