// Shared fakes for the `ryu-cli secrets` developer-loop tests: a node whose
// routes are `METHOD /path` → responder, a capturing IO, and native-complete
// vault fixtures (core-client validates every reply, so partial bodies fail).

import type { ApiTarget } from "@ryuhq/core-client/client";
import type { VaultScope, VaultSecret } from "@ryuhq/core-client/vault";
import { type RunOverrides, runCli } from "../cli/dispatch.ts";
import type { CoreApi } from "../cli/types.ts";

export interface NodeCall {
	body: string;
	headers: Headers;
	path: string;
	route: string;
}

export type Responder = (call: NodeCall) => Response | Promise<Response>;

export function fakeNode(routes: Record<string, Responder>) {
	const calls: NodeCall[] = [];
	const target: ApiTarget = {
		url: "http://node.test",
		token: "node-token",
		fetch: (input, init) => {
			const url = new URL(String(input));
			const call: NodeCall = {
				route: `${init?.method ?? "GET"} ${url.pathname}`,
				path: `${url.pathname}${url.search}`,
				body: String(init?.body ?? ""),
				headers: new Headers(init?.headers),
			};
			calls.push(call);
			const respond = routes[call.route];
			return Promise.resolve(
				respond
					? respond(call)
					: Response.json({ error: "no route" }, { status: 404 })
			);
		},
	};
	return { calls, target };
}

export function json(body: unknown): Responder {
	return () => Response.json(body);
}

function stubApi(): CoreApi {
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

export async function runSecrets(
	argv: string[],
	node: ReturnType<typeof fakeNode>,
	overrides: RunOverrides = {}
) {
	let out = "";
	let err = "";
	const code = await runCli(["secrets", ...argv], {
		api: stubApi(),
		env: { HOME: "/home/me" },
		promptLine: () => Promise.resolve(null),
		spawn: () => Promise.resolve(0),
		target: node.target,
		...overrides,
		io: {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		},
	});
	return { code, err, out };
}

export const TIMESTAMP = "2026-01-01T00:00:00Z";

export function secretRow(
	name: string,
	tags: string[],
	scope: VaultScope = "user"
): VaultSecret {
	return {
		name,
		scope,
		scopeId: "local",
		environment: "dev",
		path: "/",
		version: 1,
		status: "active",
		metadata: {
			description: "",
			tags,
			expiresAt: null,
			rotationPeriodSecs: null,
			generator: null,
			expandReferences: true,
			maxVersions: 10,
		},
		capabilities: ["read"],
		createdAt: TIMESTAMP,
		createdBy: null,
		updatedAt: TIMESTAMP,
		updatedBy: null,
		rotatedAt: null,
	};
}

export function listBody(secrets: VaultSecret[]) {
	return {
		secrets,
		node: {
			id: "local",
			scope: "local",
			orgId: null,
			teamId: null,
			ownerUserId: null,
		},
		caller: null,
		canManageShared: false,
		sharedRemote: false,
		sharedError: null,
		activeEnvironment: "dev",
		seal: {
			mode: "auto",
			sealed: false,
			shares: 0,
			threshold: 0,
			progress: 0,
			keyVersions: [1],
			activeKeyVersion: 1,
		},
	};
}

export function jsonExport(values: Record<string, string>) {
	return {
		format: "json",
		contentType: "application/json",
		count: Object.keys(values).length,
		environment: "dev",
		path: "/",
		content: JSON.stringify(values),
	};
}

export function lease(id: string, role = "db", revoked = false) {
	return {
		id,
		role,
		provider: "postgres",
		issuedTo: null,
		createdAt: TIMESTAMP,
		expiresAt: "2026-01-01T01:00:00Z",
		maxExpiresAt: "2026-01-02T00:00:00Z",
		renewable: true,
		revokedAt: revoked ? TIMESTAMP : null,
	};
}

export function credential(id: string, data: Record<string, string>) {
	return { credential: { data, lease: lease(id) } };
}

export function environments(...slugs: string[]) {
	return {
		active: slugs[0] ?? "default",
		environments: slugs.map((slug, position) => ({
			slug,
			name: slug,
			protected: false,
			requiredApprovals: 0,
			position,
		})),
	};
}
