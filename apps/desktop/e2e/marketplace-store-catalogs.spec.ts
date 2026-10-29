import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";

const STORY_URL = "/marketplace-store-catalogs.html";
const API_ORIGIN =
	process.env.RYU_STORE_TEST_API_ORIGIN ?? "http://127.0.0.1:5193";
const EVIDENCE_DIR = resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface RequestRecord {
	body?: unknown;
	method: string;
	path: string;
	search: string;
}

interface CatalogSourceFixture {
	base_url: string | null;
	builtin: boolean;
	display_name: string;
	has_auth: boolean;
	id: string;
}

interface CatalogSourcesFixture {
	active: string;
	sources: CatalogSourceFixture[];
}

interface Fixture {
	calls: RequestRecord[];
	catalogSources: Record<string, CatalogSourcesFixture>;
	integrationFailures: number;
	sourceListFailures: number;
}

function integration(id: string, name: string, description: string) {
	return {
		categories: ["Productivity", "Communication"],
		connections: [
			{
				id: `mcp:${id}`,
				kind: "mcp",
				name: `${name} MCP server`,
				url: `https://${id}.example.test/mcp`,
			},
		],
		description,
		domain: `${id}.example.test`,
		feeds: ["mcp"],
		id,
		logo: null,
		name,
		options: [
			{
				action: "connect",
				available: true,
				availability_note: null,
				capability: "account access",
				comparison_key: null,
				connection_id: null,
				description: "Authorize the managed account connection.",
				id: `${id}-connect`,
				is_cheapest: false,
				kind: "composio-toolkit",
				name: `${name} account`,
				price: null,
				provider: "Composio",
				source: "composio",
				url: null,
			},
			{
				action: "mcp",
				available: true,
				availability_note: null,
				capability: "search and retrieve",
				comparison_key: null,
				connection_id: `mcp:${id}`,
				description: "Find a server in the MCP catalog.",
				id: `${id}-mcp`,
				is_cheapest: true,
				kind: "mcp",
				name: `${name} MCP server`,
				price: {
					confidence: "listed",
					currency: "usd",
					per: null,
					unit: null,
					usd: 0,
					value: 0,
				},
				provider: null,
				source: "directory",
				url: `https://${id}.example.test/mcp`,
			},
			{
				action: "chat-setup",
				available: true,
				availability_note: null,
				capability: "guided setup",
				comparison_key: null,
				connection_id: null,
				description: "Ask Ryu to help configure this integration.",
				id: `${id}-setup`,
				is_cheapest: false,
				kind: "treg-platform",
				name: `${name} setup`,
				price: null,
				provider: "Ryu",
				source: "treg",
				url: `https://${id}.example.test/docs`,
			},
		],
		popularity: 80,
		sources: ["directory", "composio", "treg"],
	};
}

const initialIntegrations = [
	integration("notion", "Notion", "Notion notes and databases."),
	integration("slack", "Slack", "Slack messages and team channels."),
];

async function json<FixturePayload>(
	route: Route,
	value: FixturePayload,
	status = 200
) {
	await route.fulfill({
		body: JSON.stringify(value),
		contentType: "application/json",
		status,
	});
}

async function installFixture(page: Page): Promise<Fixture> {
	const kinds = ["agent", "knowledge", "mcp", "model", "plugin", "skill"];
	const catalogSources = Object.fromEntries(
		kinds.map((kind) => [
			kind,
			{
				active: `${kind}-default`,
				sources: [
					{
						base_url: null,
						builtin: true,
						display_name: `Ryu-hosted ${kind}`,
						has_auth: false,
						id: `${kind}-default`,
					},
					...(kind === "plugin"
						? [
								{
									base_url: "https://github.com/fixture/community-plugins",
									builtin: false,
									display_name: "Community fixture source",
									has_auth: false,
									id: "community-plugin-source",
								},
							]
						: []),
				],
			},
		])
	);
	const fixture: Fixture = {
		calls: [],
		catalogSources,
		integrationFailures: 1,
		sourceListFailures: 0,
	};
	await page.route(`${API_ORIGIN}/api/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		let body: unknown;
		try {
			body = request.postDataJSON();
		} catch {
			body = undefined;
		}
		fixture.calls.push({
			...(body === undefined ? undefined : { body }),
			method,
			path: url.pathname,
			search: url.search,
		});

		if (url.pathname === "/api/catalog/sources") {
			if (method === "GET") {
				const kind = url.searchParams.get("kind") ?? "";
				if (kind === "plugin" && fixture.sourceListFailures > 0) {
					fixture.sourceListFailures -= 1;
					await json(
						route,
						{ error: "Fixture source registry unavailable" },
						503
					);
					return;
				}
				const sources = fixture.catalogSources[kind];
				await json(route, {
					active: sources?.active ?? "",
					kind,
					sources: sources?.sources ?? [],
				});
				return;
			}
			if (method === "POST") {
				// SAFETY: The mounted AddMarketplaceDialog trims its native string inputs; MarketplacesCatalogSection passes those values and an authored catalog kind to addCatalogSource, which JSON-serializes exactly these fields and optional string bearer into this controlled POST.
				const input = body as {
					auth?: { bearer?: string };
					base_url: string;
					display_name: string;
					id: string;
					kind: string;
				};
				fixture.catalogSources[input.kind]?.sources.push({
					base_url: input.base_url,
					builtin: false,
					display_name: input.display_name,
					has_auth: Boolean(input.auth?.bearer),
					id: input.id,
				});
				await json(route, { ok: true });
				return;
			}
			if (method === "DELETE") {
				// SAFETY: The mounted source-row remove button passes its fixture-authored string source ID and finite group kind to removeCatalogSource, whose JSON body is exactly { id, kind } for this controlled DELETE.
				const input = body as { id: string; kind: string };
				const entry = fixture.catalogSources[input.kind];
				if (entry) {
					entry.sources = entry.sources.filter(
						(source) => source.id !== input.id
					);
					if (entry.active === input.id) {
						entry.active = entry.sources[0]?.id ?? "";
					}
				}
				await json(route, { ok: true });
				return;
			}
		}
		if (url.pathname === "/api/catalog/sources/select" && method === "POST") {
			// SAFETY: The mounted source-row selection button passes its fixture-authored string source ID and finite group kind to selectCatalogSource, whose JSON body is exactly { id, kind } for this controlled POST.
			const input = body as { id: string; kind: string };
			const entry = fixture.catalogSources[input.kind];
			if (entry?.sources.some((source) => source.id === input.id)) {
				entry.active = input.id;
			}
			await json(route, { ok: true });
			return;
		}
		if (url.pathname === "/api/catalog/sources/reorder" && method === "POST") {
			// SAFETY: The mounted source-row arrows publish literal up/down with the fixture-authored string source ID and finite group kind; reorderCatalogSource JSON-serializes those three fields into this controlled POST.
			const input = body as {
				direction: "down" | "up";
				id: string;
				kind: string;
			};
			const sources = fixture.catalogSources[input.kind]?.sources;
			const index =
				sources?.findIndex((source) => source.id === input.id) ?? -1;
			const nextIndex = index + (input.direction === "up" ? -1 : 1);
			if (
				sources &&
				index >= 0 &&
				nextIndex >= 0 &&
				nextIndex < sources.length
			) {
				const [source] = sources.splice(index, 1);
				if (source) {
					sources.splice(nextIndex, 0, source);
				}
			}
			await json(route, { ok: true });
			return;
		}

		if (url.pathname === "/api/integrations" && method === "GET") {
			if (fixture.integrationFailures > 0) {
				fixture.integrationFailures -= 1;
				await json(
					route,
					{ error: "Fixture integration directory is unavailable" },
					503
				);
				return;
			}
			const query = url.searchParams.get("q")?.toLowerCase() ?? "";
			const rows = initialIntegrations.filter((item) =>
				item.name.toLowerCase().includes(query)
			);
			await json(route, {
				integrations: rows,
				next_cursor: null,
				total: rows.length,
			});
			return;
		}
		if (url.pathname.startsWith("/api/integrations/") && method === "GET") {
			const id = url.pathname.slice("/api/integrations/".length);
			const item = initialIntegrations.find((candidate) => candidate.id === id);
			if (item) {
				await json(route, {
					...item,
					description: `${item.name} detail read back from the fixture directory.`,
				});
				return;
			}
			await json(route, { error: "Unknown integration" }, 404);
			return;
		}
		if (url.pathname === "/api/composio/status") {
			await json(route, {
				base_url: "https://composio.example.test",
				configured: true,
			});
			return;
		}
		if (url.pathname === "/api/composio/toolkits") {
			await json(route, {
				data: [
					{
						description: "Fixture Slack toolkit",
						logo: null,
						name: "Slack",
						slug: "slack",
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/composio/connections") {
			await json(route, {
				data: [
					{
						access_level: "read_only",
						active: true,
						id: "connection-fixture",
						status: "ACTIVE",
						toolkit: "slack",
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/composio/actions") {
			await json(route, {
				data: [
					{
						description: "Send a fixture message to a channel.",
						display_name: "Send message",
						input_schema: {
							properties: { channel: { type: "string" } },
							type: "object",
						},
						name: "SLACK_SEND_MESSAGE",
						no_auth: false,
						tags: ["write"],
						toolkit: "slack",
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/composio/triggers") {
			await json(route, {
				data: [
					{
						description: "A new channel message arrives.",
						display_name: "New message event",
						name: "SLACK_NEW_MESSAGE",
						toolkit: "slack",
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/plugins") {
			await json(route, { apps: [] });
			return;
		}
		if (url.pathname === "/api/identities") {
			await json(route, { profiles: [] });
			return;
		}
		if (url.pathname === "/api/models/catalog") {
			await json(route, { models: [], next_cursor: null, total: 0 });
			return;
		}
		if (url.pathname === "/api/skills/catalog") {
			await json(route, { skills: [], next_cursor: null, total: 0 });
			return;
		}
		if (url.pathname === "/api/mcp/catalog") {
			await json(route, { servers: [], next_cursor: null, total: 0 });
			return;
		}
		if (url.pathname === "/api/plugins/catalog") {
			await json(route, { entries: [] });
			return;
		}
		if (url.pathname === "/api/agents/catalog") {
			await json(route, { agents: [] });
			return;
		}
		await json(route, {});
	});
	return fixture;
}

async function accountState(page: Page) {
	return page
		.getByTestId("account-fixture-state")
		.evaluate((node) => JSON.parse(node.textContent ?? "{}"));
}

test.describe.configure({ timeout: 60_000 });

test("Integrations retries its list read, searches the returned page, and hands an exact brand query to MCP", async ({
	page,
}, _testInfo) => {
	const fixture = await installFixture(page);
	await page.goto(`${STORY_URL}?section=integrations`);
	const integrationsTab = page.getByRole("tab", { name: "Integrations" });
	await expect(integrationsTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Couldn't load integrations", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("button", { name: /Notion/ })).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls
				.filter(
					(call) => call.path === "/api/integrations" && call.method === "GET"
				)
				.map((call) => call.search)
		)
		.toEqual(["?limit=60", "?limit=60"]);

	const search = page.getByPlaceholder(
		"Search integrations (Notion, Slack, GitHub…)"
	);
	await search.fill("Slack");
	const slackCard = page.getByRole("button", { name: /Slack/ });
	await expect(slackCard).toBeVisible();
	await expect(page.getByRole("button", { name: /Notion/ })).toHaveCount(0);
	await slackCard.click();
	const detailHeading = page.getByRole("heading", { name: "Slack" }).last();
	await expect(detailHeading).toBeVisible();
	await expect(
		page.getByText("Slack detail read back from the fixture directory.", {
			exact: true,
		})
	).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.method === "GET" && call.path === "/api/integrations/slack"
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/integrations" &&
					call.search === "?q=Slack&limit=60"
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			fixture.calls.some((call) => call.path === "/api/agents/catalog")
		)
		.toBe(true);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-integrations-detail.png"),
	});

	await page.getByRole("button", { name: "Find in MCP catalog" }).click();
	const mcpTab = page.getByRole("tab", { name: "MCP" });
	await expect(mcpTab).toHaveAttribute("aria-selected", "true");
	await expect(page.getByPlaceholder("Search MCP servers…")).toHaveValue(
		"Slack"
	);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/mcp/catalog" &&
					new URLSearchParams(call.search).get("query") === "Slack"
			)
		)
		.toBe(true);
});

test("Connections searches a configured toolkit catalog and reads back its tools and triggers", async ({
	page,
}, _testInfo) => {
	const fixture = await installFixture(page);
	await page.goto(`${STORY_URL}?section=connections`);
	await expect(page.getByRole("tab", { name: "Connections" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		page.getByText("Managed integrations", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Connected", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Access: Read only", { exact: true })
	).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/composio/connections" && call.method === "GET"
			)
		)
		.toBe(true);

	const search = page.getByPlaceholder(
		"Search integrations (Gmail, Slack, GitHub…)"
	);
	await search.fill("not-a-fixture-toolkit");
	await expect(page.getByText(/No integrations match/)).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(page.getByText("Slack", { exact: true }).first()).toBeVisible();
	await page.getByRole("button", { name: "View tools" }).click();
	await expect(page.getByText("Send message", { exact: true })).toBeVisible();
	await expect(
		page.getByText("New message event", { exact: true })
	).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/composio/actions" &&
					new URLSearchParams(call.search).get("toolkit") === "slack"
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/composio/triggers" &&
					new URLSearchParams(call.search).get("toolkit") === "slack"
			)
		)
		.toBe(true);
	await page.getByRole("button", { name: "Hide tools" }).click();
	await expect(page.getByText("Send message", { exact: true })).toHaveCount(0);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-connections-catalog.png"),
	});
});

test("My licenses refresh reads back the owned item and shows its purchase facts", async ({
	page,
}, _testInfo) => {
	await page.goto(`${STORY_URL}?section=licenses`);
	await expect(page.getByRole("tab", { name: "My licenses" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		page.getByText("No purchases yet", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(
		page.getByText("Paid Fixture Skill", { exact: true })
	).toBeVisible();
	await expect(page.getByText("$12.00", { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await accountState(page)).licenseRefreshes)
		.toBe(1);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-license-readback.png"),
	});
});

test("Sell retries hosted onboarding, refreshes payout state, and resolves seller reports", async ({
	page,
}, _testInfo) => {
	await page.goto(`${STORY_URL}?section=sell`);
	await expect(page.getByRole("tab", { name: "Sell" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(page.getByText("In progress", { exact: true })).toBeVisible();
	const refreshButtons = page.getByRole("button", { name: "Refresh" });
	await expect(refreshButtons).toHaveCount(2);
	await refreshButtons.first().click();
	await expect(page.getByText("Active", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Payouts enabled", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Manage seller account" })
	).toBeVisible();
	await expect(
		page.getByText("Identity verified via Stripe Connect", { exact: true })
	).toBeVisible();
	await expect
		.poll(async () => (await accountState(page)).sellerRefreshes)
		.toBe(1);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-seller-status.png"),
	});

	const setup = page.getByRole("button", { name: "Manage seller account" });
	await setup.click();
	await expect(
		page.getByText("Fixture seller onboarding temporarily unavailable", {
			exact: true,
		})
	).toBeVisible();
	await setup.click();
	await expect
		.poll(async () => (await accountState(page)).externalUrls)
		.toEqual(["https://checkout.example.test/connect/acct-fixture"]);
	await expect
		.poll(async () => (await accountState(page)).onboardAttempts)
		.toBe(2);

	await expect(
		page.getByText("Reports on your listings", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Install fails after retrying the local fixture.", {
			exact: true,
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Resolve", exact: true }).click();
	await expect(
		page.getByText("No open reports.", { exact: true })
	).toBeVisible();
	await expect
		.poll(async () => (await accountState(page)).reportActions)
		.toEqual([{ id: "report-fixture", status: "resolved" }]);
});

test("Marketplaces retries source reads and reads back selection, order, add, and removal", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	fixture.sourceListFailures = 1;
	await page.goto(`${STORY_URL}?section=marketplaces`);
	await expect(
		page.getByRole("heading", { name: "Could not load marketplaces" })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	const marketplacesTab = page.getByRole("tab", { name: "Marketplaces" });
	await expect(marketplacesTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Community fixture source", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Ryu-hosted plugin", { exact: true })
	).toBeVisible();
	const pluginSources = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Apps and plugins" }) });
	const communitySource = pluginSources
		.getByText("Community fixture source", { exact: true })
		.locator("xpath=../../..");
	await communitySource.getByRole("button", { name: "Use source" }).click();
	await expect(
		communitySource.getByRole("button", { name: "Selected" })
	).toBeDisabled();
	expect(fixture.catalogSources.plugin?.active).toBe("community-plugin-source");
	expect(
		fixture.calls
			.filter(
				(call) =>
					call.path === "/api/catalog/sources/select" && call.method === "POST"
			)
			.map((call) => call.body)
	).toEqual([{ id: "community-plugin-source", kind: "plugin" }]);

	await pluginSources
		.getByRole("button", { name: "Move Community fixture source up" })
		.click();
	expect(fixture.catalogSources.plugin?.sources[0]?.id).toBe(
		"community-plugin-source"
	);
	await expect(
		pluginSources.getByRole("button", {
			name: "Move Community fixture source up",
		})
	).toBeDisabled();
	await pluginSources
		.getByRole("button", { name: "Move Community fixture source down" })
		.click();
	expect(fixture.catalogSources.plugin?.sources[1]?.id).toBe(
		"community-plugin-source"
	);
	expect(
		fixture.calls
			.filter(
				(call) =>
					call.path === "/api/catalog/sources/reorder" && call.method === "POST"
			)
			.map((call) => call.body)
	).toEqual([
		{ direction: "up", id: "community-plugin-source", kind: "plugin" },
		{ direction: "down", id: "community-plugin-source", kind: "plugin" },
	]);

	await page.getByRole("button", { name: "Add marketplace" }).click();
	const dialog = page.getByRole("dialog", { name: "Add a marketplace" });
	await dialog.getByRole("button", { name: "Add marketplace" }).click();
	await expect(dialog).toContainText(
		"Name, id, and repository or URL are required."
	);
	await dialog
		.getByRole("textbox", { name: "Name" })
		.fill("Private fixture marketplace");
	await dialog
		.getByRole("textbox", { name: "Id" })
		.fill("fixture/private-catalog");
	await dialog
		.getByRole("textbox", { name: "Repository or manifest URL" })
		.fill("https://github.com/fixture/private-catalog");
	await dialog.getByRole("button", { name: "Apps and plugins" }).click();
	await dialog.getByRole("button", { name: "Skills" }).click();
	await dialog.getByRole("button", { name: "Add marketplace" }).click();
	await expect(dialog).toContainText("Choose at least one catalog section.");
	await dialog.getByRole("button", { name: "Apps and plugins" }).click();
	await dialog.getByRole("button", { name: "Skills" }).click();
	await dialog
		.getByRole("textbox", { name: "Auth environment variable (optional)" })
		.fill("GITHUB_TOKEN");
	const authReference = `${String.fromCharCode(36)}{GITHUB_TOKEN}`;
	await dialog.getByRole("button", { name: "Add marketplace" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("Private fixture marketplace", { exact: true })
	).toHaveCount(2);
	await expect(page.getByText("Auth configured", { exact: true })).toHaveCount(
		2
	);
	const addRequests = fixture.calls.filter(
		(call) => call.path === "/api/catalog/sources" && call.method === "POST"
	);
	expect(addRequests.map((call) => call.body)).toEqual([
		{
			auth: { bearer: authReference },
			base_url: "https://github.com/fixture/private-catalog",
			display_name: "Private fixture marketplace",
			id: "fixture/private-catalog",
			kind: "plugin",
		},
		{
			auth: { bearer: authReference },
			base_url: "https://github.com/fixture/private-catalog",
			display_name: "Private fixture marketplace",
			id: "fixture/private-catalog",
			kind: "skill",
		},
	]);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-sources-auth-reference-readback.png"
		),
	});

	await pluginSources
		.getByRole("button", { name: "Remove Private fixture marketplace" })
		.click();
	await expect(
		pluginSources.getByText("Private fixture marketplace", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByText("Private fixture marketplace", { exact: true })
	).toHaveCount(1);
	expect(
		fixture.calls
			.filter(
				(call) =>
					call.path === "/api/catalog/sources" && call.method === "DELETE"
			)
			.map((call) => call.body)
	).toEqual([{ id: "fixture/private-catalog", kind: "plugin" }]);
});
