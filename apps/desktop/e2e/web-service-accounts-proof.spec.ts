import { expect, type Page, type Route, test } from "@playwright/test";
import type { GatewayWebAccountsView } from "../src/lib/api/web-service-accounts.ts";
import { sdkAccountProviders } from "./harness/sdk-accounts-fixture.ts";

const FIRST = "a".repeat(64);
const SAVED = "b".repeat(64);
const ACCOUNT = "1".repeat(64);
function view(revision = FIRST): GatewayWebAccountsView {
	return {
		webServiceSchema: 1,
		configRevision: revision,
		providers: [
			{
				provider: "tavily",
				anonymous: false,
				accounts: [
					{
						accountId: ACCOUNT,
						context: { kind: "default" },
						diagnostic: null,
						policy: { name: "Desk", enabled: true, priority: 0 },
					},
				],
			},
			{
				provider: "google-pse",
				anonymous: false,
				accounts: [
					{
						accountId: "2".repeat(64),
						context: {
							kind: "google_pse",
							engine_id: "engine-one",
							existing_customer_acknowledged: true,
						},
						diagnostic: null,
						policy: { name: "Research", enabled: true, priority: 1 },
					},
					{
						accountId: "3".repeat(64),
						context: {
							kind: "google_pse",
							engine_id: "engine-two",
							existing_customer_acknowledged: false,
						},
						diagnostic: "existing_customer_required",
						policy: { name: "Archive", enabled: false, priority: 2 },
					},
				],
			},
			{
				provider: "searchapi",
				anonymous: false,
				accounts: [
					{
						accountId: "4".repeat(64),
						context: { kind: "search_api", engine: "google" },
						diagnostic: null,
						policy: { name: "SERP", enabled: true, priority: 0 },
					},
				],
			},
			{ provider: "jina-reader", anonymous: true, accounts: [] },
		],
	};
}
function receipt(revision = SAVED, status = "applied") {
	return {
		success: true,
		persisted: true,
		configRevision: revision,
		gateway_application: {
			status,
			requestedRevision: revision,
			appliedRevision: revision,
			epoch: { boot: "00000000-0000-4000-8000-000000000001", sequence: 1 },
		},
	};
}
async function json<FixturePayload>(
	route: Route,
	body: FixturePayload,
	status = 200
) {
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}
async function pageWithView(
	page: Page,
	handler?: (route: Route) => Promise<void>
) {
	await page.route("**/api/gateway/web-accounts", async (route) => {
		if (route.request().method() === "GET") {
			await json(route, view());
		} else if (handler) {
			await handler(route);
		} else {
			await json(route, receipt());
		}
	});
	await page.goto("/web-service-accounts-proof.html");
	await expect(
		page.getByRole("button", { name: "Manage Tavily accounts" })
	).toBeVisible();
}

test("eleven direct providers, full account contexts and service headers render with product proof", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await pageWithView(page);
	await expect(
		page.getByRole("button", { name: /^Manage .+ accounts$/ })
	).toHaveCount(11);
	await expect(
		page.getByRole("button", { name: "Manage Parallel accounts" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Search and page fetch" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Web search", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Page fetch", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Manage Google Custom Search accounts" })
		.click();
	await expect(
		page.getByText("Engine: engine-one", { exact: false })
	).toBeVisible();
	await expect(
		page.getByText("Engine: engine-two", { exact: false })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Replace Google Custom Search Research" })
		.click();
	await expect(
		page.getByLabel("Google Custom Search search engine ID")
	).toHaveValue("engine-one");
	await expect(
		page.getByRole("checkbox", {
			name: "Google Custom Search existing customer confirmation",
		})
	).toBeChecked();
	await expect
		.poll(() =>
			page
				.locator("img")
				.evaluateAll(
					(images) =>
						images.filter(
							(image) =>
								image instanceof HTMLImageElement && image.naturalWidth === 0
						).length
				)
		)
		.toBe(0);
	expect(errors).toEqual([]);
	await page
		.getByTestId("web-accounts-product")
		.screenshot({ path: testInfo.outputPath("web-accounts-product.png") });
});

test("mobile account context stays readable without horizontal overflow", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await pageWithView(page);
	await page
		.getByRole("button", { name: "Manage Google Custom Search accounts" })
		.click();
	await page
		.getByRole("button", { name: "Replace Google Custom Search Research" })
		.click();
	await expect(
		page.getByLabel("Google Custom Search search engine ID")
	).toHaveValue("engine-one");
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth
		)
	).toBe(true);
	await page.getByTestId("web-accounts-product").screenshot({
		path: testInfo.outputPath("web-accounts-mobile-product.png"),
	});
});

test("opaque-ID policy and targeted Google replacement send strict revisions and full context", async ({
	page,
}) => {
	const writes: unknown[] = [];
	await pageWithView(page, async (route) => {
		writes.push(route.request().postDataJSON());
		await json(route, receipt(FIRST));
	});
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await page.getByLabel("Tavily Desk priority").fill("5");
	await page.getByRole("switch", { name: "Enable Tavily Desk" }).click();
	await page.getByRole("button", { name: "Save account", exact: true }).click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toMatchObject({
		provider: "tavily",
		action: "configure",
		accountId: ACCOUNT,
		expectedRevision: FIRST,
		accountPolicy: { name: "Desk", enabled: false, priority: 5 },
	});
	await page
		.getByRole("button", { name: "Manage Google Custom Search accounts" })
		.click();
	await page
		.getByRole("button", { name: "Replace Google Custom Search Research" })
		.click();
	await page
		.getByLabel("Google Custom Search replacement API key")
		.fill("synthetic-replacement");
	await page
		.getByLabel("Google Custom Search search engine ID")
		.fill("replacement-engine");
	await page
		.getByRole("button", { name: "Replace account", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(2);
	expect(writes[1]).toMatchObject({
		action: "replace",
		provider: "google-pse",
		accountId: "2".repeat(64),
		apiKey: "synthetic-replacement",
		expectedRevision: FIRST,
		context: {
			kind: "google_pse",
			engine_id: "replacement-engine",
			existing_customer_acknowledged: true,
		},
	});
	await expect(
		page.getByLabel("Google Custom Search API key", { exact: true })
	).toHaveValue("");
});

test("Google acknowledgment and engine context can be saved without sending or retyping a secret", async ({
	page,
}) => {
	const writes: unknown[] = [];
	await pageWithView(page, async (route) => {
		writes.push(route.request().postDataJSON());
		await json(route, receipt(FIRST));
	});
	await page
		.getByRole("button", { name: "Manage Google Custom Search accounts" })
		.click();
	await page
		.getByRole("button", { name: "Replace Google Custom Search Archive" })
		.click();
	await expect(
		page.getByLabel("Google Custom Search search engine ID")
	).toHaveValue("engine-two");
	await page
		.getByRole("checkbox", {
			name: "Google Custom Search existing customer confirmation",
		})
		.check();
	await page
		.getByRole("button", { name: "Save account context", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toEqual({
		action: "context",
		provider: "google-pse",
		accountId: "3".repeat(64),
		context: {
			kind: "google_pse",
			engine_id: "engine-two",
			existing_customer_acknowledged: true,
		},
		expectedRevision: FIRST,
	});
	await page
		.getByRole("button", { name: "Replace Google Custom Search Research" })
		.click();
	await page
		.getByLabel("Google Custom Search search engine ID")
		.fill("retargeted-engine");
	await page
		.getByRole("button", { name: "Save account context", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(2);
	expect(writes[1]).toEqual({
		action: "context",
		provider: "google-pse",
		accountId: "2".repeat(64),
		context: {
			kind: "google_pse",
			engine_id: "retargeted-engine",
			existing_customer_acknowledged: true,
		},
		expectedRevision: FIRST,
	});
});

test("saved replacement without application retains its draft across new opaque IDs and applies without re-posting a key", async ({
	page,
}) => {
	let current = view();
	const writes: unknown[] = [];
	let applyCalls = 0;
	await page.route("**/api/gateway/web-accounts", async (route) => {
		if (route.request().method() === "GET") {
			await json(route, current);
			return;
		}
		writes.push(route.request().postDataJSON());
		current = view(SAVED);
		const tavily = current.providers.find((row) => row.provider === "tavily");
		if (tavily) {
			tavily.accounts[0].accountId = "5".repeat(64);
		}
		await json(route, receipt(SAVED, "unmanaged"));
	});
	await page.route("**/api/gateway/providers/apply", async (route) => {
		applyCalls += 1;
		expect(route.request().postDataJSON()).toEqual({ revision: SAVED });
		await json(route, receipt(SAVED));
	});
	await page.goto("/web-service-accounts-proof.html");
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await page.getByRole("button", { name: "Replace Tavily Desk" }).click();
	await page
		.getByLabel("Tavily replacement API key")
		.fill("synthetic-replacement");
	await page
		.getByRole("button", { name: "Replace account", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"Connection saved. Restart your externally managed Gateway to apply it."
	);
	await expect(page.getByLabel("Tavily replacement API key")).toHaveValue(
		"synthetic-replacement"
	);
	await page
		.getByRole("button", { name: "Apply saved accounts", exact: true })
		.click();
	await expect.poll(() => applyCalls).toBe(1);
	expect(writes).toHaveLength(1);
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue(
		""
	);
});

test("revision conflict and mismatched live receipt preserve entered credentials", async ({
	page,
}) => {
	let conflict = true;
	await pageWithView(page, async (route) => {
		if (conflict) {
			await json(
				route,
				{ error: "configuration changed; refresh before retrying" },
				409
			);
		} else {
			const result = receipt(FIRST);
			result.gateway_application.appliedRevision = SAVED;
			await json(route, result);
		}
	});
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await page
		.getByLabel("Tavily API key", { exact: true })
		.fill("synthetic-draft");
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("configuration changed");
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue(
		"synthetic-draft"
	);
	conflict = false;
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"acknowledged a different configuration"
	);
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue(
		"synthetic-draft"
	);
});

test("anonymous Jina has no fake key and keyed transition and disable are explicit atomic actions", async ({
	page,
}) => {
	const writes: unknown[] = [];
	let current = view();
	await page.route("**/api/gateway/web-accounts", async (route) => {
		if (route.request().method() === "GET") {
			await json(route, current);
			return;
		}
		writes.push(route.request().postDataJSON());
		current = view();
		const jina = current.providers.find(
			(row) => row.provider === "jina-reader"
		);
		if (jina) {
			jina.anonymous = false;
			jina.accounts = [
				{
					accountId: "6".repeat(64),
					context: { kind: "default" },
					diagnostic: null,
					policy: { name: "Jina key", enabled: true, priority: 0 },
				},
			];
		}
		await json(route, receipt(FIRST));
	});
	await page.goto("/web-service-accounts-proof.html");
	await page
		.getByRole("button", { name: "Manage Jina Reader accounts" })
		.click();
	await expect(page.getByLabel("Jina Reader API key")).toHaveCount(0);
	await expect(
		page.getByText("No provider key or credential account is used.", {
			exact: false,
		})
	).toBeVisible();
	await page
		.getByRole("button", { name: "Use API-key accounts", exact: true })
		.click();
	await page.getByLabel("Jina Reader API key").fill("synthetic-jina-key");
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toMatchObject({
		action: "add",
		provider: "jina-reader",
		apiKey: "synthetic-jina-key",
		context: { kind: "default" },
		expectedRevision: FIRST,
	});
	await expect(
		page.getByText("No provider key or credential account is used.", {
			exact: false,
		})
	).toHaveCount(0);
	// A separately loaded anonymous configuration exposes an explicit disable.
	current = view();
	await page.reload();
	await page
		.getByRole("button", { name: "Manage Jina Reader accounts" })
		.click();
	await page
		.getByRole("button", { name: "Disable anonymous connection", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(2);
	expect(writes[1]).toEqual({
		action: "clear",
		provider: "jina-reader",
		expectedRevision: FIRST,
	});
});

test("view/configure permissions and node changes clear transient keys and ignore stale save completion", async ({
	page,
}) => {
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await pageWithView(page, async (route) => {
		await held;
		await json(route, receipt(FIRST)).catch(() => undefined);
	});
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await page
		.getByLabel("Tavily API key", { exact: true })
		.fill("synthetic-old-node-draft");
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	await page.getByRole("button", { name: "Switch node", exact: true }).click();
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue(
		""
	);
	release?.();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Viewer role", exact: true }).click();
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByRole("button", { name: "Remove Tavily Desk" })
	).toBeDisabled();
	await page
		.getByRole("button", { name: "No view permission", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: /^Manage .+ accounts$/ })
	).toHaveCount(0);
	await expect(
		page.getByText("Viewing web accounts requires gateway.view permission.")
	).toBeVisible();
});

test("actual GatewayDialog integrates protected web account add with revision and live receipt", async ({
	page,
}, testInfo) => {
	const writes: unknown[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			let body: Parameters<typeof JSON.stringify>[0] = {};
			if (url.pathname === "/api/gateway/config") {
				body = {
					providers: sdkAccountProviders,
					webServiceSchema: 1,
					configRevision: FIRST,
					appliedProviderRevision: FIRST,
					auth: { require_auth: true, api_keys: [] },
				};
			}
			if (url.pathname === "/api/gateway/web-accounts") {
				if (route.request().method() === "GET") {
					body = view();
				} else {
					writes.push(route.request().postDataJSON());
					body = receipt(FIRST);
				}
			}
			await json(route, body);
		}
	);
	await page.goto("/gateway-dialog-accounts-proof.html");
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await page
		.getByLabel("Tavily API key", { exact: true })
		.fill("synthetic-dialog-key");
	await page
		.getByTestId("gateway-web-tavily-credential-form")
		.getByRole("button", { name: "Add account", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toEqual({
		action: "add",
		provider: "tavily",
		apiKey: "synthetic-dialog-key",
		context: { kind: "default" },
		expectedRevision: FIRST,
	});
	await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue(
		""
	);
	await page.screenshot({
		path: testInfo.outputPath("gateway-dialog-web-accounts-product.png"),
	});
});

test("refused account policy retries unchanged, persists full values and Google context, and cold reload reads the accepted revisions", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const persisted = view();
	const initial = structuredClone(persisted);
	const writes: unknown[] = [];
	const reads: string[] = [];
	const unexpected: string[] = [];
	const contextRevision = "c".repeat(64);
	const expectedPolicy = {
		action: "configure",
		provider: "tavily",
		accountId: ACCOUNT,
		expectedRevision: FIRST,
		accountPolicy: { name: "Desk", enabled: false, priority: 5 },
	};
	const expectedContext = {
		action: "context",
		provider: "google-pse",
		accountId: "2".repeat(64),
		expectedRevision: SAVED,
		context: {
			kind: "google_pse",
			engine_id: "persisted-engine",
			existing_customer_acknowledged: true,
		},
	};
	await page.route("**/api/gateway/web-accounts", async (route) => {
		const request = route.request();
		if (new URL(request.url()).pathname !== "/first/api/gateway/web-accounts") {
			unexpected.push(`${request.method()} ${request.url()}`);
			await json(route, { error: "Foreign fixture authority" }, 503);
			return;
		}
		if (request.method() === "GET") {
			reads.push(persisted.configRevision);
			await json(route, structuredClone(persisted));
			return;
		}
		if (request.method() !== "PUT") {
			unexpected.push(request.method());
			await json(route, { error: "Unsupported method" }, 503);
			return;
		}
		const body: unknown = request.postDataJSON();
		writes.push(body);
		if (writes.length <= 2) {
			expect(body).toEqual(expectedPolicy);
			if (writes.length === 1) {
				await json(route, { error: "Fixture policy refused" }, 503);
				return;
			}
			const account = persisted.providers
				.find((p) => p.provider === "tavily")
				?.accounts.find((a) => a.accountId === ACCOUNT);
			if (!account) {
				throw new Error("Missing seeded Tavily account");
			}
			account.policy = { name: "Desk", enabled: false, priority: 5 };
			persisted.configRevision = SAVED;
			await json(route, receipt(SAVED));
			return;
		}
		expect(body).toEqual(expectedContext);
		const account = persisted.providers
			.find((p) => p.provider === "google-pse")
			?.accounts.find((a) => a.accountId === "2".repeat(64));
		if (!account) {
			throw new Error("Missing seeded Google account");
		}
		account.context = {
			kind: "google_pse",
			engine_id: "persisted-engine",
			existing_customer_acknowledged: true,
		};
		persisted.configRevision = contextRevision;
		await json(route, receipt(contextRevision));
	});
	await page.goto("/web-service-accounts-proof.html");
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await page.getByLabel("Tavily Desk priority").fill("5");
	await page.getByRole("switch", { name: "Enable Tavily Desk" }).click();
	const save = page.getByRole("button", { name: "Save account", exact: true });
	await save.click();
	await expect(page.getByRole("alert")).toContainText("Fixture policy refused");
	expect(persisted).toEqual(initial);
	await expect(save).toBeEnabled();
	await expect(page.getByLabel("Tavily Desk priority")).toHaveValue("5");
	await expect(
		page.getByRole("switch", { name: "Enable Tavily Desk" })
	).not.toBeChecked();
	await save.click();
	await expect.poll(() => reads.includes(SAVED)).toBe(true);
	expect(writes).toEqual([expectedPolicy, expectedPolicy]);
	expect(persisted.providers.filter((p) => p.provider !== "tavily")).toEqual(
		initial.providers.filter((p) => p.provider !== "tavily")
	);
	await page.reload();
	await page.getByRole("button", { name: "Manage Tavily accounts" }).click();
	await expect(page.getByLabel("Tavily Desk priority")).toHaveValue("5");
	await expect(
		page.getByRole("switch", { name: "Enable Tavily Desk" })
	).not.toBeChecked();
	expect(writes).toHaveLength(2);
	await page
		.getByRole("button", { name: "Manage Google Custom Search accounts" })
		.click();
	await page
		.getByRole("button", { name: "Replace Google Custom Search Research" })
		.click();
	await page
		.getByLabel("Google Custom Search search engine ID")
		.fill("persisted-engine");
	await page
		.getByRole("button", { name: "Save account context", exact: true })
		.click();
	await expect.poll(() => reads.includes(contextRevision)).toBe(true);
	expect(writes).toEqual([expectedPolicy, expectedPolicy, expectedContext]);
	expect(
		persisted.providers.find((p) => p.provider === "tavily")?.accounts[0]
			?.policy
	).toEqual(expectedPolicy.accountPolicy);
	const readsBeforeReload = reads.length;
	await page.reload();
	await page
		.getByRole("button", { name: "Manage Google Custom Search accounts" })
		.click();
	await expect(
		page.getByText("Engine: persisted-engine", { exact: false })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Replace Google Custom Search Research" })
		.click();
	await expect(
		page.getByLabel("Google Custom Search search engine ID")
	).toHaveValue("persisted-engine");
	await expect(
		page.getByRole("checkbox", {
			name: "Google Custom Search existing customer confirmation",
		})
	).toBeChecked();
	await expect(
		page.getByLabel("Google Custom Search replacement API key")
	).toHaveValue("");
	expect(reads.length).toBeGreaterThan(readsBeforeReload);
	expect(reads.at(-1)).toBe(contextRevision);
	expect(writes).toHaveLength(3);
	expect(unexpected).toEqual([]);
	expect(errors).toEqual([]);
});
