import { expect, test } from "bun:test";
import {
	CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
	createChatPageNativeHttpFixture,
} from "./chat-page-native-http.host.ts";

const origin = "http://127.0.0.1:5590";
const conversation = "conversation-toolbar-share-fixture";
const modelPath = `/api/conversations/${conversation}/model-selection`;
const choice = {
	changeId: "native-choice-1",
	kind: "change",
	modelId: "model-proof-b",
	modelLabel: "Proof model B",
	providerId: "codex",
	providerLabel: "Codex",
};
async function withServer(
	run: (
		url: string,
		fixture: ReturnType<typeof createChatPageNativeHttpFixture>
	) => Promise<void>
) {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
		port: 0,
		fetch: (request) => fixture.fetch(request, "a"),
	});
	try {
		await run(`http://127.0.0.1:${server.port}`, fixture);
	} finally {
		fixture.close();
		server.stop(true);
	}
}
const headers = {
	origin,
	authorization: "Bearer chat-page-native-node-a-token",
	"content-type": "application/json",
};
const control = (url: string, body: unknown) =>
	fetch(`${url}/__proof/control`, {
		method: "POST",
		headers: {
			"x-chat-page-proof-control": "owned-local-fixture",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

test("actual HTTP enforces origin, node bearer, method and finite endpoints, retaining every refusal", async () =>
	withServer(async (url, fixture) => {
		for (const [path, init] of [
			[
				"/api/conversations",
				{ headers: { ...headers, origin: "https://wrong.example" } },
			],
			[
				"/api/conversations",
				{ headers: { ...headers, authorization: "Bearer account-token" } },
			],
			["/api/conversations", { method: "DELETE", headers }],
			["/api/unknown-success-placeholder", { headers }],
		] as const) {
			expect((await fetch(url + path, init)).ok).toBe(false);
		}
		expect(fixture.snapshot().unexpected).toHaveLength(4);
		expect(
			fixture.snapshot().calls.every((call) => call.status === "refused")
		).toBe(true);
		expect((await fetch(`${url}/api/conversations`, { headers })).status).toBe(
			200
		);
		expect(fixture.snapshot().calls.at(-1)).toMatchObject({
			node: "a",
			origin,
			method: "GET",
			authorization: headers.authorization,
			rawBody: null,
			status: "accepted",
		});
	}));

test("real delayed PUT does not persist before response; refused save retains old state and identical retry persists through GET", async () =>
	withServer(async (url, fixture) => {
		expect(
			(
				await control(url, {
					action: "hold_next",
					node: "a",
					method: "PUT",
					path: modelPath,
				})
			).ok
		).toBe(true);
		const pending = fetch(url + modelPath, {
			method: "PUT",
			headers,
			body: JSON.stringify(choice),
		});
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 1000;
			const poll = () =>
				fixture.snapshot().heldRequestIds.length
					? resolve()
					: Date.now() >= deadline
						? reject(new Error("Real HTTP write never reached hold"))
						: setTimeout(poll, 5);
			poll();
		});
		expect(
			(await (await fetch(url + modelPath, { headers })).json()).current
		).toBeNull();
		const id = fixture.snapshot().heldRequestIds[0];
		expect(
			fixture.snapshot().calls.find((call) => call.id === id)
		).toMatchObject({
			body: choice,
			rawBody: JSON.stringify(choice),
			method: "PUT",
			status: "pending",
		});
		expect(
			(await control(url, { action: "release", requestId: id, accept: false }))
				.ok
		).toBe(true);
		expect((await pending).status).toBe(503);
		expect(
			(await (await fetch(url + modelPath, { headers })).json()).current
		).toBeNull();
		const retry = await fetch(url + modelPath, {
			method: "PUT",
			headers,
			body: JSON.stringify(choice),
		});
		expect(retry.status).toBe(200);
		const readback = await (await fetch(url + modelPath, { headers })).json();
		expect(readback.changes).toHaveLength(1);
		expect(readback.current).toMatchObject({
			id: choice.changeId,
			modelId: choice.modelId,
			sequence: 1,
		});
		const writes = fixture
			.snapshot()
			.calls.filter((call) => call.method === "PUT");
		expect(writes.map((call) => call.status)).toEqual(["refused", "accepted"]);
		expect(writes[0].body).toEqual(writes[1].body);
		expect(fixture.snapshot().unexpected).toEqual([]);
	}));

test("actual native git409 DTO is retained and successful retry records complete reverse-edit plan", async () =>
	withServer(async (url, fixture) => {
		const plan = {
			kind: "text-replacements",
			edits: [
				{
					kind: "replace",
					path: "src/example.ts",
					before: "before",
					after: "after",
				},
			],
		};
		const body = { cwd: "/tmp/ryu-chat-controls-project", plan };
		const conflict = {
			kind: "conflict",
			reason: "changed_since_turn",
			paths: ["src/example.ts"],
		};
		expect(
			(
				await control(url, {
					action: "refuse_next",
					node: "a",
					method: "POST",
					path: "/api/git/reverse-edits",
					status: 409,
					body: conflict,
				})
			).ok
		).toBe(true);
		const first = await fetch(`${url}/api/git/reverse-edits`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(first.status).toBe(409);
		expect(await first.json()).toEqual(conflict);
		expect(fixture.snapshot().reversedEdits).toEqual([]);
		const retry = await fetch(`${url}/api/git/reverse-edits`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(await retry.json()).toEqual({
			kind: "applied",
			paths: ["src/example.ts"],
		});
		expect(fixture.snapshot().reversedEdits).toEqual([body]);
		expect(fixture.snapshot().unexpected).toEqual([]);
	}));

test("distinct actual HTTP nodes keep saved model histories isolated and enforce rotated user JWT", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const servers = (["a", "b"] as const).map((node) =>
		Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => fixture.fetch(request, node),
		})
	);
	try {
		const urlA = `http://127.0.0.1:${servers[0].port}`;
		const urlB = `http://127.0.0.1:${servers[1].port}`;
		expect(
			(
				await fetch(urlA + modelPath, {
					method: "PUT",
					headers,
					body: JSON.stringify(choice),
				})
			).status
		).toBe(200);
		const bHeaders = {
			...headers,
			authorization: "Bearer chat-page-native-node-b-token",
		};
		expect(
			(await (await fetch(urlB + modelPath, { headers: bHeaders })).json())
				.current
		).toBeNull();
		expect((await fetch(urlB + modelPath, { headers })).status).toBe(403);
		expect(
			(
				await control(urlA, {
					action: "set_node_authority",
					node: "b",
					token: "chat-page-native-node-b-token",
					userJwt: "owned-user-jwt-b",
				})
			).status
		).toBe(200);
		expect((await fetch(urlB + modelPath, { headers: bHeaders })).status).toBe(
			403
		);
		const jwtHeaders = { ...bHeaders, "x-ryu-user-jwt": "owned-user-jwt-b" };
		const bChoice = {
			...choice,
			changeId: "native-node-b-choice",
			modelId: "model-proof-a",
		};
		expect(
			(
				await fetch(urlB + modelPath, {
					method: "PUT",
					headers: jwtHeaders,
					body: JSON.stringify(bChoice),
				})
			).status
		).toBe(200);
		expect(
			(await (await fetch(urlA + modelPath, { headers })).json()).current
				.modelId
		).toBe("model-proof-b");
		expect(
			(await (await fetch(urlB + modelPath, { headers: jwtHeaders })).json())
				.current.modelId
		).toBe("model-proof-a");
		expect(
			fixture
				.snapshot()
				.calls.filter((call) => call.method === "PUT")
				.map((call) => ({
					node: call.node,
					body: call.body,
					userJwt: call.userJwt,
				}))
		).toEqual([
			{ node: "a", body: choice, userJwt: null },
			{ node: "b", body: bChoice, userJwt: "owned-user-jwt-b" },
		]);
	} finally {
		fixture.close();
		for (const server of servers) {
			server.stop(true);
		}
	}
});

test("scenario HTTP readbacks expose actual bound agent catalog and known worktree project without defaulting unknown resources", async () =>
	withServer(async (url, fixture) => {
		expect(
			(
				await control(url, {
					action: "reset",
					scenario: "model-selection-caller",
				})
			).status
		).toBe(200);
		const summaries = await (
			await fetch(`${url}/api/conversations`, { headers })
		).json();
		expect(summaries.conversations[0].agent_id).toBe("agent-fixture");
		const agents = await (await fetch(`${url}/api/agents`, { headers })).json();
		expect(agents.agents[0]).toMatchObject({
			id: "agent-fixture",
			engine: "codex",
			transport: null,
		});
		expect(
			await (
				await fetch(`${url}/api/agents/agent-fixture/acp-config`, { headers })
			).json()
		).toEqual({ configOptions: null, models: null, modes: null });
		expect(
			(await control(url, { action: "reset", scenario: "worktree-handoff" }))
				.status
		).toBe(200);
		expect(
			(await (await fetch(`${url}/api/conversations`, { headers })).json())
				.conversations[0].folder_path
		).toBe("/tmp/ryu-chat-controls-project");
		expect(
			await (
				await fetch(
					`${url}/api/git/status?cwd=%2Ftmp%2Fryu-chat-controls-project`,
					{ headers }
				)
			).json()
		).toEqual({
			is_repo: true,
			branch: "main",
			ahead: 0,
			behind: 0,
			dirty: false,
			changed_files_count: 0,
		});
		expect(
			await (
				await fetch(`${url}/api/worktree/${conversation}/status`, { headers })
			).json()
		).toEqual({
			active: false,
			branch: null,
			path: null,
			has_changes: false,
			changed_files: 0,
		});
		expect(
			await (
				await fetch(`${url}/api/background/processes?running_only=true`, {
					headers,
				})
			).json()
		).toEqual({ processes: [] });
		expect(
			(await fetch(`${url}/api/git/status?cwd=%2Fforeign`, { headers })).status
		).toBe(400);
		expect(fixture.snapshot().unexpected).toHaveLength(1);
	}));

test("actual backend HTTP session, organization and wallet readbacks share one authority and retain trial anchor", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => fixture.fetch(request, "backend"),
	});
	const url = `http://127.0.0.1:${server.port}`;
	const backendHeaders = {
		...headers,
		authorization: "Bearer share-toolbar-fixture-token",
	};
	try {
		const session = await (
			await fetch(`${url}/api/auth/get-session`, { headers: backendHeaders })
		).json();
		const orgs = await (
			await fetch(`${url}/api/control-plane/orgs`, { headers: backendHeaders })
		).json();
		const wallet = await (
			await fetch(`${url}/api/credits/wallet`, { headers: backendHeaders })
		).json();
		expect(session.user.id).toBe("share-owner");
		expect(session.session.activeOrganizationId).toBe(orgs.organizations[0].id);
		expect(wallet.wallet.ownerId).toBe(session.session.activeOrganizationId);
		expect(wallet.wallet.ownerType).toBe("org");
		expect(wallet.ledger).toEqual([]);
		const anchor = await (
			await fetch(`${url}/api/billing/trial`, { headers: backendHeaders })
		).json();
		expect(
			await (
				await fetch(`${url}/api/billing/trial`, {
					method: "POST",
					headers: backendHeaders,
				})
			).json()
		).toEqual(anchor);
		expect((await fetch(`${url}/api/credits/wallet`, { headers })).status).toBe(
			403
		);
		expect(
			(
				await fetch(`${url}/api/credits/wallet?organizationId=foreign`, {
					headers: backendHeaders,
				})
			).status
		).toBe(503);
		expect(fixture.snapshot().unexpected).toHaveLength(2);
	} finally {
		fixture.close();
		server.stop(true);
	}
});

test("real SSE yields actual wallet snapshot then idle and closes owned handlers on client cancellation or fixture teardown", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => fixture.fetch(request, "backend"),
	});
	const url = `http://127.0.0.1:${server.port}`;
	const backendHeaders = {
		...headers,
		authorization: "Bearer share-toolbar-fixture-token",
	};
	try {
		const abort = new AbortController();
		const response = await fetch(`${url}/api/credits/wallet/stream`, {
			headers: backendHeaders,
			signal: abort.signal,
		});
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body!.getReader();
		const text = new TextDecoder().decode((await reader.read()).value);
		expect(text.startsWith("event: wallet\ndata: ")).toBe(true);
		expect(JSON.parse(text.split("data: ")[1].trim())).toMatchObject({
			id: "share-fixture-wallet",
			ownerId: "org-share-toolbar-fixture",
			balanceMicroUsd: 0,
			currency: "usd",
		});
		expect(fixture.snapshot().idleStreamCount).toBe(1);
		abort.abort();
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 1000;
			const poll = () =>
				fixture.snapshot().idleStreamCount === 0
					? resolve()
					: Date.now() > deadline
						? reject(
								new Error("Client cancellation left owned SSE handler open")
							)
						: setTimeout(poll, 5);
			poll();
		});
		expect(fixture.snapshot().idleStreamCount).toBe(0);
		const alerts = await fetch(`${url}/api/credits/alert/stream`, {
			headers: backendHeaders,
		});
		const alertReader = alerts.body!.getReader();
		expect(new TextDecoder().decode((await alertReader.read()).value)).toBe(
			": owned idle stream\n\n"
		);
		expect(fixture.snapshot().idleStreamCount).toBe(1);
		fixture.close();
		expect((await alertReader.read()).done).toBe(true);
		expect(fixture.snapshot().idleStreamCount).toBe(0);
		expect(fixture.snapshot().unexpected).toEqual([]);
	} finally {
		fixture.close();
		server.stop(true);
	}
});

test("actual finite Core idle contracts preserve explicit404s, scoped queries and persistent entitlement writes", async () =>
	withServer(async (url, fixture) => {
		expect(
			await (
				await fetch(`${url}/api/conversations/${conversation}/goal`, {
					headers,
				})
			).json()
		).toEqual({ turns: 0 });
		expect(
			(
				await fetch(`${url}/api/chat/stream/resume/${conversation}`, {
					headers,
				})
			).status
		).toBe(404);
		expect(
			(await fetch(`${url}/api/worktree/${conversation}/diff`, { headers }))
				.status
		).toBe(404);
		expect(
			(
				await fetch(
					`${url}/api/agents/agent-fixture/capabilities?model=foreign-model`,
					{ headers }
				)
			).status
		).toBe(503);
		expect(
			(
				await fetch(`${url}/api/skills/catalog?limit=120&source=foreign`, {
					headers,
				})
			).status
		).toBe(503);
		const pref = "/api/preferences/entitlement-active";
		expect(
			(await (await fetch(url + pref, { headers })).json()).value
		).toBeNull();
		expect(
			(
				await fetch(url + pref, {
					method: "PUT",
					headers,
					body: JSON.stringify({ value: "true" }),
				})
			).status
		).toBe(200);
		expect((await (await fetch(url + pref, { headers })).json()).value).toBe(
			"true"
		);
		expect(
			(
				await fetch(url + pref, {
					method: "PUT",
					headers,
					body: JSON.stringify({ value: "true", ignored: "foreign" }),
				})
			).status
		).toBe(400);
		expect(fixture.snapshot().unexpected).toHaveLength(3);
	}));

test("only the genuine public GET health bypasses node credentials; private data, query variants and origin retain refusal", async () =>
	withServer(async (url, fixture) => {
		const health = await fetch(`${url}/api/health`, { headers: { origin } });
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			status: "ok",
			gatewayVersion: null,
			requiredRuntimeReady: false,
			updateRuntimeNonce: null,
		});
		for (const [path, init] of [
			["/api/health", { headers: { origin: "https://foreign.test" } }],
			["/api/health?private=true", { headers: { origin } }],
			[modelPath, { headers: { origin } }],
			["/api/health", { method: "POST", headers }],
		] as const) {
			expect((await fetch(url + path, init)).ok).toBe(false);
		}
		expect(fixture.snapshot().unexpected).toHaveLength(4);
		expect((await fetch(url + modelPath, { headers })).status).toBe(200);
	}));

test("expert Layout observed dependencies keep exact finite DTOs and query bounds, and entitlement write reads back on its own key", async () =>
	withServer(async (url, fixture) => {
		for (const [path, body] of [
			["/api/quests", { quests: [] }],
			["/api/plugins/catalog", { entries: [] }],
			["/api/models/updates", { updates: [] }],
			["/api/skills/updates", { updates: [] }],
			["/api/mcp/updates", { updates: [] }],
			[
				"/api/notifications?user_id=share-owner&limit=50",
				{ notifications: [] },
			],
			[
				"/api/models/context-window?model=model-proof-a",
				{ contextLength: null },
			],
		] as const) {
			const result = await fetch(url + path, { headers });
			expect(result.status).toBe(200);
			expect(await result.json()).toEqual(body);
		}
		const pref = "/api/preferences/managed-inference-entitled";
		expect(await (await fetch(url + pref, { headers })).json()).toEqual({
			key: "managed-inference-entitled",
			value: null,
		});
		expect(
			(
				await fetch(url + pref, {
					method: "PUT",
					headers,
					body: JSON.stringify({ value: "false" }),
				})
			).status
		).toBe(200);
		expect(await (await fetch(url + pref, { headers })).json()).toEqual({
			key: "managed-inference-entitled",
			value: "false",
		});
		expect(
			await (
				await fetch(`${url}/api/preferences/entitlement-active`, { headers })
			).json()
		).toEqual({ key: "entitlement-active", value: null });
		expect(
			(
				await fetch(`${url}/api/chat/suggestions`, {
					method: "POST",
					headers,
					body: JSON.stringify({ conversation_id: conversation }),
				})
			).status
		).toBe(200);
		expect(fixture.snapshot().unexpected).toHaveLength(0);
		for (const path of [
			"/api/models/context-window?model=foreign",
			"/api/notifications?user_id=foreign&limit=50",
			"/api/plugins/catalog?unknown=true",
		]) {
			expect((await fetch(url + path, { headers })).status).toBe(503);
		}
		expect(
			(
				await fetch(`${url}/api/chat/suggestions`, {
					method: "POST",
					headers,
					body: JSON.stringify({ conversation_id: "foreign" }),
				})
			).status
		).toBe(400);
		expect(fixture.snapshot().unexpected).toHaveLength(4);
	}));

test("owned backend owner permissions, announcements and idle login-approval SSE are authenticated and never fabricate events", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => fixture.fetch(request, "backend"),
	});
	const url = `http://127.0.0.1:${server.port}`;
	const accountHeaders = {
		origin,
		authorization: "Bearer share-toolbar-fixture-token",
	};
	try {
		const result = await fetch(
			`${url}/api/control-plane/me/permissions?orgId=org-share-toolbar-fixture`,
			{ headers: accountHeaders }
		);
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("private, no-store");
		const { permissions } = await result.json();
		expect(permissions).toHaveLength(38);
		expect(new Set(permissions).size).toBe(38);
		expect(permissions).toContain("billing.manage");
		expect(permissions).toContain("marketplace.transfer");
		expect(
			await (
				await fetch(`${url}/api/announcements`, { headers: accountHeaders })
			).json()
		).toEqual({ announcements: [] });
		expect(
			await (
				await fetch(`${url}/api/upsell/state`, { headers: accountHeaders })
			).json()
		).toEqual({ lastUpsellShownAt: 0 });
		expect(
			await (
				await fetch(`${url}/api/upsell/pitch`, { headers: accountHeaders })
			).json()
		).toEqual({ cards: [] });
		const abort = new AbortController();
		const stream = await fetch(`${url}/api/login-approvals/stream`, {
			headers: accountHeaders,
			signal: abort.signal,
		});
		expect(stream.headers.get("content-type")).toBe("text/event-stream");
		const reader = stream.body!.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
		expect(fixture.snapshot().idleStreamCount).toBe(1);
		abort.abort();
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 1000;
			const poll = () =>
				fixture.snapshot().idleStreamCount === 0
					? resolve()
					: Date.now() > deadline
						? reject(new Error("Login approval abort left owned handler open"))
						: setTimeout(poll, 5);
			poll();
		});
		expect(fixture.snapshot().idleStreamCount).toBe(0);
		expect(fixture.snapshot().unexpected).toHaveLength(0);
		expect(
			(
				await fetch(`${url}/api/control-plane/me/permissions?orgId=foreign`, {
					headers: accountHeaders,
				})
			).status
		).toBe(503);
		expect(
			(
				await fetch(`${url}/api/login-approvals/stream`, {
					headers: { origin },
				})
			).status
		).toBe(403);
		expect(fixture.snapshot().unexpected).toHaveLength(2);
	} finally {
		fixture.close();
		server.stop(true);
	}
});

test("owned legacy project migration persists complete project DTO; foreign input is refused and missing callback is an honest503", async () =>
	withServer(async (url, fixture) => {
		const input = {
			name: "Project Atlas",
			description: "",
			instructions: "",
			icon: null,
			coordinatorAgent: "ryu",
			cwd: "/tmp/ryu-chat-controls-project",
			defaults: { effort: "", model: "", provider: "" },
			executionMode: "auto",
		};
		const path = "/api/projects/projects";
		expect(await (await fetch(url + path, { headers })).json()).toEqual({
			projects: [],
		});
		const created = await fetch(url + path, {
			method: "POST",
			headers,
			body: JSON.stringify(input),
		});
		expect(created.status).toBe(200);
		const project = await created.json();
		expect(project).toMatchObject({
			...input,
			id: "chat-page-owned-project",
			coordinatorConversationId: null,
		});
		expect(await (await fetch(url + path, { headers })).json()).toEqual({
			projects: [project],
		});
		const main = await fetch(
			`${url + path}/chat-page-owned-project/main-thread`,
			{ method: "POST", headers }
		);
		expect(main.status).toBe(503);
		expect(await main.json()).toEqual({
			error: "Core is unavailable; open this project from a connected Ryu node",
		});
		const migrated = await fetch(`${url}/api/hierarchy/memory/rekey-project`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				from_scope_id: input.cwd,
				to_project_id: project.id,
			}),
		});
		expect(migrated.status).toBe(200);
		expect(await migrated.json()).toEqual({ moved: 0 });
		expect(fixture.snapshot().unexpected).toHaveLength(0);
		expect(
			(
				await fetch(url + path, {
					method: "POST",
					headers,
					body: JSON.stringify({ ...input, cwd: "/foreign" }),
				})
			).status
		).toBe(400);
		expect(
			(
				await fetch(`${url + path}/foreign/main-thread`, {
					method: "POST",
					headers,
				})
			).status
		).toBe(503);
		expect(await (await fetch(url + path, { headers })).json()).toEqual({
			projects: [project],
		});
		expect(fixture.snapshot().unexpected).toHaveLength(2);
	}));

test(
	"actual startup transport keeps held acknowledgments and idle SSE alive past Bun's ten-second default, until owned release or abort",
	async () =>
		withServer(async (url, fixture) => {
			await control(url, {
				action: "hold_next",
				node: "a",
				method: "PUT",
				path: modelPath,
			});
			const pending = fetch(url + modelPath, {
				method: "PUT",
				headers,
				body: JSON.stringify(choice),
			});
			const abort = new AbortController();
			const stream = await fetch(`${url}/api/events/all`, {
				headers,
				signal: abort.signal,
			});
			const reader = stream.body!.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(
				": owned idle stream\n\n"
			);
			await new Promise((resolve) => setTimeout(resolve, 10_500));
			expect(fixture.snapshot().idleStreamCount).toBe(1);
			expect(fixture.snapshot().heldRequestIds).toHaveLength(1);
			expect(
				await (await fetch(url + modelPath, { headers })).json()
			).toMatchObject({ current: null });
			const nextRead = reader.read();
			const id = fixture.snapshot().heldRequestIds[0];
			await control(url, { action: "release", requestId: id, accept: true });
			expect((await pending).status).toBe(200);
			expect(
				await (await fetch(url + modelPath, { headers })).json()
			).toMatchObject({ current: { modelId: "model-proof-b" } });
			abort.abort();
			try {
				await nextRead;
			} catch (error) {
				expect((error as Error).name).toBe("AbortError");
			}
			await new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 1000;
				const poll = () =>
					fixture.snapshot().idleStreamCount === 0
						? resolve()
						: Date.now() > deadline
							? reject(new Error("Startup SSE abort left owned handler open"))
							: setTimeout(poll, 5);
				poll();
			});
			expect(fixture.snapshot().unexpected).toHaveLength(0);
		}),
	20_000
);

test("owned suggestion and gateway controls answer per conversation, and a held suggestions request records whether the browser abandoned it", async () =>
	withServer(async (url, fixture) => {
		const earlier = "conversation-earlier-thread-fixture";
		const until = (predicate: () => boolean, reason: string) =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 1000;
				const poll = () =>
					predicate()
						? resolve()
						: Date.now() > deadline
							? reject(new Error(reason))
							: setTimeout(poll, 5);
				poll();
			});
		const suggest = (conversationId: string, signal?: AbortSignal) =>
			fetch(`${url}/api/chat/suggestions`, {
				method: "POST",
				headers,
				body: JSON.stringify({ conversation_id: conversationId }),
				signal,
			});
		const gateway = async () =>
			(
				(await (
					await fetch(`${url}/api/system/status`, { headers })
				).json()) as { gateway: unknown }
			).gateway;
		expect(
			(await control(url, { action: "reset", scenario: "queue-isolation" }))
				.status
		).toBe(200);
		expect(await (await suggest(conversation)).json()).toEqual({
			suggestions: [],
		});
		for (const refused of [
			{ conversationId: "conversation-unknown", suggestions: ["Next"] },
			{ conversationId: conversation, suggestions: ["Next", 7] },
		]) {
			expect(
				(
					await control(url, {
						action: "set_suggestions",
						node: "a",
						...refused,
					})
				).status
			).toBe(409);
		}
		expect(
			(
				await control(url, {
					action: "set_suggestions",
					node: "a",
					conversationId: conversation,
					suggestions: ["Draft the email.", "List the risks."],
				})
			).status
		).toBe(200);
		expect(await (await suggest(conversation)).json()).toEqual({
			suggestions: ["Draft the email.", "List the risks."],
		});
		expect(await (await suggest(earlier)).json()).toEqual({ suggestions: [] });

		// A held request the browser abandons is recorded as abandoned.
		await control(url, {
			action: "hold_next",
			node: "a",
			method: "POST",
			path: "/api/chat/suggestions",
		});
		const abandon = new AbortController();
		const abandoned = suggest(conversation, abandon.signal).catch(
			(error: Error) => error.name
		);
		await until(
			() => fixture.snapshot().heldRequestIds.length === 1,
			"Suggestions request never reached the hold"
		);
		const abandonedId = fixture.snapshot().heldRequestIds[0];
		abandon.abort();
		expect(await abandoned).toBe("AbortError");
		await until(
			() =>
				fixture.snapshot().calls.find((call) => call.id === abandonedId)
					?.clientAborted === true,
			"The abandoned suggestions request was not recorded"
		);
		await control(url, {
			action: "release",
			requestId: abandonedId,
			accept: true,
		});

		// A held request that is released answers normally and is not abandoned.
		await control(url, {
			action: "hold_next",
			node: "a",
			method: "POST",
			path: "/api/chat/suggestions",
		});
		const kept = suggest(conversation);
		await until(
			() => fixture.snapshot().heldRequestIds.length === 1,
			"Second suggestions request never reached the hold"
		);
		const keptId = fixture.snapshot().heldRequestIds[0];
		await control(url, { action: "release", requestId: keptId, accept: true });
		expect(await (await kept).json()).toEqual({
			suggestions: ["Draft the email.", "List the risks."],
		});
		expect(
			fixture.snapshot().calls.find((call) => call.id === keptId)
		).toMatchObject({
			clientAborted: false,
			status: "accepted",
			responseStatus: 200,
			body: { conversation_id: conversation },
		});

		expect(await gateway()).toEqual({ reachable: false });
		expect(
			(
				await control(url, {
					action: "set_gateway_reachable",
					reachable: "yes",
				})
			).status
		).toBe(409);
		expect(
			(await control(url, { action: "set_gateway_reachable", reachable: true }))
				.status
		).toBe(200);
		expect(await gateway()).toEqual({ reachable: true });
		// A fixture-agent thread with no model chosen yet reads its capabilities
		// and routing advice without a model.
		for (const atStart of ["true", "false"]) {
			const advice = await fetch(
				`${url}/api/routing/advice?agent_id=agent-fixture&model=&at_conversation_start=${atStart}`,
				{ headers }
			);
			expect(advice.status).toBe(200);
			expect(await advice.json()).toEqual({
				original: { agent_id: "agent-fixture", model: "" },
				effective: { agent_id: "agent-fixture", model: "" },
				severity: "continue",
			});
		}
		const capabilities = await fetch(
			`${url}/api/agents/agent-fixture/capabilities`,
			{ headers }
		);
		expect(capabilities.status).toBe(200);
		expect(await capabilities.json()).toMatchObject({ source: "default" });
		await control(url, { action: "reset", scenario: "queue-isolation" });
		expect(await gateway()).toEqual({ reachable: false });
		expect(await (await suggest(conversation)).json()).toEqual({
			suggestions: [],
		});
		expect(fixture.snapshot().unexpected).toEqual([]);
	}));

test("the review pane's file-diff read answers the owned workspace's one edited file and refuses any other DTO", async () =>
	withServer(async (url) => {
		const diff = (body: unknown) =>
			fetch(`${url}/api/git/file-diff`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
		const owned = "/tmp/ryu-chat-controls-project";
		const answered = await diff({ cwd: owned, paths: ["src/status.txt"] });
		expect(answered.status).toBe(200);
		const result = (await answered.json()) as {
			patch: string;
			paths: string[];
		};
		expect(result.paths).toEqual(["src/status.txt"]);
		expect(result.patch).toContain("-pending\n+ready\n");
		for (const body of [
			{ cwd: "/tmp/foreign", paths: ["src/status.txt"] },
			{ cwd: owned, paths: ["src/other.txt"] },
			{ cwd: owned, paths: ["src/status.txt", "src/other.txt"] },
			{ cwd: owned, paths: "src/status.txt" },
		]) {
			expect((await diff(body)).status).toBe(400);
		}
		const wrongMethod = await fetch(`${url}/api/git/file-diff`, { headers });
		expect(wrongMethod.status).not.toBe(200);
	}));

test("the saved side chat list answers each listed thread only in the side-chat-sidebar scenario and refuses an unknown one", async () =>
	withServer(async (url) => {
		const earlier = "conversation-earlier-thread-fixture";
		const list = (conversationId: string) =>
			fetch(`${url}/api/conversations/${conversationId}/btw`, { headers });
		const features = async () =>
			(
				(await (
					await fetch(`${url}/api/plugins/contributions`, { headers })
				).json()) as { chat_features: unknown[] }
			).chat_features;
		// No scenario but this one enables the plugin or serves its list.
		expect((await list(conversation)).status).not.toBe(200);
		expect(await features()).toEqual([]);

		expect(
			(await control(url, { action: "reset", scenario: "side-chat-sidebar" }))
				.status
		).toBe(200);
		for (const conversationId of [conversation, earlier]) {
			const answered = await list(conversationId);
			expect(answered.status).toBe(200);
			expect(await answered.json()).toEqual([
				expect.objectContaining({ conversation_id: conversationId }),
			]);
		}
		expect((await list("conversation-unknown")).status).not.toBe(200);
		expect(await features()).toEqual([
			expect.objectContaining({ kind: "side-chat", plugin: "@ryu/side-chats" }),
		]);
	}));
