// Shared fixtures for the `ryu secrets …` dispatch tests
// (`cli.secrets-dispatch.*.test.ts`): a fake node, IO capture, a stub
// CoreApi, and complete native wire models. Core is faked through the
// target's injected `fetch`, so nothing touches a node.

import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { z } from "zod";
import type { CliIO, CoreApi, ProcessRunner } from "../cli/types.ts";

export interface Call {
	body: z.infer<typeof appResponseValueSchema>;
	headers: Headers;
	method: string;
	path: string;
}

export function makeIo() {
	let outBuf = "";
	let errBuf = "";
	return {
		io: {
			out: (s) => {
				outBuf += s;
			},
			err: (s) => {
				errBuf += s;
			},
		} satisfies CliIO,
		out: () => outBuf,
		err: () => errBuf,
	};
}

export function stubApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
	};
}

// All local responders are statically checked against this fixture callback
// owner. Installed Zod callable admission only selects the callable branch;
// retain the original callback rather than its wrapping function/parser.
export type NodeResponder = (call: Call) => Response;
export type NodeRoute = z.infer<typeof appRequestValueSchema> | NodeResponder;
export interface NodeRoutes {
	[route: string]: NodeRoute;
}
export const callableAdmission = z.function();
export const nodeResponderAdmission = z.custom<NodeResponder>(
	(value) => callableAdmission.safeParse(value).success
);
export interface SpawnObservation {
	cmd: Parameters<ProcessRunner>[0];
	env: Parameters<ProcessRunner>[1];
}
export interface SpawnCapture {
	value: SpawnObservation | null;
}
export const vaultScanFields = z.looseObject({
	allow: z.array(z.string()),
	files: z.array(z.looseObject({ path: z.string(), content: z.string() })),
	knownValues: z.boolean(),
});
export const vaultScanRequestObservation = z.custom<
	z.infer<typeof vaultScanFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		vaultScanFields.safeParse(value).success
);

/** A fake node: `routes` maps `METHOD /path` (no query) to a JSON body. */
export function fakeNode(routes: NodeRoutes, url = "http://node.test") {
	const calls: Call[] = [];
	const target: ApiTarget = {
		url,
		token: "node-token",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const call: Call = {
				method: init?.method ?? "GET",
				path: `${url.pathname}${url.search}`,
				headers: new Headers(init?.headers),
				body:
					init?.body === undefined
						? undefined
						: appResponseValueSchema.parse(JSON.parse(String(init.body))),
			};
			calls.push(call);
			const route = routes[`${call.method} ${url.pathname}`];
			if (route === undefined) {
				return Response.json({ error: "no route" }, { status: 404 });
			}
			const responder = nodeResponderAdmission.safeParse(route);
			if (responder.success) {
				const respond = responder.data;
				return respond(call);
			}
			return Response.json(route);
		},
	};
	return { calls, target };
}

// Complete native wire models: core-client validates every Core vault reply
// against the vault_api.rs renderer contract, so partial fixtures are refused.
export const timestamp = "2026-01-01T00:00:00Z";
export const coords = {
	name: "API_KEY",
	scope: "user",
	scopeId: "local",
	environment: "prod",
	path: "/",
};
export const secret = {
	...coords,
	version: 3,
	status: "active",
	metadata: {
		description: "Stripe key",
		tags: [],
		expiresAt: null,
		rotationPeriodSecs: null,
		generator: null,
		expandReferences: true,
		maxVersions: 10,
	},
	capabilities: ["read"],
	createdAt: timestamp,
	createdBy: null,
	updatedAt: timestamp,
	updatedBy: null,
	rotatedAt: null,
};
export const seal = {
	mode: "auto",
	sealed: false,
	shares: 0,
	threshold: 0,
	progress: 0,
	keyVersions: [1, 2],
	activeKeyVersion: 2,
};
export function changeRequest(fields: { id: string; status: string }) {
	return {
		...fields,
		operation: "write",
		coords,
		hasValue: true,
		patch: {},
		requestedBy: "user-1",
		requestedAt: timestamp,
		approvals: [],
		requiredApprovals: 2,
		decidedBy: null,
		decidedAt: null,
		reason: null,
	};
}
export function exportResponse(format: string, content: string, count: number) {
	return {
		format,
		contentType: format === "json" ? "application/json" : "text/plain",
		count,
		environment: "prod",
		path: "/",
		content,
	};
}
export const issuedToken = {
	accessor: "acc_1",
	identityId: "mid_1",
	policies: ["ci"],
	expiresAt: "2030-01-01T00:00:00Z",
};
export const T = "2030-01-01T00:00:00Z";
export const CA_PEM =
	"-----BEGIN CERTIFICATE-----\nbroker\n-----END CERTIFICATE-----\n";
