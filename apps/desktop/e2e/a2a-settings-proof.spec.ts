import { expect, test } from "@playwright/test";
import {
	callsFor,
	expectKnownRequests,
	expectToast,
	failNext,
	openSettings,
	type ProofWindow,
	pageErrors,
	reloadSettings,
} from "./a2a-settings-proof.helpers.ts";

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
	expect(pageErrors.get(page) ?? []).toEqual([]);
	await expectKnownRequests(page);
});

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
