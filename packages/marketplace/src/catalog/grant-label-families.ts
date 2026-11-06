// packages/marketplace/src/catalog/grant-label-families.ts
//
// Copy for the OPEN-ENDED permission grant families, whose last segment names a
// program, a host, an MCP server, an app or a Core capability chosen by the
// manifest (`tool:command:rg`, `tool:http-egress:api.exa.ai`, `mcp:places`).
// They cannot be listed one by one, so each family renders one whole ICU message
// with the segment as an argument ("Run the {command} command"): a translator
// sees the full sentence, and the segment is inserted verbatim as data. Exact
// registry entries win over a family (`mcp:server`, `app:http:@ryu/recipes`,
// `tool:http-egress:127.0.0.1` have their own copy).

import { translate as tl } from "@ryu/i18n/lite";

/** A grant's user-facing name and one-line explanation of what it allows. */
export interface GrantCopy {
	description: string;
	label: string;
}

const WILDCARD = "*";

function commandCopy(command: string): GrantCopy {
	if (command === WILDCARD) {
		return {
			label: tl("Run any allowed command"),
			description: tl(
				"Start any program the node owner has allowed for command tools, on this device, with the arguments its tools pass."
			),
		};
	}
	return {
		label: tl("Run the {command} command", { command }),
		description: tl(
			"Start the {command} program on this device, with the arguments its tools pass, when one of its tools is used.",
			{ command }
		),
	};
}

function egressCopy(host: string): GrantCopy {
	if (host === WILDCARD) {
		return {
			label: tl("Connect to any website"),
			description: tl(
				"Send requests from its tools to any internet address, including what you or an agent give those tools."
			),
		};
	}
	return {
		label: tl("Connect to {host}", { host }),
		description: tl(
			"Send requests from its tools to {host}, including what you or an agent give those tools.",
			{ host }
		),
	};
}

function mcpCopy(server: string): GrantCopy {
	return {
		label: tl("Use the {server} MCP server", { server }),
		description: tl(
			"Make the tools of the {server} MCP server available to agents, and run them when an agent calls them.",
			{ server }
		),
	};
}

function appHttpCopy(app: string): GrantCopy {
	return {
		label: tl("Call the {app} app", { app }),
		description: tl(
			"Send requests to the {app} app's server on your behalf, limited to the routes that app declares.",
			{ app }
		),
	};
}

function coreCopy(capability: string): GrantCopy {
	return {
		label: tl("Use the Ryu {capability} capability", { capability }),
		description: tl(
			"Call the built-in Ryu capability named {capability} on your behalf.",
			{ capability }
		),
	};
}

/** Family prefixes. None is a prefix of another, so the order does not change
 *  the result. A prefix matches case-insensitively; the segment after it keeps
 *  the manifest's spelling. */
const FAMILIES: ReadonlyArray<
	readonly [prefix: string, copy: (segment: string) => GrantCopy]
> = [
	["tool:http-egress:", egressCopy],
	["tool:command:", commandCopy],
	["app:http:", appHttpCopy],
	["mcp:", mcpCopy],
	["core:", coreCopy],
];

/** Translated copy for a grant in one of the open-ended families, or `null` when
 *  the grant belongs to none (or names an empty segment). */
export function grantFamilyCopy(grant: string): GrantCopy | null {
	const lower = grant.toLowerCase();
	for (const [prefix, copy] of FAMILIES) {
		if (!lower.startsWith(prefix)) {
			continue;
		}
		const segment = grant.slice(prefix.length).trim();
		return segment ? copy(segment) : null;
	}
	return null;
}
