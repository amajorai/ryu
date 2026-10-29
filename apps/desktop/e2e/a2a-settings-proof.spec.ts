import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

import type {
	A2aPeer,
	A2aPrincipal,
	A2aPublishedAgent,
	A2aServerConfig,
	A2aTaskRecord,
} from "../src/lib/api/a2a.ts";
import type { AgentSummary } from "../src/lib/api/agents.ts";

const STORY_URL = "/a2a-settings-proof.html";
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceDir =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

interface ProofCall {
	body?: unknown;
	method: string;
	path: string;
}

interface ProofResponse {
	acknowledged: boolean;
	data: unknown;
	method: string;
	path: string;
	status: number;
}

interface QueryDiagnostic {
	data: unknown;
	fetchStatus: string;
	key: readonly unknown[];
	observers: number;
	status: string;
}

interface FailurePlan {
	error: string;
	method: string;
	path: string;
	status: number;
}

interface ProofWindow extends Window {
	__a2aProof: {
		calls: () => ProofCall[];
		failNext: (failure: FailurePlan) => void;
		invalidate: () => Promise<void>;
		queries: () => QueryDiagnostic[];
		responses: () => ProofResponse[];
		state: () => {
			agents: AgentSummary[];
			config: A2aServerConfig;
			peers: A2aPeer[];
			principals: A2aPrincipal[];
			published: A2aPublishedAgent[];
			tasks: A2aTaskRecord[];
		};
		unknownRequests: () => string[];
		unmount: () => void;
	};
}

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
	expect(pageErrors.get(page) ?? []).toEqual([]);
	await expectKnownRequests(page);
});

async function expectKnownRequests(page: Page) {
	expect(
		await page.evaluate(() =>
			(window as ProofWindow).__a2aProof.unknownRequests()
		)
	).toEqual([]);
}

async function reloadSettings(page: Page) {
	// A navigation replaces the renderer ledger, so assert the old lifetime first.
	await expectKnownRequests(page);
	await page.reload();
}

async function openSettings(page: Page, failures: FailurePlan[] = []) {
	await page.addInitScript((initialFailures) => {
		if (sessionStorage.getItem("ryu:a2a-proof:initialized") !== "1") {
			localStorage.clear();
			localStorage.setItem(
				"ryu:a2a-proof:failures",
				JSON.stringify(initialFailures)
			);
			sessionStorage.setItem("ryu:a2a-proof:initialized", "1");
		}
	}, failures);
	await page.goto(STORY_URL);
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
}

async function proofCalls(page: Page): Promise<ProofCall[]> {
	return await page.evaluate(() =>
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.calls()
	);
}

async function callsFor(
	page: Page,
	method: string,
	path: string
): Promise<ProofCall[]> {
	return (await proofCalls(page)).filter(
		(call) => call.method === method && call.path === path
	);
}

async function failNext(page: Page, failure: FailurePlan) {
	await page.evaluate((nextFailure) => {
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.failNext(nextFailure);
	}, failure);
}

const PAUSED_CLOCK_STEP_MS = 10;
const PAUSED_CLOCK_MAX_STEPS = 50;

async function settlePausedClock(page: Page) {
	for (let step = 0; step < PAUSED_CLOCK_MAX_STEPS; step += 1) {
		await page.clock.runFor(PAUSED_CLOCK_STEP_MS);
		const settled = await page.evaluate(() => {
			const queries = (window as ProofWindow).__a2aProof.queries();
			return (
				queries.length === 5 &&
				queries.every(
					(query) => query.status === "success" && query.fetchStatus === "idle"
				)
			);
		});
		if (settled) {
			return;
		}
	}
	throw new Error(
		`A2A queries did not settle within ${PAUSED_CLOCK_STEP_MS * PAUSED_CLOCK_MAX_STEPS}ms of paused clock time`
	);
}

async function expectToast(page: Page, message: string) {
	await expect(page.getByText(message, { exact: true })).toBeVisible();
}

test("the unavailable-settings retry refetches the real settings query", async ({
	page,
}) => {
	await openSettings(page, [
		{
			error: "Core is temporarily unavailable",
			method: "GET",
			path: "/api/a2a/settings",
			status: 503,
		},
	]);

	await expect(page.getByText("A2A settings are unavailable")).toBeVisible();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByText("Agent-to-Agent endpoint")).toBeVisible();
	await expect
		.poll(async () => (await callsFor(page, "GET", "/api/a2a/settings")).length)
		.toBe(2);
});

test("the shared Retry A2A data action refetches every failed settings section", async ({
	page,
}) => {
	await openSettings(page, [
		{
			error: "Peer list temporarily denied",
			method: "GET",
			path: "/api/a2a/peers",
			status: 403,
		},
	]);
	await expect(
		page.getByRole("button", { name: "Retry A2A data" })
	).toBeVisible();
	await expect(page.getByText("Peer list temporarily denied")).toBeVisible();

	await page.getByRole("button", { name: "Retry A2A data" }).click();
	await expect(
		page.getByRole("button", { name: "Retry A2A data" })
	).toHaveCount(0);
	for (const path of [
		"/api/a2a/settings",
		"/api/a2a/peers",
		"/api/a2a/principals",
		"/api/a2a/published-agents",
		"/api/a2a/tasks",
	]) {
		await expect
			.poll(async () => (await callsFor(page, "GET", path)).length)
			.toBe(2);
	}
});

test("endpoint fields validate, save exact configuration, recover, and reload", async ({
	page,
}) => {
	await openSettings(page);
	await expect(page.getByLabel("Accept inbound A2A tasks")).not.toBeChecked();
	await expect(
		page.getByLabel("Expose authenticated extended Agent Card")
	).not.toBeChecked();
	await page.getByLabel("Accept inbound A2A tasks").click();
	await page.getByLabel("Display name").fill("Research Hub");
	await page.getByLabel("Public base URL").fill("http://insecure.example.test");
	await page.getByLabel("Description").fill("Reviewed and cited research");
	await page.getByLabel("Maximum concurrent tasks").fill("8");
	await page.getByLabel("Maximum payload (MiB)").fill("4");
	await page.getByLabel("Expose authenticated extended Agent Card").click();
	await expect(
		page.getByText("http://insecure.example.test/.well-known/agent-card.json", {
			exact: true,
		})
	).toBeVisible();

	await page.getByRole("button", { name: "Save endpoint" }).click();
	await expectToast(page, "A2A settings validation failed");
	await expect(page.getByLabel("Display name")).toHaveValue("Research Hub");
	const rejected = await callsFor(page, "PUT", "/api/a2a/settings");
	expect(rejected).toHaveLength(1);
	expect(rejected[0]?.body).toEqual({
		description: "Reviewed and cited research",
		displayName: "Research Hub",
		enabled: true,
		exposeExtendedCard: true,
		maxConcurrentTasks: 8,
		maxPayloadBytes: 4 * 1024 * 1024,
		publicBaseUrl: "http://insecure.example.test",
		tenantId: "default",
		updatedAt: "2026-09-27T00:00:00.000Z",
	});
	expect(
		(
			await page.evaluate(() =>
				/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
					window as ProofWindow
				).__a2aProof.state()
			)
		).config
	).toMatchObject({ enabled: false, displayName: "Ryu Studio" });

	await page
		.getByLabel("Public base URL")
		.fill("https://research.example.test/");
	await expect(
		page.getByText(
			"https://research.example.test/.well-known/agent-card.json",
			{ exact: true }
		)
	).toBeVisible();
	await failNext(page, {
		error: "A2A settings write was denied",
		method: "PUT",
		path: "/api/a2a/settings",
		status: 403,
	});
	await page.getByRole("button", { name: "Save endpoint" }).click();
	await expectToast(page, "A2A settings write was denied");
	await expect(page.getByLabel("Public base URL")).toHaveValue(
		"https://research.example.test/"
	);
	await page.getByRole("button", { name: "Save endpoint" }).click();
	await expectToast(page, "A2A endpoint settings saved");
	await expect
		.poll(async () => (await callsFor(page, "PUT", "/api/a2a/settings")).length)
		.toBe(3);
	const writes = await callsFor(page, "PUT", "/api/a2a/settings");
	expect(writes[1]?.body).toEqual({
		description: "Reviewed and cited research",
		displayName: "Research Hub",
		enabled: true,
		exposeExtendedCard: true,
		maxConcurrentTasks: 8,
		maxPayloadBytes: 4 * 1024 * 1024,
		publicBaseUrl: "https://research.example.test/",
		tenantId: "default",
		updatedAt: "2026-09-27T00:00:00.000Z",
	});
	await reloadSettings(page);
	await expect(page.getByLabel("Accept inbound A2A tasks")).toBeChecked();
	await expect(
		page.getByLabel("Expose authenticated extended Agent Card")
	).toBeChecked();
	await expect(page.getByLabel("Display name")).toHaveValue("Research Hub");
	await expect(page.getByLabel("Maximum concurrent tasks")).toHaveValue("8");
	await expect(page.getByLabel("Maximum payload (MiB)")).toHaveValue("4");
	await expect(page.getByLabel("Public base URL")).toHaveValue(
		"https://research.example.test/"
	);
	await expect(
		page.getByText(
			"https://research.example.test/.well-known/agent-card.json",
			{ exact: true }
		)
	).toBeVisible();
	expect(
		(
			await page.evaluate(() =>
				/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
					window as ProofWindow
				).__a2aProof.state()
			)
		).config
	).toMatchObject({
		displayName: "Research Hub",
		publicBaseUrl: "https://research.example.test/",
	});

	// Clearing the public base URL stores null (not an empty string), and the
	// Agent Card falls back to this node's own address.
	await page.getByLabel("Public base URL").fill("");
	await expect(page.getByLabel("Public base URL")).toHaveAttribute(
		"placeholder",
		"https://agent.example.com"
	);
	const nodeOrigin = await page.evaluate(() => window.location.origin);
	await expect(
		page.getByText(`${nodeOrigin}/.well-known/agent-card.json`, { exact: true })
	).toBeVisible();
	// The renderer ledger restarts with each page load, so count from here.
	const clearedBefore = (await callsFor(page, "PUT", "/api/a2a/settings"))
		.length;
	await page.getByRole("button", { name: "Save endpoint" }).click();
	await expectToast(page, "A2A endpoint settings saved");
	await expect
		.poll(async () => (await callsFor(page, "PUT", "/api/a2a/settings")).length)
		.toBe(clearedBefore + 1);
	expect(
		(await callsFor(page, "PUT", "/api/a2a/settings")).at(-1)?.body
	).toMatchObject({ displayName: "Research Hub", publicBaseUrl: null });
	await reloadSettings(page);
	await expect(page.getByLabel("Public base URL")).toHaveValue("");
	await expect(page.getByLabel("Display name")).toHaveValue("Research Hub");
});

test("published-agent selection, publication, enablement, removal and reload use exact writes", async ({
	page,
}) => {
	await openSettings(page);
	const publishButton = page.getByRole("button", {
		name: "Publish",
		exact: true,
	});
	await expect(publishButton).toBeDisabled();
	await page.getByLabel("Local agent").selectOption("agent-researcher");
	await expect(publishButton).toBeEnabled();
	await failNext(page, {
		error: "Publishing is temporarily denied",
		method: "POST",
		path: "/api/a2a/published-agents",
		status: 403,
	});
	await publishButton.click();
	await expectToast(page, "Publishing is temporarily denied");
	await expect(page.getByLabel("Local agent")).toHaveValue("agent-researcher");
	await publishButton.click();
	await expect(
		page.getByText("agent-researcher · 1 skill", { exact: true })
	).toBeVisible();
	const publishWrites = await callsFor(
		page,
		"POST",
		"/api/a2a/published-agents"
	);
	expect(publishWrites).toHaveLength(2);
	expect(publishWrites[0]?.body).toEqual({
		agentId: "agent-researcher",
		description: "Research across trusted sources",
		enabled: true,
		name: "Researcher",
		skills: [
			{
				description: "Research across trusted sources",
				id: "ryu:agent-researcher",
				name: "Researcher",
				tags: ["ryu"],
			},
		],
	});
	expect(publishWrites[1]?.body).toEqual(publishWrites[0]?.body);
	await expect(page.getByLabel("Local agent")).toHaveValue("");

	await page.getByRole("switch", { name: "Disable Legacy Analyst" }).click();
	await expect(
		page.getByRole("switch", { name: "Enable Legacy Analyst" })
	).toBeVisible();
	const update = (await callsFor(page, "POST", "/api/a2a/published-agents")).at(
		-1
	);
	expect(update?.body).toEqual({
		agentId: "agent-legacy",
		description: "Previously published research agent",
		enabled: false,
		id: "published-legacy",
		name: "Legacy Analyst",
		skills: [
			{
				description: "Summarizes source material",
				id: "legacy-summary",
				name: "Source summary",
				tags: ["research"],
			},
		],
	});
	await reloadSettings(page);
	await expect(
		page.getByRole("switch", { name: "Enable Legacy Analyst" })
	).not.toBeChecked();

	await failNext(page, {
		error: "Removal is temporarily denied",
		method: "DELETE",
		path: "/api/a2a/published-agents/published-legacy",
		status: 503,
	});
	const remove = page.getByRole("button", {
		name: "Remove published agent Legacy Analyst",
	});
	await remove.click();
	await expectToast(page, "Removal is temporarily denied");
	await expect(page.getByText("Legacy Analyst", { exact: true })).toBeVisible();
	await remove.click();
	await expect(page.getByText("Legacy Analyst", { exact: true })).toHaveCount(
		0
	);
	expect(
		await callsFor(page, "DELETE", "/api/a2a/published-agents/published-legacy")
	).toHaveLength(2);
	await reloadSettings(page);
	await expect(
		page.getByText("agent-researcher · 1 skill", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Legacy Analyst", { exact: true })).toHaveCount(
		0
	);
});

test("peer discovery validates and sends none, bearer, API-key, Basic and OAuth credentials", async ({
	page,
}) => {
	await openSettings(page);
	const discover = page.getByRole("button", { name: "Discover peer" });
	await expect(discover).toBeDisabled();
	await page
		.getByLabel("Agent Card or base URL")
		.fill("http://peer.example.test");
	await page.getByLabel("Name (optional)").fill("Hermes staged endpoint");
	await page.getByLabel("Bearer token").fill("   ");
	await expect(discover).toBeDisabled();
	await page.getByLabel("Bearer token").fill("bearer-secret-01");
	await expect(discover).toBeEnabled();
	await discover.click();
	await expectToast(page, "Peer URL must use HTTPS");
	await expect(page.getByText("Fixture peer", { exact: true })).toHaveCount(0);
	const invalidUrl = (await callsFor(page, "POST", "/api/a2a/discover")).at(-1);
	expect(invalidUrl?.body).toEqual({
		credential: { kind: "bearer", token: "bearer-secret-01" },
		name: "Hermes staged endpoint",
		url: "http://peer.example.test",
	});
	await expect(page.getByLabel("Agent Card or base URL")).toHaveValue(
		"http://peer.example.test"
	);
	await page
		.getByLabel("Agent Card or base URL")
		.fill("https://peer.example.test");
	await discover.click();
	await expect(
		page.getByText("Hermes staged endpoint", { exact: true })
	).toBeVisible();
	await expect(page.getByLabel("Agent Card or base URL")).toHaveValue("");
	let discovery = (await callsFor(page, "POST", "/api/a2a/discover")).at(-1);
	expect(discovery?.body).toEqual({
		credential: { kind: "bearer", token: "bearer-secret-01" },
		name: "Hermes staged endpoint",
		url: "https://peer.example.test",
	});

	await page.getByLabel("Credential").selectOption("none");
	// With no credential required, only the URL gates discovery: blank or
	// whitespace never reaches Core.
	await expect(page.getByLabel("Agent Card or base URL")).toHaveAttribute(
		"placeholder",
		"https://peer.example.com"
	);
	await page.getByLabel("Agent Card or base URL").fill("   ");
	await expect(discover).toBeDisabled();
	await page
		.getByLabel("Agent Card or base URL")
		.fill("https://no-auth.example.test");
	await discover.click();
	await expect(page.getByLabel("Agent Card or base URL")).toHaveValue("");
	discovery = (await callsFor(page, "POST", "/api/a2a/discover")).at(-1);
	expect(discovery?.body).toEqual({ url: "https://no-auth.example.test" });

	await page.getByLabel("Credential").selectOption("api_key");
	await page
		.getByLabel("Agent Card or base URL")
		.fill("https://key.example.test");
	await page.getByLabel("Header name").fill("  ");
	await page.getByLabel("API key").fill("key-secret-02");
	await expect(discover).toBeDisabled();
	await page.getByLabel("Header name").fill("X-Ryu-Token");
	await expect(discover).toBeEnabled();
	await discover.click();
	await expect(page.getByLabel("Agent Card or base URL")).toHaveValue("");
	discovery = (await callsFor(page, "POST", "/api/a2a/discover")).at(-1);
	expect(discovery?.body).toEqual({
		credential: {
			header: "X-Ryu-Token",
			kind: "api_key",
			value: "key-secret-02",
		},
		url: "https://key.example.test",
	});

	await page.getByLabel("Credential").selectOption("basic");
	await page
		.getByLabel("Agent Card or base URL")
		.fill("https://basic.example.test");
	await page.getByLabel("Username").fill("ryu-peer");
	await expect(discover).toBeDisabled();
	await page.getByLabel("Password").fill("basic-secret-03");
	await discover.click();
	await expect(page.getByLabel("Agent Card or base URL")).toHaveValue("");
	discovery = (await callsFor(page, "POST", "/api/a2a/discover")).at(-1);
	expect(discovery?.body).toEqual({
		credential: {
			kind: "basic",
			password: "basic-secret-03",
			username: "ryu-peer",
		},
		url: "https://basic.example.test",
	});

	await page.getByLabel("Credential").selectOption("oauth2_client_credentials");
	await page
		.getByLabel("Agent Card or base URL")
		.fill("https://oauth.example.test");
	await page.getByLabel("Token URL").fill("https://auth.example.test/token");
	await expect(discover).toBeDisabled();
	await page.getByLabel("Client ID").fill("fixture-client");
	await expect(discover).toBeDisabled();
	await page.getByLabel("Client secret").fill("oauth-secret-04");
	await page
		.getByLabel("Scopes (optional)")
		.fill("a2a.send a2a.read, a2a.send");
	await expect(discover).toBeEnabled();
	// The token endpoint is required: a blank Token URL blocks discovery even
	// with a client ID and secret, and restoring it re-enables it.
	await expect(page.getByLabel("Token URL")).toHaveAttribute(
		"placeholder",
		"https://auth.example.com/oauth/token"
	);
	await page.getByLabel("Token URL").fill("  ");
	await expect(discover).toBeDisabled();
	await page.getByLabel("Token URL").fill("https://auth.example.test/token");
	await expect(discover).toBeEnabled();
	await discover.click();
	await expect(page.getByLabel("Agent Card or base URL")).toHaveValue("");
	discovery = (await callsFor(page, "POST", "/api/a2a/discover")).at(-1);
	expect(discovery?.body).toEqual({
		credential: {
			clientId: "fixture-client",
			clientSecret: "oauth-secret-04",
			kind: "oauth2_client_credentials",
			scopes: ["a2a.send", "a2a.read", "a2a.send"],
			tokenUrl: "https://auth.example.test/token",
		},
		url: "https://oauth.example.test",
	});

	const storedState = await page.evaluate(() =>
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.state()
	);
	const persistedPeers = JSON.stringify(storedState.peers);
	for (const secret of [
		"bearer-secret-01",
		"key-secret-02",
		"basic-secret-03",
		"oauth-secret-04",
	]) {
		expect(persistedPeers).not.toContain(secret);
	}
	await reloadSettings(page);
	await expect(
		page.getByText("peer.example.test", { exact: false }).first()
	).toBeVisible();
	const reloadedState = await page.evaluate(() =>
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.state()
	);
	expect(JSON.stringify(reloadedState.peers)).not.toContain("oauth-secret-04");
});

test("trusted peers are added through the production agent API, then can be revoked and removed", async ({
	page,
}) => {
	await openSettings(page);
	const addPeer = page.getByRole("button", {
		name: "Add Hermes Research to Agents",
	});
	await expect(addPeer).toBeDisabled();
	await failNext(page, {
		error: "Trust update denied",
		method: "PUT",
		path: "/api/a2a/peers/peer-hermes/trust",
		status: 403,
	});
	await page.getByRole("button", { name: "Trust Hermes Research" }).click();
	await expectToast(page, "Trust update denied");
	await expect(addPeer).toBeDisabled();
	await page.getByRole("button", { name: "Trust Hermes Research" }).click();
	await expect(addPeer).toBeEnabled();
	const trustCalls = await callsFor(
		page,
		"PUT",
		"/api/a2a/peers/peer-hermes/trust"
	);
	expect(trustCalls.map((call) => call.body)).toEqual([
		{ trust: "trusted" },
		{ trust: "trusted" },
	]);

	await addPeer.click();
	await expect(
		page.getByRole("button", { name: "Add Hermes Research to Agents" })
	).toHaveText("Added");
	const agentWrite = (await callsFor(page, "POST", "/api/agents")).at(-1);
	expect(agentWrite?.body).toEqual({
		description:
			"Remote A2A peer at https://hermes.example.com/.well-known/agent-card.json",
		engine: "a2a:peer-hermes",
		identity_mode: "managed",
		model: null,
		name: "Hermes Research",
		system_prompt: null,
		title: "Remote A2A",
		tools: [],
	});
	const agentState = await page.evaluate(() =>
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.state()
	);
	expect(agentState.agents).toContainEqual(
		expect.objectContaining({
			id: "agent-remote-hermes",
			engine: "a2a:peer-hermes",
		})
	);
	await reloadSettings(page);
	await expect(
		page.getByRole("button", { name: "Add Hermes Research to Agents" })
	).toHaveText("Added");
	await expect(
		page.getByRole("button", { name: "Add Hermes Research to Agents" })
	).toBeDisabled();

	await page
		.getByRole("button", { name: "Revoke trust from Hermes Research" })
		.click();
	await expect(
		page.getByRole("button", { name: "Trust Hermes Research" })
	).toBeVisible();
	const revokeTrust = (
		await callsFor(page, "PUT", "/api/a2a/peers/peer-hermes/trust")
	).at(-1);
	expect(revokeTrust?.body).toEqual({ trust: "revoked" });
	await reloadSettings(page);
	await expect(
		page.getByRole("button", { name: "Trust Hermes Research" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add Hermes Research to Agents" })
	).toBeDisabled();
	await failNext(page, {
		error: "Peer removal denied",
		method: "DELETE",
		path: "/api/a2a/peers/peer-hermes",
		status: 503,
	});
	const removePeer = page.getByRole("button", {
		name: "Remove peer Hermes Research",
	});
	await removePeer.click();
	await expectToast(page, "Peer removal denied");
	await expect(removePeer).toBeVisible();
	await removePeer.click();
	await expect(removePeer).toHaveCount(0);
	expect(
		await callsFor(page, "DELETE", "/api/a2a/peers/peer-hermes")
	).toHaveLength(2);
	await reloadSettings(page);
	await expect(
		page.getByRole("button", { name: "Remove peer Hermes Research" })
	).toHaveCount(0);
});

test("scoped tokens validate, issue once, copy or explain failure, revoke, and reload", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openSettings(page);
	const issue = page.getByRole("button", { name: "Issue token" });
	await expect(issue).toBeDisabled();
	await page.getByLabel("Peer name").fill("Build verifier");
	for (const scope of [
		"send",
		"read",
		"cancel",
		"subscribe",
		"push config",
		"extended card",
	]) {
		await page.getByRole("checkbox", { name: scope }).uncheck();
	}
	await expect(issue).toBeDisabled();
	await page.getByRole("checkbox", { name: "send" }).check();
	await page.getByRole("checkbox", { name: "read" }).check();
	await failNext(page, {
		error: "Token issuance denied",
		method: "POST",
		path: "/api/a2a/principals",
		status: 403,
	});
	await issue.click();
	await expectToast(page, "Token issuance denied");
	await expect(page.getByLabel("Peer name")).toHaveValue("Build verifier");
	await issue.click();
	await expect(page.getByText("Copy this token now")).toBeVisible();
	const token = page.getByText("ryu_a2a_one_time_fixture_token", {
		exact: true,
	});
	await expect(token).toHaveCount(0);
	const reveal = page.getByRole("button", { name: "Reveal A2A token" });
	await reveal.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByText("ryu_a2a_one_time_fixture_token", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Hide A2A token" }).click();
	await expect(token).toHaveCount(0);
	const issueCalls = await callsFor(page, "POST", "/api/a2a/principals");
	expect(issueCalls).toHaveLength(2);
	expect(issueCalls.map((call) => call.body)).toEqual([
		{ name: "Build verifier", scopes: ["send", "read"] },
		{ name: "Build verifier", scopes: ["send", "read"] },
	]);
	await page.getByRole("button", { name: "Copy A2A token" }).click();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("ryu_a2a_one_time_fixture_token");
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => Promise.reject(new Error("clipboard denied")),
			},
		});
	});
	await page.getByRole("button", { name: "Copy A2A token" }).click();
	await expectToast(
		page,
		"Couldn't copy the A2A token. Reveal and copy it while this panel is open."
	);
	expect(pageErrors).toEqual([]);
	const persistedState = await page.evaluate(() =>
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.state()
	);
	expect(JSON.stringify(persistedState.principals)).not.toContain(
		"ryu_a2a_one_time_fixture_token"
	);
	await reloadSettings(page);
	await expect(page.getByText("Copy this token now")).toHaveCount(0);
	await expect(page.getByText("Build verifier", { exact: true })).toBeVisible();
	await failNext(page, {
		error: "Token revoke denied",
		method: "DELETE",
		path: "/api/a2a/principals/principal-2",
		status: 503,
	});
	const revoke = page.getByRole("button", {
		name: "Revoke token for Build verifier",
	});
	await revoke.click();
	await expectToast(page, "Token revoke denied");
	await expect(revoke).toBeEnabled();
	await revoke.click();
	await expect(page.getByText("revoked", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Revoke token for Build verifier" })
	).toBeDisabled();
	expect(
		await callsFor(page, "DELETE", "/api/a2a/principals/principal-2")
	).toHaveLength(2);
	await reloadSettings(page);
	await expect(page.getByText("revoked", { exact: true })).toBeVisible();
});

test("task details disclose artifacts and active-task cancellation recovers and persists", async ({
	page,
}) => {
	await openSettings(page);
	const artifactDetails = page.locator("details").filter({
		has: page.locator(
			'summary[aria-label="View artifacts for A2A task task-market-brief"]'
		),
	});
	await expect(artifactDetails).toBeVisible();
	await expect(artifactDetails).not.toHaveAttribute("open", "");
	await artifactDetails.getByText("View artifacts").click();
	await expect(
		page.getByText("Brief · artifact-brief", { exact: true })
	).toBeVisible();
	await artifactDetails.getByText("View artifacts").click();
	await expect(artifactDetails).not.toHaveAttribute("open", "");
	await expect(
		page.getByText("Brief · artifact-brief", { exact: true })
	).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Cancel A2A task task-market-brief" })
	).toBeDisabled();

	await failNext(page, {
		error: "Task cancellation denied",
		method: "POST",
		path: "/api/a2a/tasks/task-working/cancel",
		status: 403,
	});
	const cancel = page.getByRole("button", {
		name: "Cancel A2A task task-live-review",
	});
	await expect(cancel).toBeEnabled();
	await cancel.click();
	await expectToast(page, "Task cancellation denied");
	await expect(page.getByText("working", { exact: true })).toBeVisible();
	await cancel.click();
	await expect(page.getByText("canceled", { exact: true })).toBeVisible();
	const cancelCalls = await callsFor(
		page,
		"POST",
		"/api/a2a/tasks/task-working/cancel"
	);
	expect(cancelCalls).toHaveLength(2);
	expect(cancelCalls[0]?.body).toBeUndefined();
	await reloadSettings(page);
	await expect(page.getByText("canceled", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Cancel A2A task task-live-review" })
	).toBeDisabled();
});

test("the rendered Desktop A2A settings sections fit together without runtime errors", async ({
	page,
}, testInfo) => {
	await page.clock.install({ time: new Date("2026-09-27T00:00:00.000Z") });
	await page.clock.pauseAt(new Date("2026-09-27T00:00:00.100Z"));
	await openSettings(page);
	// TanStack Query batches observer notifications through a zero-delay
	// setTimeout, which the paused fake clock owns. Step it in small increments
	// (bounded far below the 2-second task poll) until every query settles.
	await settlePausedClock(page);
	for (const section of [
		"Agent-to-Agent endpoint",
		"Published agents",
		"Peer agents",
		"Inbound peer access",
		"Recent A2A tasks",
	]) {
		await expect(page.getByText(section, { exact: true })).toBeVisible();
	}
	const expected = await page.evaluate(() => {
		const raw = localStorage.getItem("ryu:a2a-proof:state");
		if (!raw) {
			throw new Error("Mounted A2A fixture has no independent stored state");
		}
		// SAFETY: this private key contains the exact typed state written by the
		// current proof fixture; this view is not input validation for production.
		const state = JSON.parse(raw) as ReturnType<
			ProofWindow["__a2aProof"]["state"]
		>;
		return [
			{
				data: state.config,
				key: ["a2a", location.origin, "settings"],
				path: "/api/a2a/settings",
			},
			{
				data: state.peers,
				key: ["a2a", location.origin, "peers"],
				path: "/api/a2a/peers",
			},
			{
				data: state.principals,
				key: ["a2a", location.origin, "principals"],
				path: "/api/a2a/principals",
			},
			{
				data: state.published,
				key: ["a2a", location.origin, "published-agents"],
				path: "/api/a2a/published-agents",
			},
			{
				data: state.tasks,
				key: ["a2a", location.origin, "tasks"],
				path: "/api/a2a/tasks",
			},
		];
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as ProofWindow).__a2aProof
					.queries()
					.map(({ key, fetchStatus, observers, status }) => ({
						key,
						fetchStatus,
						observers,
						status,
					}))
					.sort((left, right) =>
						String(left.key[2]).localeCompare(String(right.key[2]))
					)
			)
		)
		.toEqual(
			expected
				.map(({ key }) => ({
					key,
					fetchStatus: "idle",
					observers: 1,
					status: "success",
				}))
				.sort((left, right) =>
					String(left.key[2]).localeCompare(String(right.key[2]))
				)
		);
	const mountedQueries = await page.evaluate(() =>
		(window as ProofWindow).__a2aProof.queries()
	);
	const initialResponses = await page.evaluate(() =>
		(window as ProofWindow).__a2aProof.responses()
	);
	expect(mountedQueries).toHaveLength(5);
	expect(initialResponses).toHaveLength(5);
	for (const { data, key, path } of expected) {
		expect(mountedQueries.find((query) => query.key[2] === key[2])).toEqual({
			data,
			fetchStatus: "idle",
			key,
			observers: 1,
			status: "success",
		});
		expect(
			initialResponses.filter((response) => response.path === path)
		).toEqual([
			{
				acknowledged: true,
				data,
				method: "GET",
				path,
				status: 200,
			},
		]);
		expect(await callsFor(page, "GET", path)).toHaveLength(1);
	}
	await expect(page.getByLabel("Display name")).toHaveValue("Ryu Studio");
	await expect(page.getByLabel("Public base URL")).toHaveValue(
		"https://agents.example.com"
	);
	await expect(
		page.getByRole("switch", { name: "Disable Legacy Analyst" })
	).toBeChecked();
	await expect(
		page.getByText("Hermes Research", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Hermes production", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("send, read, cancel, subscribe", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Cancel A2A task task-market-brief" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Cancel A2A task task-live-review" })
	).toBeEnabled();
	const displayName = page.getByLabel("Display name");
	await displayName.focus();
	await expect(displayName).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Public base URL")).toBeFocused();
	const artifactSummary = page.locator(
		'summary[aria-label="View artifacts for A2A task task-market-brief"]'
	);
	await artifactSummary.focus();
	await expect(artifactSummary).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(
		page.getByText("Brief · artifact-brief", { exact: true })
	).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(
		page.getByText("Brief · artifact-brief", { exact: true })
	).toBeHidden();
	await page.clock.runFor(2100);
	await expect
		.poll(async () => (await callsFor(page, "GET", "/api/a2a/tasks")).length)
		.toBe(2);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as ProofWindow).__a2aProof
						.responses()
						.filter((response) => response.path === "/api/a2a/tasks").length
			)
		)
		.toBe(2);
	const expectedTasks = expected.find(({ path }) => path === "/api/a2a/tasks");
	if (!expectedTasks) {
		throw new Error("Missing independent A2A task DTO expectation");
	}
	expect(
		await page.evaluate(() =>
			(window as ProofWindow).__a2aProof
				.responses()
				.filter((response) => response.path === "/api/a2a/tasks")
		)
	).toEqual(
		Array.from({ length: 2 }, () => ({
			acknowledged: true,
			data: expectedTasks.data,
			method: "GET",
			path: expectedTasks.path,
			status: 200,
		}))
	);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as ProofWindow).__a2aProof
					.queries()
					.map((query) => query.fetchStatus)
			)
		)
		.toEqual(["idle", "idle", "idle", "idle", "idle"]);
	for (const { path } of expected.filter(
		({ path }) => path !== "/api/a2a/tasks"
	)) {
		expect(await callsFor(page, "GET", path)).toHaveLength(1);
	}
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, "a2a-settings-production-ui.png"),
	});
	const beforeUnmount = await page.evaluate(() => ({
		calls: (window as ProofWindow).__a2aProof.calls(),
		queries: (window as ProofWindow).__a2aProof.queries(),
		responses: (window as ProofWindow).__a2aProof.responses(),
	}));
	await page.evaluate(() => (window as ProofWindow).__a2aProof.unmount());
	await expect(page.locator("#root")).toBeEmpty();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as ProofWindow).__a2aProof
					.queries()
					.map((query) => query.observers)
			)
		)
		.toEqual([0, 0, 0, 0, 0]);
	await page.evaluate(() => (window as ProofWindow).__a2aProof.invalidate());
	await page.clock.runFor(10_000);
	const afterUnmount = await page.evaluate(() => ({
		calls: (window as ProofWindow).__a2aProof.calls(),
		queries: (window as ProofWindow).__a2aProof.queries(),
		responses: (window as ProofWindow).__a2aProof.responses(),
	}));
	expect(afterUnmount.calls).toEqual(beforeUnmount.calls);
	expect(afterUnmount.responses).toEqual(beforeUnmount.responses);
	for (const { data, key } of expected) {
		expect(
			afterUnmount.queries.find((query) => query.key[2] === key[2])
		).toEqual({
			data,
			fetchStatus: "idle",
			key,
			observers: 0,
			status: "success",
		});
	}
	await testInfo.attach("a2a-query-acknowledgment-and-unmount.json", {
		body: JSON.stringify({ expected, beforeUnmount, afterUnmount }, null, 2),
		contentType: "application/json",
	});
	expect(pageErrors.get(page) ?? []).toEqual([]);
});
