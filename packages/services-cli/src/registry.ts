// packages/services-cli/src/registry.ts
//
// The command registry: which services the CLI knows, which commands each
// one has, and the context a command runs with. Each service's commands live
// in `src/commands/<svc>.ts` as a `readonly ServiceCommand[]`; adding a
// command means appending to that array, nothing else. The docs guard
// imports SERVICE_COMMANDS to check every `ryu-services <svc> <cmd>` line in
// the public docs.

import {
	type Ryu,
	type RyuOptions,
	type RyuService,
	SERVICE_TITLES,
} from "@ryuhq/services";
import type { FlagSpecs, ParsedFlags } from "./args.ts";
import { boxCommands } from "./commands/box.ts";
import { connectCommands, connectPointer } from "./commands/connect.ts";
import { gatewayCommands } from "./commands/gateway.ts";
import { mailCommands } from "./commands/mail.ts";
import { managedAgentsCommands } from "./commands/managed-agents.ts";
import { messagingCommands } from "./commands/messaging.ts";
import { notifyCommands } from "./commands/notify.ts";
import { passportCommands } from "./commands/passport.ts";
import { sitesCommands } from "./commands/sites.ts";

/** A writable text sink (stdout, stderr, or a test buffer). */
export interface CliWriter {
	write(chunk: string): unknown;
}

/** Everything a command may read or write. Injected so tests never touch the process. */
export interface CommandIo {
	/** Environment variables (never read from `process.env` directly). */
	readonly env: Readonly<Record<string, string | undefined>>;
	/**
	 * The command line that runs this CLI (`ryu-services`, or `ryu-cli
	 * services` when a host delegates). Errors and hints name it; unset means
	 * `ryu-services`.
	 */
	readonly program?: string;
	/** Reads a local file as UTF-8 (`--html-file`, `deploy ./index.html`). */
	readFile(path: string): Promise<string>;
	/** Reads all of stdin as UTF-8. */
	readStdin(): Promise<string>;
	/**
	 * Reads all of stdin as raw bytes, never decoded (webhook payloads, whose
	 * signature covers the exact bytes). When absent, `readStdin()` is UTF-8
	 * encoded instead.
	 */
	readStdinBytes?(): Promise<Uint8Array>;
	readonly stderr: CliWriter;
	readonly stdout: CliWriter;
}

/** Per-call options the global flags set (`--idempotency-key`, `--timeout`). */
export interface CommandCallOptions {
	idempotencyKey?: string;
	timeoutMs?: number;
}

/** What a {@link ServiceCommand} runs with. */
export interface CommandContext {
	/** Positionals after the command path (`events get <id>` gives `[id]`). */
	readonly args: readonly string[];
	/**
	 * The per-call options from `--idempotency-key` and `--timeout`. `ctx.ryu`
	 * already applies them to every namespace; pass them yourself only to a
	 * client you build.
	 */
	readonly call: CommandCallOptions;
	/** True under `--dry-run`: the first request is captured and printed as curl, never sent. */
	readonly dryRun: boolean;
	/** Command and global flags, keyed by long name. Read them with the helpers in `args.ts`. */
	readonly flags: ParsedFlags;
	readonly io: CommandIo;
	/** True under `--json`. */
	readonly json: boolean;
	/**
	 * The options {@link CommandContext.ryu} was built from (env plus the
	 * global flags), for a command whose flags depend on how the service is
	 * reached, such as hosted or self-hosted Mail. Unset when a caller builds
	 * the context without them.
	 */
	readonly options?: RyuOptions<"throw">;
	/** Arguments after a bare `--`. */
	readonly rest: readonly string[];
	/**
	 * A throw-mode client built from env and the global flags, with
	 * {@link CommandContext.call} bound to every namespace (see
	 * {@link bindCallOptions}), so a user's idempotency key is never dropped.
	 */
	readonly ryu: Ryu;
}

/**
 * One `ryu-services <service> <path…>` command.
 *
 * `run` returns the result to print. Return the facade promise itself
 * (`return ctx.ryu.notify.publish(...)`, not `return await …`) so `--json`
 * can include the call's response meta; an async body that awaits something
 * first returns `settled(ctx.ryu.…)` (see `settled.ts`) instead. An async
 * iterable is printed one JSON line per item. Throw RyuError (the facade
 * already does) or CliUsageError.
 */
export interface ServiceCommand {
	/**
	 * For a command that makes several calls: a line `--dry-run` prints on
	 * stderr after the curl, saying which step was printed and how to see the
	 * one left out (a dry run prints only the first request). Return null when
	 * the command makes one call for these flags.
	 */
	dryRunNote?(ctx: CommandContext): string | null;
	/**
	 * What the command does outside this process, shown in its help, for
	 * writes that reach people or replace content (`mail send` sends real
	 * email). Omit for reads.
	 */
	readonly effect?: string;
	/** One runnable example invocation, shown in the command's help. */
	readonly example?: string;
	/** Command-specific flags. Names must not clash with the global flags. */
	readonly flags?: FlagSpecs;
	/** The words after the service name, e.g. `["events", "list"]`. */
	readonly path: readonly string[];
	/** True when the command only reads (shown in help). */
	readonly readOnly?: boolean;
	run(ctx: CommandContext): unknown;
	/** One line for help output. */
	readonly summary: string;
	/** Positional synopsis shown after the path, e.g. `<id>` or `<id> -- <cmd…>`. */
	readonly usage?: string;
}

/** CLI spelling of each service. */
export type CliServiceName =
	| "managed-agents"
	| "messaging"
	| "mail"
	| "notify"
	| "box"
	| "gateway"
	| "connect"
	| "passport"
	| "sites";

/** One service as the CLI presents it. */
export interface CliService {
	readonly commands: readonly ServiceCommand[];
	readonly name: CliServiceName;
	/** Printed instead of an error when the service has no CLI command for the input. */
	readonly pointer?: (env: CommandIo["env"]) => string;
	readonly service: RyuService;
	readonly title: string;
}

/** Every service the CLI knows, in help order. */
export const CLI_SERVICES: readonly CliService[] = [
	{
		name: "managed-agents",
		service: "managedAgents",
		title: `${SERVICE_TITLES.managedAgents} (preview)`,
		commands: managedAgentsCommands,
	},
	{
		name: "messaging",
		service: "messaging",
		title: `${SERVICE_TITLES.messaging} (early access)`,
		commands: messagingCommands,
	},
	{
		name: "mail",
		service: "mail",
		title: SERVICE_TITLES.mail,
		commands: mailCommands,
	},
	{
		name: "notify",
		service: "notify",
		title: SERVICE_TITLES.notify,
		commands: notifyCommands,
	},
	{
		name: "box",
		service: "box",
		title: SERVICE_TITLES.box,
		commands: boxCommands,
	},
	{
		name: "gateway",
		service: "gateway",
		title: SERVICE_TITLES.gateway,
		commands: gatewayCommands,
	},
	{
		name: "connect",
		service: "connect",
		title: SERVICE_TITLES.connect,
		commands: connectCommands,
		pointer: connectPointer,
	},
	{
		name: "passport",
		service: "passport",
		title: SERVICE_TITLES.passport,
		commands: passportCommands,
	},
	{
		name: "sites",
		service: "sites",
		title: SERVICE_TITLES.sites,
		commands: sitesCommands,
	},
];

/** Every service's commands, keyed by CLI service name. */
export const SERVICE_COMMANDS: Readonly<
	Record<CliServiceName, readonly ServiceCommand[]>
> = Object.fromEntries(
	CLI_SERVICES.map((entry) => [entry.name, entry.commands])
) as Record<CliServiceName, readonly ServiceCommand[]>;

/** The service with CLI name `name`, or undefined. */
export function findCliService(name: string): CliService | undefined {
	return CLI_SERVICES.find((entry) => entry.name === name);
}

/** The CLI name of a facade service key (`managedAgents` gives `managed-agents`). */
export function cliNameOf(service: RyuService): CliServiceName | undefined {
	return CLI_SERVICES.find((entry) => entry.service === service)?.name;
}

/**
 * The command whose path is the longest prefix of `positionals`, and the
 * positionals left after it. Null when none matches.
 */
export function matchCommand(
	commands: readonly ServiceCommand[],
	positionals: readonly string[]
): { command: ServiceCommand; args: readonly string[] } | null {
	let best: ServiceCommand | null = null;
	for (const command of commands) {
		const { path } = command;
		const matches =
			path.length <= positionals.length &&
			path.every((word, index) => positionals[index] === word);
		if (matches && (best === null || path.length > best.path.length)) {
			best = command;
		}
	}
	return best === null
		? null
		: { command: best, args: positionals.slice(best.path.length) };
}

/** `ryu-services <service> <path…>` for help and docs checks. */
export function commandLine(
	service: CliServiceName,
	command: ServiceCommand
): string {
	return ["ryu-services", service, ...command.path].join(" ");
}

interface WithCallOptions {
	with(options: CommandCallOptions): unknown;
}

function hasWith(value: unknown): value is WithCallOptions {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { with?: unknown }).with === "function"
	);
}

/**
 * `ryu` with `call` applied to every namespace (`ryu.notify`, `ryu.safe.box`,
 * …) through `.with(call)`. Commands therefore cannot forget
 * `--idempotency-key` or `--timeout`; calling `.with(ctx.call)` again merges
 * the same options and is harmless. Returns `ryu` itself when `call` is empty.
 */
export function bindCallOptions(ryu: Ryu, call: CommandCallOptions): Ryu {
	if (Object.values(call).every((value) => value === undefined)) {
		return ryu;
	}
	const namespaces = new Set<string>(
		CLI_SERVICES.map((entry) => entry.service)
	);
	const bindNamespaces = <T extends object>(target: T): T =>
		new Proxy(target, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof property !== "string") {
					return value;
				}
				if (namespaces.has(property) && hasWith(value)) {
					return value.with(call);
				}
				if (property === "safe" && typeof value === "object" && value) {
					return bindNamespaces(value);
				}
				return typeof value === "function" ? value.bind(object) : value;
			},
		});
	return bindNamespaces(ryu);
}
