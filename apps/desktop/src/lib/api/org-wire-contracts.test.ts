import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import {
	organizationActivityResponseSchema,
	organizationControlsResponseSchema,
	transferableViewSchema,
} from "./org-wire-contracts.ts";
import {
	fetchOrganizationAgentActivity,
	fetchOrganizationAgentControls,
	fetchTransferable,
	getActiveOrgId,
	getActiveTeamId,
	listMyOrganizationTeams,
	listOrgs,
	type OrganizationAuditEntry,
	transferCredits,
} from "./orgs.ts";

const NativeResponse = Response;
const NativeHeaders = Headers;
const NativeURL = URL;
let reply = NativeResponse.json({});
const received: { headers: Headers; body: string; path: string }[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		received.push({
			headers: new NativeHeaders(request.headers),
			body: await request.text(),
			path:
				new NativeURL(request.url).pathname + new NativeURL(request.url).search,
		});
		return reply.clone();
	},
});
const nativeFetch = globalThis.fetch;
const registeredHere = globalThis.document === undefined;
if (registeredHere) {
	GlobalRegistrator.register({ url: "http://fixture.invalid" });
}
const originalToken = localStorage.getItem(TOKEN_KEY);
localStorage.setItem(TOKEN_KEY, "org-session");
globalThis.fetch = Object.assign(
	async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new NativeURL(String(input), "http://fixture.invalid");
		return nativeFetch(
			new NativeURL(url.pathname + url.search, server.url),
			init
		);
	},
	{ preconnect: nativeFetch.preconnect }
);
beforeEach(() => {
	received.length = 0;
	localStorage.setItem(TOKEN_KEY, "org-session");
});
afterAll(async () => {
	globalThis.fetch = nativeFetch;
	if (originalToken === null) {
		localStorage.removeItem(TOKEN_KEY);
	} else {
		localStorage.setItem(TOKEN_KEY, originalToken);
	}
	server.stop(true);
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});

test("organization listings retain legacy nullish defaults and signed-out behavior", async () => {
	reply = NativeResponse.json({
		organizations: [
			{},
			{
				id: "org",
				name: "Org",
				role: "future-role",
				isPersonal: true,
				logo: "logo",
				slug: "org",
				createdAt: "created",
			},
			{ id: null, name: null, isPersonal: null },
		],
	});
	expect(await listOrgs()).toEqual([
		{
			createdAt: null,
			id: "",
			isPersonal: false,
			logo: null,
			name: "",
			role: null,
			slug: "",
		},
		{
			createdAt: "created",
			id: "org",
			isPersonal: true,
			logo: "logo",
			name: "Org",
			role: "future-role",
			slug: "org",
		},
		{
			createdAt: null,
			id: "",
			isPersonal: false,
			logo: null,
			name: "",
			role: null,
			slug: "",
		},
	]);
	expect(received[0]?.headers.get("Authorization")).toBe("Bearer org-session");
	reply = NativeResponse.json({ organizations: null });
	expect(await listOrgs()).toEqual([]);
	localStorage.removeItem(TOKEN_KEY);
	expect(await listOrgs()).toEqual([]);
	expect(await getActiveOrgId()).toBeNull();
	expect(received).toHaveLength(2);
});

test("session scope and team projections keep omission and invalid-row fallback", async () => {
	reply = NativeResponse.json({
		session: { activeOrganizationId: "org", activeTeamId: "team" },
		user: { id: "user" },
	});
	expect(await getActiveOrgId()).toBe("org");
	expect(await getActiveTeamId()).toBe("team");
	reply = NativeResponse.json({
		session: { activeOrganizationId: "org", activeTeamId: 123 },
	});
	expect(await getActiveOrgId()).toBe("org");
	reply = NativeResponse.json({ session: null });
	expect(await getActiveTeamId()).toBeNull();
	reply = new NativeResponse("invalid JSON");
	expect(await getActiveOrgId()).toBeNull();
	reply = NativeResponse.json([
		{ id: "team", name: "Team", future: 1 },
		null,
		"legacy",
		{ id: "bad" },
		{ id: 1, name: "Bad" },
	]);
	expect(await listMyOrganizationTeams("org & team")).toEqual([
		{ id: "team", name: "Team" },
	]);
	expect(received[5]?.path).toBe(
		"/api/auth/organization/list-user-teams?organizationId=org%20%26%20team"
	);
	reply = NativeResponse.json({ teams: [] });
	expect(await listMyOrganizationTeams("org")).toEqual([]);
});

const grant = {
	expiresAt: null,
	id: "grant",
	originalMicroUsd: 100,
	pool: "future-pool",
	remainingMicroUsd: 50,
};
const transferable = {
	orgs: [
		{
			canSendFrom: true,
			id: "org",
			isPersonal: false,
			name: "Org",
			role: "future-role",
			slug: "org",
		},
	],
	source: { grants: [grant], orgId: "org", topupMicroUsd: 10 },
	future: [null],
};
test("transferable credits validate all grant fields and preserve future metadata", async () => {
	expect(transferableViewSchema.parse(transferable)).toBe(transferable);
	expect(transferableViewSchema.parse(transferable).source?.grants[0]).toBe(
		grant
	);
	reply = NativeResponse.json(transferable);
	expect(await fetchTransferable("org & credits")).toEqual(transferable);
	expect(received[0]?.path).toBe(
		"/api/credits/transferable?orgId=org%20%26%20credits"
	);
	reply = NativeResponse.json({
		...transferable,
		source: { ...transferable.source, grants: [{ id: "grant" }] },
	});
	await expect(fetchTransferable()).rejects.toThrow();
});

test("credit transfers preserve request serialization, idempotency and error priority", async () => {
	const result = {
		movedGrantIds: ["grant"],
		movedGrantMicroUsd: 50,
		movedTopupMicroUsd: 0,
		ok: true,
		reason: null,
	};
	reply = NativeResponse.json(result);
	expect(
		await transferCredits(
			{
				fromOrgId: "a",
				toOrgId: "b",
				grantIds: ["grant"],
				topupMicroUsd: 0,
			},
			"transfer-key-1"
		)
	).toEqual(result);
	expect(received[0]?.body).toBe(
		'{"fromOrgId":"a","toOrgId":"b","grantIds":["grant"],"topupMicroUsd":0}'
	);
	// The caller's key is sent verbatim, so a retry of one transfer reuses it.
	expect(received[0]?.headers.get("Idempotency-Key")).toBe("transfer-key-1");
	expect(received[0]?.headers.get("Content-Type")).toBe("application/json");
	reply = NativeResponse.json(
		{ error: "", message: "secondary" },
		{ status: 403 }
	);
	await expect(
		transferCredits({ fromOrgId: "a", toOrgId: "b" }, "transfer-key-1")
	).rejects.toThrow("");
	expect(received[1]?.headers.get("Idempotency-Key")).toBe("transfer-key-1");
	reply = NativeResponse.json({ message: "denied" }, { status: 403 });
	await expect(fetchTransferable()).rejects.toThrow("denied");
	reply = new NativeResponse("invalid", { status: 503 });
	await expect(fetchTransferable()).rejects.toThrow("Request failed (503)");
});

const audit = {
	action: "change",
	actor: { email: null, id: "user", name: null, type: "user" },
	agentId: "agent",
	details: JSON.parse('{"__proto__":{"retained":true},"future":[null]}'),
	error: null,
	eventType: "control_change",
	feature: null,
	id: "audit",
	requestId: null,
	scope: "org",
	sessionId: null,
	target: "agent",
	targetId: "agent",
	timestamp: "now",
} satisfies OrganizationAuditEntry;
const activity = {
	actorId: null,
	agentId: "agent",
	apiKey: "prefix",
	backend: null,
	command: null,
	costMicroUsd: null,
	durationMs: null,
	error: null,
	evalScore: null,
	eventType: "service_call",
	feature: null,
	gatewayId: "gateway",
	id: "row",
	inputTokens: 0,
	latencyMs: 0,
	managedInference: false,
	model: null,
	outputTokens: 0,
	projectId: null,
	provider: "provider",
	providerCostMicroUsd: null,
	requestId: "request",
	sessionId: null,
	teamId: null,
	timestamp: "now",
	userName: null,
};
test("audit projections validate complete records and preserve nested prototype-named metadata", async () => {
	const controls = { count: 1, entries: [audit], canExport: true };
	expect(organizationControlsResponseSchema.parse(controls)).toBe(controls);
	expect(
		organizationControlsResponseSchema.parse(controls).entries[0]?.details
	).toBe(audit.details);
	const { model: serviceModel, ...serviceFields } = activity;
	expect(serviceModel).toBeNull();
	const events = {
		count: 2,
		entries: [activity, { ...serviceFields, widgetInstanceId: "widget" }],
	};
	expect(organizationActivityResponseSchema.parse(events)).toBe(events);
	reply = NativeResponse.json(controls);
	expect(
		JSON.stringify(await fetchOrganizationAgentControls("org", "agent", 999))
	).toContain('"__proto__":{"retained":true}');
	expect(received[0]?.path).toBe(
		"/api/control-plane/orgs/org/audit?agentId=agent&limit=200"
	);
	reply = NativeResponse.json(events);
	expect(await fetchOrganizationAgentActivity("org", "agent", -1)).toEqual(
		JSON.parse(JSON.stringify(events))
	);
	expect(received[1]?.path).toContain("limit=1");
	expect(
		organizationControlsResponseSchema.safeParse({
			count: 1,
			entries: [{ id: "audit" }],
		}).success
	).toBe(false);
	expect(
		organizationActivityResponseSchema.safeParse({
			count: 1,
			entries: [{ ...activity, inputTokens: "wrong" }],
		}).success
	).toBe(false);
});
