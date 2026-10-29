// packages/services-cli/src/mcp/registry.ts
//
// `registerServiceTools(server, ryu, { services, readOnly })`: registers the
// MCP tools of every service `ryu` is configured for (`ryu.isConfigured`), and
// for the rest only their credential-free status tools (`mail_status`,
// `messaging_status`) when `ryu.canCallWithoutCredentials` says the service's
// URL resolves, which then send no key (one stderr line per skipped
// service). The tools themselves are defined once, in the @ryuhq/services
// tool registry (`@ryuhq/services/tools`, `RYU_TOOLS`), which the Vercel
// AI SDK and @ryuhq/sdk Agent adapters read too. Each
// `src/mcp/tools/<svc>.ts` registers its service's registry tools as
// `register<Svc>Tools(server, ryu)`, and `MCP_TOOL_MODULES` lists those
// functions, through a registrar that enforces the conventions: the
// service-prefixed snake_case name, all four annotations, read-only
// filtering (the registry's `ryuToolPassesFilter`, the rule the adapters'
// `readOnly` applies too), and the `{ data, meta }` / `{ error }` result
// format.
//
// Like the adapters, the server registers only the read-only tools unless it
// is asked for writes (`readOnly: false`, the CLI's `--allow-writes`). With
// writes on, MCP hosts ask before running a tool whose annotations say it
// writes (destructiveHint, openWorldHint, readOnlyHint false), so the
// annotations are kept on every tool either way. Each registry tool also
// declares its MCP `outputSchema` (`{ data, meta }`, data typed per tool),
// which the MCP SDK checks every successful result against; a tool error
// (`isError: true`, `{ error }`) is not checked.

import type {
	McpServer,
	StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { Ryu, RyuError, RyuOptions, RyuService } from "@ryuhq/services";
import {
	createEnvReader,
	ENV_VARS,
	isRyuError,
	messageWithoutHint,
	resolveServiceConfig,
} from "@ryuhq/services";
import {
	credentialFreeRyuTools,
	invalidToolInput,
	RYU_TOOL_PREFIXES,
	RYU_TOOL_SERVICES,
	type RyuToolAnnotations,
	type RyuToolOutputSchema,
	ryuToolPassesFilter,
} from "@ryuhq/services/tools";
import type * as z from "zod";
import { connectMcpHint } from "../commands/connect.ts";
import { missingPhrase } from "../missing.ts";
import { runTool, type ToolResultOptions, toolFailure } from "./result.ts";
import { registerBoxTools } from "./tools/box.ts";
import { registerGatewayTools } from "./tools/gateway.ts";
import { registerMailTools } from "./tools/mail.ts";
import { registerManagedAgentsTools } from "./tools/managed-agents.ts";
import { registerMessagingTools } from "./tools/messaging.ts";
import { registerNotifyTools } from "./tools/notify.ts";
import { registerPassportTools } from "./tools/passport.ts";
import { registerSitesTools } from "./tools/sites.ts";

export { registerRegistryTools } from "./register.ts";

/** MCP tool annotations. All four are required so every tool states its effects. */
export type ServiceToolAnnotations = RyuToolAnnotations;

/** What a tool body gets besides its input. */
export interface ServiceToolRunContext {
	/** Fires when the MCP client cancels the request. */
	readonly signal: AbortSignal;
}

/** One service tool. */
export interface ServiceToolDefinition<
	Schema extends z.ZodObject = z.ZodObject,
> {
	readonly annotations: ServiceToolAnnotations;
	readonly description: string;
	readonly inputSchema: Schema;
	/** `<service prefix>_<verb>`, e.g. `notify_publish`. */
	readonly name: string;
	/**
	 * What a successful call answers (`{ data, meta }`), declared as the MCP
	 * `outputSchema`. Registry tools always carry one (`toolOutput(...)`);
	 * the MCP SDK then checks every successful `structuredContent` against
	 * it, and skips the check for an `isError` result.
	 */
	readonly outputSchema?: RyuToolOutputSchema;
	/**
	 * The tool body. Return the facade promise itself
	 * (`(input) => ryu.notify.publish(input)`), or `settled(call)` from an
	 * async body, so the result carries meta.
	 */
	run(input: z.output<Schema>, context: ServiceToolRunContext): unknown;
	readonly title: string;
}

/** What a tool module registers tools on. */
export interface ServiceToolRegistrar {
	/** The service these tools belong to. */
	readonly service: RyuService;
	/** Registers one tool (skipped in read-only mode unless `readOnlyHint` is true). */
	tool<Schema extends z.ZodObject>(
		definition: ServiceToolDefinition<Schema>
	): void;
}

/** A service's tool module entry point: `register<Svc>Tools(server, ryu)`. */
export type RegisterServiceToolsFn = (
	server: ServiceToolRegistrar,
	ryu: Ryu
) => void;

/** One service and its tool module. */
export interface ServiceToolModule {
	readonly register: RegisterServiceToolsFn;
	readonly service: RyuService;
}

const REGISTER_BY_SERVICE: Readonly<
	Partial<Record<RyuService, RegisterServiceToolsFn>>
> = {
	managedAgents: registerManagedAgentsTools,
	messaging: registerMessagingTools,
	mail: registerMailTools,
	notify: registerNotifyTools,
	box: registerBoxTools,
	gateway: registerGatewayTools,
	passport: registerPassportTools,
	sites: registerSitesTools,
};

/**
 * Every service with MCP tools, in the registry's order: one
 * `register<Svc>Tools` module per service in the @ryuhq/services tool
 * registry. Connect has none: it is an MCP server itself.
 */
export const MCP_TOOL_MODULES: readonly ServiceToolModule[] =
	RYU_TOOL_SERVICES.map((service) => {
		const register = REGISTER_BY_SERVICE[service];
		if (register === undefined) {
			throw new Error(`No MCP tool module for ${service}.`);
		}
		return { service, register };
	});

/** The tool-name prefix of each service. */
export const TOOL_PREFIXES: Readonly<Record<RyuService, string>> =
	RYU_TOOL_PREFIXES;

const TOOL_NAME = /^[a-z][a-z0-9_]*$/u;

/** Options for {@link registerServiceTools}. */
export interface RegisterServiceToolsOptions {
	/**
	 * The options `ryu` was built with. Optional and used only to word skip
	 * reasons (which env vars are missing); which services get tools is
	 * always decided by `ryu.isConfigured(service)`.
	 */
	readonly config?: RyuOptions;
	/** Receives one line per skipped service. Default: stderr. Never stdout. */
	readonly log?: (line: string) => void;
	/** Tool modules to use instead of {@link MCP_TOOL_MODULES} (tests). */
	readonly modules?: readonly ServiceToolModule[];
	/**
	 * The command line that runs the server (`ryu-cli services` when a host
	 * delegates); tool error hints name it in place of `ryu-services`.
	 */
	readonly program?: string;
	/**
	 * Register only tools whose `readOnlyHint` is true. Default `true`; pass
	 * `false` (the CLI's `--allow-writes`) to also register the tools that
	 * write, send, or delete.
	 */
	readonly readOnly?: boolean;
	/** Limit to these services. Default: every service. */
	readonly services?: readonly RyuService[];
}

/** What {@link registerServiceTools} did. */
export interface RegisterServiceToolsResult {
	/**
	 * Skipped (not configured) services whose credential-free tools were
	 * registered anyway, with those tool names. Their calls send no key.
	 * Each service here is also in `skipped`, never in `services`.
	 */
	readonly credentialFree: { service: RyuService; tools: string[] }[];
	/** Whether only read-only tools were registered (the mode in effect). */
	readonly readOnly: boolean;
	/** Services whose tool modules ran. */
	readonly services: RyuService[];
	/** Services left out, with the reason. */
	readonly skipped: { service: RyuService; reason: string }[];
	/** Every tool name registered. */
	readonly tools: string[];
	/**
	 * Tools of the registered services left out by read-only mode (the ones
	 * `--allow-writes` would add). Empty when writes are allowed.
	 */
	readonly withheld: string[];
}

function stderrLog(line: string): void {
	try {
		(
			globalThis as { process?: { stderr?: { write(s: string): unknown } } }
		).process?.stderr?.write(`${line}\n`);
	} catch {
		// Logging is best effort.
	}
}

/** True when env or the constructor options name the service explicitly (not only through defaults). */
export function explicitlyConfigured(
	service: RyuService,
	config: RyuOptions
): boolean {
	const read = createEnvReader(config.env);
	if (
		ENV_VARS.some(
			(row) => row.service === service && read(row.name) !== undefined
		)
	) {
		return true;
	}
	const scoped = (config as Record<string, unknown>)[service];
	if (
		typeof scoped === "object" &&
		scoped !== null &&
		Object.values(scoped).some((value) => value !== undefined)
	) {
		return true;
	}
	return (
		(service === "managedAgents" || service === "messaging") &&
		config.apiKey !== undefined
	);
}

function unsetReason(service: RyuService): string {
	const names = ENV_VARS.filter((row) => row.service === service).map(
		(row) => row.name
	);
	// Hosted Mail also takes the control-plane ryu_ key.
	if (service === "mail") {
		names.push("RYU_API_KEY");
	}
	return `not configured (set ${names.join(" or ")})`;
}

/**
 * The unregistered-tool reason for an SDK configuration error: the missing
 * settings spelled out, or the message without its `Hint:` suffix (the hint
 * is the SDK's advice for a thrown error, not part of a skip reason).
 */
export function configurationErrorReason(
	service: RyuService,
	error: Pick<RyuError, "details" | "hint" | "message">
): string {
	const missing = (error.details as { missing?: unknown } | null)?.missing;
	return Array.isArray(missing) && missing.length > 0
		? `not configured (${missingPhrase(service, missing.map(String))})`
		: messageWithoutHint(error);
}

/**
 * Why `service`'s tools should not be registered with `config`, or null when
 * they should: its configuration must resolve and be set explicitly, so a
 * default alone (Gateway's local URL) never exposes tools. Mirrors
 * `Ryu#isConfigured`, with the missing settings spelled out.
 */
export function configurationProblem(
	service: RyuService,
	config: RyuOptions
): string | null {
	let resolved: ReturnType<typeof resolveServiceConfig>;
	try {
		resolved = resolveServiceConfig(
			service,
			config,
			createEnvReader(config.env)
		);
	} catch (error) {
		if (!isRyuError(error)) {
			throw error;
		}
		return configurationErrorReason(service, error);
	}
	// Hosted Mail selected by the ryu_ key alone, as in `Ryu#isConfigured`.
	if (service === "mail" && resolved.auth === "x-api-key") {
		return null;
	}
	return explicitlyConfigured(service, config) ? null : unsetReason(service);
}

/**
 * Why `ryu` cannot serve `service`, or null when it can. The decision is
 * always `ryu.isConfigured(service)`; `config` (when given) only words the
 * reason with the settings that are missing.
 */
function skipReason(
	service: RyuService,
	ryu: Ryu,
	config: RyuOptions | undefined
): string | null {
	if (ryu.isConfigured(service)) {
		return null;
	}
	return (
		(config === undefined ? null : configurationProblem(service, config)) ??
		unsetReason(service)
	);
}

/**
 * What the MCP SDK sees as a tool's input schema: the zod schema's own JSON
 * Schema for `tools/list`, but a `validate` that accepts any object. The SDK
 * would otherwise reject bad arguments itself, as plain text
 * ("Input validation error: …") without `structuredContent`; the handler
 * parses with the zod schema instead, so a bad argument is the same
 * `invalid_arguments` RyuError here as in the adapters.
 */
function listedInputSchema(
	schema: z.ZodObject
): StandardSchemaWithJSON<Record<string, unknown>> {
	const standard = schema["~standard"];
	return {
		"~standard": {
			version: 1,
			vendor: "ryu-services",
			validate: (value) =>
				typeof value === "object" && value !== null && !Array.isArray(value)
					? { value: value as Record<string, unknown> }
					: { issues: [{ message: "Tool arguments must be an object." }] },
			jsonSchema: standard.jsonSchema,
		},
	};
}

function createRegistrar(
	server: McpServer,
	service: RyuService,
	readOnly: boolean,
	registered: string[],
	withheld: string[],
	only?: ReadonlySet<string>,
	resultOptions: ToolResultOptions = {}
): ServiceToolRegistrar {
	const prefix = TOOL_PREFIXES[service];
	return {
		service,
		tool<Schema extends z.ZodObject>(
			definition: ServiceToolDefinition<Schema>
		): void {
			if (
				!(TOOL_NAME.test(definition.name) && definition.name.startsWith(prefix))
			) {
				throw new Error(
					`MCP tool ${JSON.stringify(definition.name)} must be snake_case and start with ${prefix}.`
				);
			}
			// An unconfigured service registers only its credential-free tools;
			// the others need configuration, not --allow-writes, so they are
			// not counted as withheld.
			if (only !== undefined && !only.has(definition.name)) {
				return;
			}
			if (!ryuToolPassesFilter(definition, { readOnly })) {
				withheld.push(definition.name);
				return;
			}
			const zodSchema: z.ZodObject = definition.inputSchema;
			server.registerTool(
				definition.name,
				{
					title: definition.title,
					description: definition.description,
					inputSchema: listedInputSchema(zodSchema),
					...(definition.outputSchema === undefined
						? {}
						: { outputSchema: definition.outputSchema }),
					annotations: { ...definition.annotations, title: definition.title },
				},
				(input, ctx) => {
					// The registry's rule, as in the adapters: arguments the schema
					// rejects answer with RyuError `invalid_arguments` and the issues.
					const parsed = zodSchema.safeParse(input ?? {});
					if (!parsed.success) {
						return Promise.resolve(
							toolFailure(
								invalidToolInput(
									{ name: definition.name, service },
									parsed.error
								),
								resultOptions
							)
						);
					}
					return runTool(
						service,
						() =>
							definition.run(parsed.data as z.output<Schema>, {
								signal: ctx.mcpReq.signal,
							}),
						resultOptions
					);
				}
			);
			registered.push(definition.name);
		},
	};
}

/**
 * Registers the tools of every configured service on `server`. A service
 * whose configuration does not resolve registers nothing and is logged once
 * (to stderr by default; stdout carries JSON-RPC only).
 */
export function registerServiceTools(
	server: McpServer,
	ryu: Ryu,
	options: RegisterServiceToolsOptions = {}
): RegisterServiceToolsResult {
	const { config } = options;
	const log = options.log ?? stderrLog;
	const modules = options.modules ?? MCP_TOOL_MODULES;
	const wanted = options.services;
	const readOnly = options.readOnly !== false;
	const resultOptions: ToolResultOptions =
		options.program === undefined ? {} : { program: options.program };
	const result: RegisterServiceToolsResult = {
		credentialFree: [],
		readOnly,
		services: [],
		skipped: [],
		tools: [],
		withheld: [],
	};
	const consider = (service: RyuService) =>
		wanted === undefined || wanted.includes(service);
	for (const module of modules) {
		if (!consider(module.service)) {
			continue;
		}
		const problem = skipReason(module.service, ryu, config);
		if (problem !== null) {
			const fallback = credentialFreeRyuTools(ryu, module.service).map(
				(tool) => tool.name
			);
			const before = result.tools.length;
			if (fallback.length > 0) {
				module.register(
					createRegistrar(
						server,
						module.service,
						readOnly,
						result.tools,
						result.withheld,
						new Set(fallback),
						resultOptions
					),
					ryu
				);
			}
			const added = result.tools.slice(before);
			const reason =
				added.length === 0
					? problem
					: `${problem}; only ${added.join(", ")} ${added.length === 1 ? "is" : "are"} registered, which ${added.length === 1 ? "needs" : "need"} no credentials and ${added.length === 1 ? "sends" : "send"} none`;
			if (added.length > 0) {
				result.credentialFree.push({ service: module.service, tools: added });
			}
			result.skipped.push({ service: module.service, reason });
			log(`ryu-services mcp: skipping ${module.service}: ${reason}`);
			continue;
		}
		module.register(
			createRegistrar(
				server,
				module.service,
				readOnly,
				result.tools,
				result.withheld,
				undefined,
				resultOptions
			),
			ryu
		);
		result.services.push(module.service);
	}
	if (consider("connect") && !modules.some((m) => m.service === "connect")) {
		const env = config?.env === false ? {} : (config?.env ?? {});
		const why = "no tools (Connect is an MCP server itself)";
		// The reason reaches the model through the initialize instructions, so
		// it names env vars only; the stderr line may show the resolved URL.
		result.skipped.push({
			service: "connect",
			reason: `${why}. ${connectMcpHint({})}`,
		});
		log(`ryu-services mcp: skipping connect: ${why}. ${connectMcpHint(env)}`);
	}
	return result;
}
