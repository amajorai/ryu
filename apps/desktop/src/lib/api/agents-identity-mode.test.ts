import { describe, expect, test } from "bun:test";
import {
	type AgentIdentityMode,
	type AgentInput,
	agentIdentityMode,
	fetchAgent,
	installPublishedAgent,
	toAgentBody,
	updateAgent,
	updateAgentAccountSettings,
} from "./agents.ts";

const input: AgentInput = {
	name: "Identity proof",
	description: null,
	systemPrompt: "Saved instructions",
	engine: "acp:pi",
	tools: ["web.search"],
};

/** A loopback Core stand-in that merges PUT bodies into one stored record. */
function serveAgent(initial: Record<string, unknown>) {
	let record: Record<string, unknown> = {
		id: "identity-proof",
		name: "Before",
		engine: "acp:pi",
		tools: ["web.search"],
		version: "1.0.0",
		...initial,
	};
	const writes: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (new URL(request.url).pathname !== "/api/agents/identity-proof") {
				return new Response("Unexpected path", { status: 404 });
			}
			if (request.method === "PUT") {
				const body = (await request.json()) as Record<string, unknown>;
				writes.push(body);
				record = { ...record, ...body };
				return Response.json({ agent: record });
			}
			return Response.json({ agent: record });
		},
	});
	return {
		server,
		target: { url: server.url.origin, token: "identity-token" },
		writes,
	};
}

describe("agent identity mode wire format", () => {
	test("missing modes read as managed; unknown modes fail closed", () => {
		expect(agentIdentityMode(undefined)).toBe("managed");
		expect(agentIdentityMode(null)).toBe("managed");
		// A mode this client does not know must never be saved back as managed.
		expect(agentIdentityMode("delegated")).toBe("individual");
		const modes: AgentIdentityMode[] = ["managed", "individual", "mixed"];
		for (const mode of modes) {
			expect(agentIdentityMode(mode)).toBe(mode);
		}
	});

	test("omitted fields stay off the request body", () => {
		const body = toAgentBody(input);
		expect(body).not.toHaveProperty("identity_mode");
		expect(body).not.toHaveProperty("account_access");
	});

	test("null access is sent so it can clear an allowlist; [] stays distinct", () => {
		expect(toAgentBody({ ...input, accountAccess: null })).toHaveProperty(
			"account_access",
			null
		);
		expect(toAgentBody({ ...input, accountAccess: [] })).toHaveProperty(
			"account_access",
			[]
		);
		expect(
			toAgentBody({
				...input,
				identityMode: "mixed",
				accountAccess: ["composio:ca_1", "platform:treg"],
			})
		).toMatchObject({
			identity_mode: "mixed",
			account_access: ["composio:ca_1", "platform:treg"],
		});
	});

	test("a legacy record without the fields is managed and unrestricted", async () => {
		const { server, target } = serveAgent({});
		try {
			const agent = await fetchAgent(target, "identity-proof");
			expect(agent.identityMode).toBe("managed");
			expect(agent.accountAccess).toBeNull();
		} finally {
			await server.stop(true);
		}
	});

	test("mode and allowlist round-trip through a save", async () => {
		const { server, target, writes } = serveAgent({});
		try {
			const saved = await updateAgent(target, "identity-proof", {
				...input,
				identityMode: "individual",
				accountAccess: ["agent:vault_1"],
			});
			expect(writes[0]).toMatchObject({
				identity_mode: "individual",
				account_access: ["agent:vault_1"],
			});
			expect(saved.identityMode).toBe("individual");
			expect(saved.accountAccess).toEqual(["agent:vault_1"]);
		} finally {
			await server.stop(true);
		}
	});

	test("an empty allowlist reads back as [] and null clears it", async () => {
		const { server, target, writes } = serveAgent({
			identity_mode: "mixed",
			account_access: ["composio:ca_1"],
		});
		try {
			const none = await updateAgentAccountSettings(target, "identity-proof", {
				accountAccess: [],
			});
			expect(writes[0]).toEqual({ account_access: [] });
			expect(none.accountAccess).toEqual([]);
			expect(none.identityMode).toBe("mixed");

			const cleared = await updateAgentAccountSettings(
				target,
				"identity-proof",
				{ accountAccess: null, identityMode: "managed" }
			);
			expect(writes[1]).toEqual({
				account_access: null,
				identity_mode: "managed",
			});
			expect(cleared.accountAccess).toBeNull();
			expect(cleared.identityMode).toBe("managed");
		} finally {
			await server.stop(true);
		}
	});
});

describe("published agent install disclosure", () => {
	/** A loopback Core that answers one published install with `requires`. */
	async function install(requires: Record<string, unknown>) {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				if (new URL(request.url).pathname !== "/api/agents/published/install") {
					return new Response("Unexpected path", { status: 404 });
				}
				return Response.json({
					agent: {
						id: "installed-proof",
						identity_mode: "mixed",
						name: "Installed",
						version: "1.0.0",
					},
					requires,
				});
			},
		});
		try {
			return await installPublishedAgent(
				{ url: server.url.origin, token: "install-token" },
				"listing-proof",
				"idempotency-proof"
			);
		} finally {
			await server.stop(true);
		}
	}

	test("carries the identity mode the agent was installed with", async () => {
		const result = await install({ identity_mode: "mixed", tools: [] });
		expect(result.requires.identityMode).toBe("mixed");
		expect(result.agent.identityMode).toBe("mixed");
	});

	test("an older disclosure without a mode reads as unknown, not managed", async () => {
		expect((await install({})).requires.identityMode).toBeNull();
	});

	test("an unknown mode fails closed to the most restrictive label", async () => {
		expect(
			(await install({ identity_mode: "delegated" })).requires.identityMode
		).toBe("individual");
	});
});

describe("an app agent's pending identity mode", () => {
	test("fetchAgent reads the app identity, and an unknown request fails closed", async () => {
		const { server, target } = serveAgent({ identity_mode: "managed" });
		try {
			// The stand-in answers the bare record, as for an agent with no app.
			expect((await fetchAgent(target, "identity-proof")).appIdentity).toBe(
				null
			);
		} finally {
			await server.stop(true);
		}
		const appServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				Response.json({
					agent: { id: "identity-proof", name: "App agent" },
					app_identity: { app_mode: "managed", pending_mode: "delegated" },
				}),
		});
		try {
			const agent = await fetchAgent(
				{ url: appServer.url.origin, token: "identity-token" },
				"identity-proof"
			);
			expect(agent.appIdentity).toEqual({
				appMode: "managed",
				pendingMode: "individual",
			});
		} finally {
			await appServer.stop(true);
		}
	});

	test("dismissing sends only the dismiss flag, and a full save can carry it", async () => {
		const { server, target, writes } = serveAgent({ identity_mode: "managed" });
		try {
			await updateAgentAccountSettings(target, "identity-proof", {
				dismissPendingIdentityMode: true,
			});
			expect(writes).toEqual([{ dismiss_pending_identity_mode: true }]);
			expect(
				toAgentBody({ ...input, dismissPendingIdentityMode: true })
			).toHaveProperty("dismiss_pending_identity_mode", true);
			expect(toAgentBody(input)).not.toHaveProperty(
				"dismiss_pending_identity_mode"
			);
		} finally {
			await server.stop(true);
		}
	});
});
