// packages/services-cli/src/mcp/server.ts
//
// `ryu-services mcp [--services a,b] [--allow-writes]`: a stdio MCP server
// named `ryu-services` exposing the tools of every configured service (only the
// read-only ones unless writes are allowed), following
// the `serveStdio` pattern in apps/mcp/src/index.ts. stdout carries JSON-RPC
// only; every diagnostic line goes to stderr.

import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/server";
import {
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { Ryu, type RyuOptions } from "@ryuhq/services";
import { connectMcpHint } from "../commands/connect.ts";
import { DEFAULT_PROGRAM, withProgram } from "../program.ts";
import { CLI_VERSION } from "../version.ts";
import {
	type RegisterServiceToolsOptions,
	type RegisterServiceToolsResult,
	registerServiceTools,
} from "./registry.ts";

/** The MCP server name hosts see. */
export const MCP_SERVER_NAME = "ryu-services";

/** Options for {@link createServicesMcpServer}. */
export interface ServicesMcpOptions
	extends Omit<RegisterServiceToolsOptions, "config"> {
	/** Options for the `Ryu` client the tools call (env, fetch, retries). */
	readonly config: RyuOptions<"throw">;
}

/**
 * Whether registration selected only services that have no tools here
 * (Connect, an MCP server itself), so the empty tool list is not fixed by
 * setting env vars. It does not say whether Connect itself is configured.
 */
export function onlyToollessSelected(
	registration: Pick<RegisterServiceToolsResult, "services" | "skipped">
): boolean {
	return (
		registration.services.length === 0 &&
		registration.skipped.length > 0 &&
		registration.skipped.every(({ service }) => service === "connect")
	);
}

/** The credential-free tools registered for services that are not configured. */
function credentialFreeTools(
	registration: Partial<Pick<RegisterServiceToolsResult, "credentialFree">>
): string[] {
	return (registration.credentialFree ?? []).flatMap(({ tools }) => tools);
}

function registeredLine(
	registration: Pick<RegisterServiceToolsResult, "services" | "skipped"> &
		Partial<Pick<RegisterServiceToolsResult, "credentialFree">>
): string {
	const free = credentialFreeTools(registration);
	const statusOnly =
		free.length === 0
			? ""
			: ` Without configuration, ${free.join(", ")} still ${free.length === 1 ? "runs" : "run"}: ${free.length === 1 ? "it reports whether the service is available on its server, needs no credentials and sends none" : "they report whether each service is available on its server, need no credentials and send none"}.`;
	if (registration.services.length > 0) {
		return `Registered services: ${registration.services.join(", ")}.${statusOnly}`;
	}
	if (onlyToollessSelected(registration)) {
		return "No tool-bearing service is selected, so no tools are registered. Connect has no tools here because it is an MCP server itself; the person running the server points their MCP client at Connect's /mcp instead (see below).";
	}
	if (free.length > 0) {
		return `No service is configured, so only the credential-free status ${free.length === 1 ? "tool" : "tools"} ${free.join(", ")} ${free.length === 1 ? "is" : "are"} registered; ${free.length === 1 ? "it needs" : "they need"} no credentials and ${free.length === 1 ? "sends" : "send"} none. The person running the server sets the env vars listed below in the MCP server entry's env, then restarts it, to add the other tools.`;
	}
	return "No service is configured, so no tools are registered. The person running the server sets the env vars listed below in the MCP server entry's env, then restarts it.";
}

/**
 * The `instructions` the server sends in its initialize result, so the model
 * (not only a person reading stderr) learns the mode in effect, which services
 * are registered, which were skipped and why (the env vars to set), and that
 * `ryu-services doctor` shows what resolves. Never includes a value: skip
 * reasons name settings, not secrets.
 */
export function mcpInstructions(
	registration: Pick<
		RegisterServiceToolsResult,
		"readOnly" | "services" | "skipped" | "tools" | "withheld"
	> &
		Partial<Pick<RegisterServiceToolsResult, "credentialFree">>,
	program: string = DEFAULT_PROGRAM
): string {
	const count = registration.tools.length;
	const lines = [
		`${MCP_SERVER_NAME}: tools for Ryu's standalone services, one prefix per service (notify_, box_, mail_, ...).`,
		registration.readOnly
			? `Mode: read-only. ${count} tool${count === 1 ? "" : "s"} registered; tools that write, send, or delete are left out${registration.withheld.length > 0 ? ` (${registration.withheld.length} withheld; the person running the server can add them with --allow-writes)` : ""}.`
			: `Mode: writes allowed (--allow-writes). ${count} tool${count === 1 ? "" : "s"} registered; the host's approval prompt is what stands between you and a write.`,
		registeredLine(registration),
	];
	if (registration.skipped.length > 0) {
		lines.push("Skipped services:");
		for (const { service, reason } of registration.skipped) {
			lines.push(`- ${service}: ${reason}`);
		}
	}
	lines.push(
		"Run `ryu-services doctor` in a terminal to see which settings resolve. Tool results are { data, meta } on success and { error } with a code (and a hint when one applies) on failure."
	);
	// The first line names the server (always `ryu-services`); every command
	// after it is the one this install runs.
	const [title = "", ...rest] = lines;
	return [title, ...rest.map((line) => withProgram(line, program))].join("\n");
}

/** Builds one MCP server with the tools of every configured service. */
export function createServicesMcpServer(options: ServicesMcpOptions): {
	registration: RegisterServiceToolsResult;
	server: McpServer;
} {
	const ryu = new Ryu(options.config);
	const registerOptions = { ...options, config: options.config };
	// The SDK takes `instructions` only at construction, and they describe
	// what registration did: plan on a scratch server (logging skips once),
	// then build the served server with the instructions, registering quietly.
	const registration = registerServiceTools(
		new McpServer({ name: MCP_SERVER_NAME, version: CLI_VERSION }),
		ryu,
		registerOptions
	);
	// Tools are always advertised, so a host sees an empty list (not an
	// unknown method) when no service is configured.
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, version: CLI_VERSION },
		{
			capabilities: { tools: {} },
			instructions: mcpInstructions(registration, options.program),
		}
	);
	registerServiceTools(server, ryu, {
		...registerOptions,
		log: () => undefined,
	});
	return { registration, server };
}

/**
 * The startup stderr line naming the active mode, so a person reading the
 * host's server log can tell whether write tools are exposed. The
 * `--allow-writes` hint is printed only when read-only mode left a write
 * tool out (`withheld`): with 0 tools the cause is missing configuration,
 * and a service with no write tools (Passport) would gain nothing. Without
 * `withheld` (an older caller), any registered tool keeps the hint.
 */
export function mcpModeLine(
	registration: Pick<RegisterServiceToolsResult, "readOnly" | "tools"> &
		Partial<Pick<RegisterServiceToolsResult, "withheld">>
): string {
	const count = registration.tools.length;
	const tools = `${count} tool${count === 1 ? "" : "s"}`;
	if (!registration.readOnly) {
		return `ryu-services mcp: writes allowed (--allow-writes), ${tools} registered. Your MCP host's approval prompt is what stands between the model and a write.`;
	}
	const line = `ryu-services mcp: read-only mode, ${tools} registered.`;
	const canWiden =
		registration.withheld === undefined
			? count > 0
			: registration.withheld.length > 0;
	return canWiden
		? `${line} Pass --allow-writes to also register the tools that write, send, or delete.`
		: line;
}

/**
 * The startup stderr line explaining an empty tool list, or null when tools
 * are registered or the selected services registered and read-only mode
 * withheld their tools ({@link mcpModeLine} says so). Only Connect selected
 * is not missing configuration, so that line repeats Connect's `/mcp` pointer
 * instead of sending the person to set env vars.
 */
export function emptyToolsLine(
	registration: Pick<
		RegisterServiceToolsResult,
		"services" | "skipped" | "tools"
	> &
		Partial<Pick<RegisterServiceToolsResult, "credentialFree">>,
	env: Readonly<Record<string, string | undefined>>
): string | null {
	if (registration.services.length > 0) {
		return null;
	}
	if (onlyToollessSelected(registration)) {
		const pointer = connectMcpHint(env);
		return `ryu-services mcp: no tool-bearing service is selected, so 0 tools are registered. Connect has no tools here because it is an MCP server itself; ${pointer.charAt(0).toLowerCase()}${pointer.slice(1)}`;
	}
	if (registration.tools.length > 0) {
		// No service is configured, so every registered tool is credential-free.
		const free = credentialFreeTools(registration);
		const names = free.length > 0 ? free : registration.tools;
		const one = names.length === 1;
		return `ryu-services mcp: no service is configured, so only the credential-free status ${one ? "tool" : "tools"} ${names.join(", ")} ${one ? "is" : "are"} registered. Run \`ryu-services doctor\` to see what resolves.`;
	}
	return "ryu-services mcp: no service is configured, so 0 tools are registered. Run `ryu-services doctor` to see what resolves.";
}

/** Options for {@link serveServicesMcp}. */
export interface ServeServicesMcpOptions extends ServicesMcpOptions {
	/** JSON-RPC input; default `process.stdin`. */
	readonly input?: Readable;
	/** JSON-RPC output; default `process.stdout`. */
	readonly output?: Writable;
}

/**
 * Serves MCP over stdio until the input ends. Tools are planned (and skipped
 * services logged, once) at startup, before the first message arrives.
 */
export function serveServicesMcp(
	options: ServeServicesMcpOptions
): Promise<void> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const log =
		options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const initial = createServicesMcpServer({ ...options, log });
	const empty = emptyToolsLine(
		initial.registration,
		options.config.env === false ? {} : (options.config.env ?? {})
	);
	if (empty !== null) {
		log(empty);
	}
	log(mcpModeLine(initial.registration));
	let first: McpServer | undefined = initial.server;
	const handle = serveStdio(
		() => {
			const server =
				first ??
				createServicesMcpServer({ ...options, log: () => undefined }).server;
			first = undefined;
			return server;
		},
		{
			legacy: "serve",
			transport: new StdioServerTransport(input, output),
			onerror: (error) => log(`ryu-services mcp: ${error.message}`),
		}
	);
	return new Promise<void>((resolve) => {
		const finish = () => {
			handle.close().then(resolve, () => resolve());
		};
		input.once("end", finish);
		input.once("close", finish);
	});
}
