// The fake vault node behind the Machines tab tests: a loopback server that
// keeps identities, secret ids and tokens as Core does. Tests share `node`
// and reset it with `resetNode` before each case.

import { registerDomWithNativeNetworking } from "../settings/unswept-a.test-support.ts";

export const NativeResponse = globalThis.Response;
export const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "machines-node";
export const SECRET_ID = "sid-value-shown-once";
export const MINTED = "rvt_minted-shown-once";
export type Machine = Record<string, unknown> & { id: string; name: string };

/** What the fake node holds; each test resets it (see `resetNode`). */
export const node: {
	machines: Machine[];
	tokens: Record<string, unknown>[];
	writes: { body: unknown; route: string }[];
	/** When set, issuing a secret id waits for it, as a slow node would. */
	hold: Promise<void> | null;
	/** When set, a disable is applied but answered as Core answers a stuck lease. */
	stuckLease: string | null;
	/** When set, every write is refused as a node error would be. */
	failWrites: boolean;
} = {
	machines: [],
	tokens: [],
	writes: [],
	hold: null,
	stuckLease: null,
	failWrites: false,
};

export const machine = (name: string, kind: string, extra = {}): Machine => ({
	id: `mid_${name}`,
	name,
	auth: kind === "approle" ? { kind, role_id: `role-${name}` } : { kind },
	policies: ["ci-read"],
	tokenTtlSecs: 3600,
	disabled: false,
	createdAt: 1,
	createdBy: null,
	...extra,
});

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

function answer(route: string, body: unknown): Response {
	if (route === "POST /api/vault/machines") {
		const created = machine((body as { name: string }).name, "approle");
		node.machines = [...node.machines, created];
		return json({ machine: created });
	}
	if (route.startsWith("PATCH /api/vault/machines/")) {
		const id = decodeURIComponent(route.split("/").pop() ?? "");
		node.machines = node.machines.map((item) =>
			item.id === id ? { ...item, ...(body as object) } : item
		);
		if (node.stuckLease) {
			return json(
				{
					error: `vault_conflict: machine identity is disabled, but 1 lease(s) its tokens hold could not be revoked at the provider: ${node.stuckLease}.`,
					code: "vault_conflict",
				},
				409
			);
		}
		return json({ machine: node.machines.find((item) => item.id === id) });
	}
	if (route.startsWith("DELETE /api/vault/machines/")) {
		const id = decodeURIComponent(route.split("/").pop() ?? "");
		node.machines = node.machines.filter((item) => item.id !== id);
		return json({ deleted: true });
	}
	if (route.endsWith("/secret-ids") && route.startsWith("POST")) {
		const info = {
			accessor: "sid-acc",
			createdAt: 1,
			expiresAt: null,
			usesRemaining: 1,
		};
		return json({ secretId: SECRET_ID, info });
	}
	if (route === "POST /api/vault/tokens") {
		node.tokens = [
			{
				accessor: "tok-acc",
				identityId: (body as { identity: string }).identity,
				policies: ["ci-read"],
				role: "deploy",
				createdAt: 1,
				expiresAt: 1_900_000_000_000,
				numUsesRemaining: null,
				revokedAt: null,
			},
		];
		return json({
			token: {
				token: MINTED,
				accessor: "tok-acc",
				identityId: "mid_ci",
				policies: ["ci-read"],
				expiresAt: 1_900_000_000_000,
			},
		});
	}
	if (route === "POST /api/vault/tokens/tok-acc/revoke") {
		node.tokens = [];
		return json({ revoked: true });
	}
	return json({ error: `undeclared ${route}` }, 404);
}

export const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return json({ error: "Unauthorized" }, 401);
		}
		if (route === "GET /api/vault/machines") {
			return json({ machines: node.machines });
		}
		if (route === "GET /api/vault/token-roles") {
			return json({
				roles: [
					{
						name: "deploy",
						allowedPolicies: [],
						disallowedPolicies: [],
						orphan: false,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			});
		}
		if (route === "GET /api/vault/tokens") {
			return json({ tokens: node.tokens });
		}
		if (request.method === "GET" && url.pathname.endsWith("/secret-ids")) {
			return json({ secretIds: [] });
		}
		const body = await request.json().catch(() => null);
		node.writes.push({ body, route });
		if (node.hold && route.endsWith("/secret-ids")) {
			await node.hold;
		}
		if (node.failWrites) {
			return json(
				{
					error: `vault_invalid_request: the node said no to ${request.method}`,
				},
				500
			);
		}
		return answer(route, body);
	},
});
export const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

/** Start each test from two identities and no writes. */
export function resetNode(): void {
	node.machines = [machine("ci", "approle"), machine("github", "jwt")];
	node.tokens = [];
	node.writes = [];
	node.hold = null;
	node.stuckLease = null;
	node.failWrites = false;
}
