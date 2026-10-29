// packages/services/src/tools/passport.ts
//
// Ryu Passport tools (`passport_*`): list profiles, list connections, and
// fetch through a connection. `passport_list_profiles` needs the
// administration token (RYU_PASSPORT_API_KEY); without it the tool answers
// with a configuration error naming that variable.
//
// Results are status metadata and redacted upstream content only: Passport
// never returns credential state. `passport_fetch` is a `GET` on the
// connection's exact HTTPS domain, so it reads; it is open-world because it
// reaches that site with the stored login. With RYU_PASSPORT_RUNTIME_KEY set
// it uses the runtime grant (scoped to the grant's profiles); otherwise the
// administration key, which Passport allows to `GET` only.

import * as z from "zod";
import type { Ryu } from "../ryu.ts";
import { READ } from "./annotations.ts";
import { toolOutput } from "./output.ts";
import { settled } from "./run.ts";
import { type AnyRyuTool, defineRyuTool } from "./types.ts";

const fetchInput = z.object({
	connectionId: z
		.string()
		.min(1)
		.describe("The connection id (conn_…) from passport_list_connections."),
	url: z
		.url()
		.describe(
			"An https:// URL on the connection's exact domain (port 443), e.g. https://api.github.com/user."
		),
	credentialHeaders: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			'Headers whose value may name the stored login as vault:<domain>, e.g. {"Authorization":"Bearer vault:api.github.com"}.'
		),
	headers: z
		.record(z.string(), z.string())
		.optional()
		.describe("Plain request headers."),
	maxContentChars: z
		.int()
		.min(1)
		.max(200_000)
		.optional()
		.describe(
			"Truncate the returned content to this many characters (default 20 000)."
		),
});

// Replies, mirroring the Passport decoders (passport/client.ts
// `passportConnectionSchema`, `passportProfileListSchema`,
// `passportConnectionListSchema`, `passportFetchResultSchema`);
// output.test.ts keeps them equal.

const connectionData = z.looseObject({
	created_at: z.number(),
	domain: z.string(),
	flow_status: z.enum(["IDLE", "IN_PROGRESS", "DONE", "FAILED"]),
	id: z.string(),
	last_checked: z.number(),
	profile_id: z.string(),
	source: z.string(),
	status: z.enum(["AUTHENTICATED", "NEEDS_AUTH"]),
	updated_at: z.number(),
});

/** `passport_list_profiles` data. */
export const PASSPORT_PROFILE_LIST_DATA = z.looseObject({
	profiles: z.array(
		z.looseObject({
			connections: z.array(connectionData),
			profile_id: z.string(),
		})
	),
});

/** `passport_list_connections` data. */
export const PASSPORT_CONNECTION_LIST_DATA = z.looseObject({
	connections: z.array(connectionData),
});

/** `passport_fetch` data. */
export const PASSPORT_FETCH_DATA = z.looseObject({
	authenticated: z.boolean(),
	content: z.string(),
	status: z.number(),
	truncated: z.boolean(),
	wwwAuthenticate: z.array(z.string()).optional(),
});

/** True when the tools should use the runtime grant (RYU_PASSPORT_RUNTIME_KEY). */
async function usesRuntimeGrant(ryu: Ryu): Promise<boolean> {
	return (await ryu.passport.runtime.connections.hasRuntimeGrant()) === true;
}

/** The Ryu Passport tools. */
export const PASSPORT_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "passport",
		name: "passport_list_profiles",
		title: "List Passport profiles",
		description:
			"Lists the tenant's identity profiles and each profile's connections (domain, status AUTHENTICATED or NEEDS_AUTH, login-flow state). Never returns credentials. Needs the administration token (RYU_PASSPORT_API_KEY); with only a runtime grant, use passport_list_connections.",
		inputSchema: z.object({}),
		annotations: READ,
		outputSchema: toolOutput(PASSPORT_PROFILE_LIST_DATA),
		run: (ryu) => ryu.passport.profiles.list(),
	}),
	defineRyuTool({
		service: "passport",
		name: "passport_list_connections",
		title: "List Passport connections",
		description:
			"Lists connections with their id, domain, profile and status: the runtime grant's profiles when RYU_PASSPORT_RUNTIME_KEY is set, otherwise every connection in the tenant. Never returns credentials.",
		inputSchema: z.object({}),
		annotations: READ,
		outputSchema: toolOutput(PASSPORT_CONNECTION_LIST_DATA),
		run: async (ryu) =>
			settled(
				(await usesRuntimeGrant(ryu))
					? ryu.passport.runtime.connections.list()
					: ryu.passport.connections.list()
			),
	}),
	defineRyuTool({
		service: "passport",
		name: "passport_fetch",
		title: "Fetch through a Passport connection",
		description:
			"Sends one GET to an https:// URL on an AUTHENTICATED connection's exact domain, attaching the stored login where credentialHeaders name vault:<domain>, and returns { status, authenticated, content, truncated } with credential values redacted. The upstream status is in the result; a 409 error means the connection needs a login.",
		inputSchema: fetchInput,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		outputSchema: toolOutput(PASSPORT_FETCH_DATA),
		run: async (ryu, { connectionId, ...input }) => {
			const body = { ...input, method: "GET" as const };
			return settled(
				(await usesRuntimeGrant(ryu))
					? ryu.passport.runtime.connections.fetch(connectionId, body)
					: ryu.passport.connections.fetch(connectionId, body)
			);
		},
	}),
];
