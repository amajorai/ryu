// packages/services/src/tools/registry.ts
//
// The one registry of service tools. `ryu-services mcp`, `toAiSdkTools` and
// `toRyuAgentTools` all read `RYU_TOOLS`, so a tool's name, description,
// schema and annotations are the same wherever an agent meets it.
// `selectRyuTools` applies the options every adapter shares: which services,
// read-only by default, and include/exclude by tool name.

import type { RyuService } from "../errors.ts";
import type { Ryu } from "../ryu.ts";
import { BOX_TOOLS } from "./box.ts";
import {
	constructorOptionFor,
	ENV_VARS,
	RyuConfigurationError,
	serviceDocsUrl,
} from "./core.ts";
import { GATEWAY_TOOLS } from "./gateway.ts";
import { MAIL_TOOLS } from "./mail.ts";
import { MANAGED_AGENTS_TOOLS } from "./managed-agents.ts";
import { MESSAGING_TOOLS } from "./messaging.ts";
import { NOTIFY_TOOLS } from "./notify.ts";
import { PASSPORT_TOOLS } from "./passport.ts";
import { SITES_TOOLS } from "./sites.ts";
import type { AnyRyuTool } from "./types.ts";

/**
 * Each service's tools, in registration order. Connect has none: it is an
 * MCP server itself (`ryu.connect.mcpConfig()`).
 */
export const RYU_TOOLS_BY_SERVICE: Readonly<
	Partial<Record<RyuService, readonly AnyRyuTool[]>>
> = Object.freeze({
	managedAgents: MANAGED_AGENTS_TOOLS,
	messaging: MESSAGING_TOOLS,
	mail: MAIL_TOOLS,
	notify: NOTIFY_TOOLS,
	box: BOX_TOOLS,
	gateway: GATEWAY_TOOLS,
	passport: PASSPORT_TOOLS,
	sites: SITES_TOOLS,
});

/** The services that have tools, in registration order. */
export const RYU_TOOL_SERVICES: readonly RyuService[] = Object.freeze(
	Object.keys(RYU_TOOLS_BY_SERVICE) as RyuService[]
);

/** Every service tool. */
export const RYU_TOOLS: readonly AnyRyuTool[] = Object.freeze(
	RYU_TOOL_SERVICES.flatMap((service) => RYU_TOOLS_BY_SERVICE[service] ?? [])
);

/** The tool-name prefix of each service. */
export const RYU_TOOL_PREFIXES: Readonly<Record<RyuService, string>> =
	Object.freeze({
		managedAgents: "managed_agents_",
		messaging: "messaging_",
		mail: "mail_",
		notify: "notify_",
		box: "box_",
		gateway: "gateway_",
		connect: "connect_",
		passport: "passport_",
		sites: "sites_",
	});

/** The registry tool called `name`, or undefined. */
export function getRyuTool(name: string): AnyRyuTool | undefined {
	return RYU_TOOLS.find((tool) => tool.name === name);
}

/**
 * The credential-free tools of `service` (`credentialFree`, read-only by
 * rule) that `ryu` can call although `service` is not configured: empty
 * when `service` is configured (all of its tools apply), has no such tools,
 * or `ryu.canCallWithoutCredentials(service)` is false (self-hosted Mail
 * without its token, an invalid URL). What `ryu-services mcp` registers for
 * an unconfigured service; the adapters do not use it.
 */
export function credentialFreeRyuTools(
	ryu: Pick<Ryu, "canCallWithoutCredentials" | "isConfigured">,
	service: RyuService
): AnyRyuTool[] {
	if (ryu.isConfigured(service) || !ryu.canCallWithoutCredentials(service)) {
		return [];
	}
	return (RYU_TOOLS_BY_SERVICE[service] ?? []).filter(
		(tool) => tool.credentialFree === true && tool.annotations.readOnlyHint
	);
}

/** Options every tool adapter takes. */
export interface RyuToolSelection {
	/** Leave out these tool names. */
	readonly exclude?: readonly string[];
	/** Only these tool names. A write tool listed here still needs `readOnly: false`. */
	readonly include?: readonly string[];
	/**
	 * Expose only tools that change nothing (`readOnlyHint`). Default `true`:
	 * tools that send email or SMS, charge credit, run a model or an agent, or
	 * stop, delete or overwrite something appear only with `readOnly: false`.
	 */
	readonly readOnly?: boolean;
	/**
	 * Only these services. Default: every service `ryu` is configured for. A
	 * service named here that `ryu` cannot reach is a configuration error.
	 */
	readonly services?: readonly RyuService[];
}

/** What {@link ryuToolPassesFilter} checks: the per-tool part of the selection. */
export interface RyuToolFilter {
	readonly exclude?: readonly string[];
	readonly include?: readonly string[];
	/**
	 * Here `readOnly` has no default: the caller decides. Adapters and MCP both
	 * default to read-only; MCP opts out with `--allow-writes`.
	 */
	readonly readOnly: boolean;
}

/**
 * Whether one tool passes the read-only and include/exclude filter. The one
 * rule both the adapters (`selectRyuTools`) and `ryu-services mcp` apply, so
 * `readOnly` and the MCP read-only default (`--allow-writes` to opt out) cannot
 * drift apart.
 */
export function ryuToolPassesFilter(
	tool: Pick<AnyRyuTool, "annotations" | "name">,
	filter: RyuToolFilter
): boolean {
	if (filter.readOnly && !tool.annotations.readOnlyHint) {
		return false;
	}
	if (filter.include !== undefined && !filter.include.includes(tool.name)) {
		return false;
	}
	return !(filter.exclude ?? []).includes(tool.name);
}

/** The service a tool name belongs to by its prefix, or null for no known prefix. */
function serviceOfName(name: string): RyuService | null {
	return (
		(Object.keys(RYU_TOOL_PREFIXES) as RyuService[]).find((service) =>
			name.startsWith(RYU_TOOL_PREFIXES[service])
		) ?? null
	);
}

function configurationError(
	service: RyuService | null,
	message: string,
	details: unknown
) {
	return new RyuConfigurationError({
		// `service` is required on a RyuError; a name with no known prefix
		// belongs to no service, so the error says so in `details.service`.
		service: service ?? "managedAgents",
		status: 0,
		message,
		details: { ...(details as object), service },
	});
}

/**
 * What sets `service` up, for the not-configured error: the variables and
 * `new Ryu()` options it reads, and its docs page (the CLI is not on npm yet,
 * so the message cannot send people to `ryu-services doctor`).
 */
function setupHint(service: RyuService): string {
	const names = ENV_VARS.filter((row) => row.service === service).map(
		(row) => row.name
	);
	// Hosted Mail is also selected by the ryu_ key, whose row is Managed Agents'.
	if (service === "mail") {
		names.unshift("RYU_API_KEY");
	}
	const options = names.map(constructorOptionFor);
	return `${service} reads ${names.join(", ")} (new Ryu() options: ${options.join(", ")}); see ${serviceDocsUrl(service)}.`;
}

function checkNames(option: string, names: readonly string[] | undefined) {
	const unknown = (names ?? []).filter(
		(name) => getRyuTool(name) === undefined
	);
	if (unknown.length > 0) {
		throw configurationError(
			serviceOfName(unknown[0] ?? ""),
			`Unknown tool name in ${option}: ${unknown.join(", ")}. Tool names are listed in RYU_TOOLS.`,
			{ option, unknown }
		);
	}
}

function checkServices(services: readonly RyuService[] | undefined) {
	const known = Object.keys(RYU_TOOL_PREFIXES);
	const unknown = (services ?? []).filter(
		(service) => !known.includes(service)
	);
	if (unknown.length > 0) {
		throw configurationError(
			null,
			`Unknown service in services: ${unknown.join(", ")}. Services with tools: ${RYU_TOOL_SERVICES.join(", ")}.`,
			{ option: "services", unknown }
		);
	}
	if (services?.includes("connect")) {
		throw configurationError(
			"connect",
			"Connect has no tools: it is an MCP server itself. Add ryu.connect.mcpConfig() to your MCP client instead.",
			{ option: "services", unknown: [] }
		);
	}
}

/**
 * The registry tools an adapter should expose for `ryu`. Throws a
 * RyuConfigurationError for an unknown service or tool name, for `connect`
 * (which has no tools), for a write tool in `include` while `readOnly` is
 * on, for a listed service `ryu` is not configured for, and for a client
 * built with `result: "object"` (tool bodies need a throwing client), so a
 * wrong option never silently hides a tool or turns a failure into data.
 */
export function selectRyuTools(
	ryu: Pick<Ryu, "isConfigured" | "resultMode">,
	options: RyuToolSelection = {}
): AnyRyuTool[] {
	const readOnly = options.readOnly ?? true;
	if (ryu.resultMode !== "throw") {
		throw configurationError(
			null,
			'Service tools need a Ryu client in the default result mode; this one was built with result: "object". Pass new Ryu() (or new Ryu({ result: "throw" })).',
			{ option: "result", resultMode: ryu.resultMode }
		);
	}
	checkServices(options.services);
	checkNames("include", options.include);
	checkNames("exclude", options.exclude);
	if (readOnly) {
		const writes = (options.include ?? []).filter(
			(name) => getRyuTool(name)?.annotations.readOnlyHint === false
		);
		if (writes.length > 0) {
			throw configurationError(
				serviceOfName(writes[0] ?? ""),
				`${writes.join(", ")} change state or reach the outside world; pass readOnly: false to expose ${writes.length === 1 ? "it" : "them"}.`,
				{ option: "include", writes }
			);
		}
	}
	const explicit = options.services;
	if (explicit !== undefined) {
		const missing = explicit.filter((service) => !ryu.isConfigured(service));
		if (missing.length > 0) {
			throw configurationError(
				missing[0] ?? null,
				`Not configured: ${missing.join(", ")}. ${missing.map(setupHint).join(" ")} Every service in services must be configured; omit services to get tools for the configured services only.`,
				{ option: "services", missing }
			);
		}
	}
	const services =
		explicit ??
		RYU_TOOL_SERVICES.filter((service) => ryu.isConfigured(service));
	const filter: RyuToolFilter = {
		readOnly,
		...(options.include === undefined ? {} : { include: options.include }),
		...(options.exclude === undefined ? {} : { exclude: options.exclude }),
	};
	return RYU_TOOLS.filter(
		(tool) =>
			services.includes(tool.service) && ryuToolPassesFilter(tool, filter)
	);
}
