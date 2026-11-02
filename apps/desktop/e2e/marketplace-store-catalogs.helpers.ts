import type { Page, Route } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for marketplace-store-catalogs.spec.ts, kept apart so each file stays under the token limit.

export const STORY_URL = "/marketplace-store-catalogs.html";
export const API_ORIGIN =
	process.env.RYU_STORE_TEST_API_ORIGIN ?? "http://127.0.0.1:5193";
export const EVIDENCE_DIR = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface RequestRecord {
	body?: unknown;
	method: string;
	path: string;
	search: string;
}

export interface CatalogSourceFixture {
	base_url: string | null;
	builtin: boolean;
	display_name: string;
	has_auth: boolean;
	id: string;
}

export interface CatalogSourcesFixture {
	active: string;
	sources: CatalogSourceFixture[];
}

export interface Fixture {
	calls: RequestRecord[];
	catalogSources: Record<string, CatalogSourcesFixture>;
	integrationFailures: number;
	sourceListFailures: number;
}

export function integration(id: string, name: string, description: string) {
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

export const initialIntegrations = [
	integration("notion", "Notion", "Notion notes and databases."),
	integration("slack", "Slack", "Slack messages and team channels."),
];

export async function json<FixturePayload>(
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

export async function installFixture(page: Page): Promise<Fixture> {
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

export async function accountState(page: Page) {
	return page
		.getByTestId("account-fixture-state")
		.evaluate((node) => JSON.parse(node.textContent ?? "{}"));
}
