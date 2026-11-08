// Shared fakes for the AI agent redaction tests: native-complete listing
// rows, a node whose routes may answer each call differently (so a test can
// re-type a value between the CLI's checks), and a CLI runner with an agent
// marker set.

import type { ApiTarget } from "@ryuhq/core-client/client";
import type { VaultSecret } from "@ryuhq/core-client/vault";
import { runCli } from "../cli/dispatch.ts";
import type { CoreApi, ProcessRunner } from "../cli/types.ts";

export const T = "2026-01-01T00:00:00Z";
export const AGENT_ENV = {
	HOME: "/home/me",
	PATH: "/usr/bin",
	CLAUDECODE: "1",
};

export interface Row {
	environment?: string;
	name: string;
	path?: string;
	scope?: VaultSecret["scope"];
	scopeId?: string;
	valueType?: string;
}

export function row(spec: Row): VaultSecret {
	return {
		scope: spec.scope ?? "user",
		scopeId: spec.scopeId ?? "u1",
		environment: spec.environment ?? "dev",
		path: spec.path ?? "/",
		name: spec.name,
		version: 1,
		status: "active",
		metadata: {
			description: "",
			tags: [],
			expiresAt: null,
			rotationPeriodSecs: null,
			generator: null,
			expandReferences: false,
			maxVersions: 10,
			...(spec.valueType === undefined
				? {}
				: { valueType: spec.valueType as "config" }),
		},
		capabilities: ["list", "read"],
		createdAt: T,
		createdBy: null,
		updatedAt: T,
		updatedBy: null,
		rotatedAt: null,
	};
}

export function listing(rows: Row[], sharedError: string | null = null) {
	return {
		activeEnvironment: "dev",
		caller: null,
		canManageShared: false,
		node: {
			id: "n1",
			orgId: null,
			ownerUserId: null,
			scope: "local",
			teamId: null,
		},
		seal: {
			activeKeyVersion: 1,
			keyVersions: [1],
			mode: "auto",
			progress: 0,
			sealed: false,
			shares: 1,
			threshold: 1,
		},
		secrets: rows.map(row),
		sharedError,
		sharedRemote: sharedError !== null,
	};
}

export function exportBody(values: Record<string, string>) {
	return {
		format: "json",
		contentType: "application/json",
		count: Object.keys(values).length,
		environment: "dev",
		path: "/",
		content: JSON.stringify(values),
	};
}

export type Responder = () => Response;

/** A fake node. A route given a list answers each call with the next entry
 *  (the last one repeats), so a test can change a value's type between the
 *  CLI's checks. */
export function fakeNode(routes: Record<string, Responder | Responder[]>) {
	const calls: { body: string; route: string }[] = [];
	const seen = new Map<string, number>();
	const target: ApiTarget = {
		url: "http://127.0.0.1:7777",
		token: "node-token",
		fetch: (input, init) => {
			const route = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
			calls.push({ route, body: String(init?.body ?? "") });
			const entry = routes[route];
			const count = seen.get(route) ?? 0;
			seen.set(route, count + 1);
			const respond = Array.isArray(entry)
				? entry[Math.min(count, entry.length - 1)]
				: entry;
			return Promise.resolve(
				respond
					? respond()
					: Response.json({ error: "no route" }, { status: 404 })
			);
		},
	};
	return { calls, target };
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

export async function run(
	argv: string[],
	node: ReturnType<typeof fakeNode>,
	options: {
		env?: Record<string, string>;
		spawn?: ProcessRunner;
		stdin?: string | null;
	} = {}
) {
	let out = "";
	let err = "";
	const code = await runCli(argv, {
		api: stubApi(),
		env: options.env ?? AGENT_ENV,
		io: {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		},
		promptLine: () => Promise.resolve(null),
		readStdin: () => Promise.resolve(options.stdin ?? null),
		spawn: options.spawn ?? (() => Promise.resolve(0)),
		target: node.target,
	});
	return { code, err, out };
}

export const routesOf = (node: ReturnType<typeof fakeNode>) =>
	node.calls.map((call) => call.route);
