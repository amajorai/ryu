import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import type { z } from "zod";
import type { marketplaceDetailWireSchema } from "../src/lib/api/marketplace-response-contracts.ts";

declare global {
	interface Window {
		__marketplaceStoreTabFixture?: { enabled: boolean; value: string };
	}
}

export const STORY_URL = "/marketplace-store-interactions.html";
export const AUTH_TOKEN_KEY = "ryu_session_token";
export const EVIDENCE_DIR = resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

export interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
	search: string;
}

export interface AgentEntry {
	added: boolean;
	available: boolean;
	description: string;
	detected: boolean | null;
	id: string;
	name: string;
	recommended?: boolean;
}

export interface Fixture {
	agentCatalogFailures: number;
	agentInstallFailures: number;
	agents: AgentEntry[];
	calls: RequestRecord[];
	communityAgentInstallFailures: number;
	communityAgentInstallGate: Promise<void> | null;
	composioConnectionActive: boolean;
	includeConnectionRequirement: boolean;
	likes: Record<string, { count: number; liked: boolean }>;
	marketplaceDetails: Record<
		string,
		z.output<typeof marketplaceDetailWireSchema>
	>;
	marketplaceItems: Record<string, ReturnType<typeof card>[]>;
	publishedAgents: string[];
	releaseCommunityAgentInstall?: () => void;
	workflows: string[];
}

export const initialAgents: AgentEntry[] = [
	{
		added: true,
		available: true,
		detected: null,
		description: "The built-in Ryu agent.",
		id: "ryu",
		name: "Ryu",
		recommended: true,
	},
	{
		added: false,
		available: true,
		detected: false,
		description: "Run Codex through ACP.",
		id: "acp:codex",
		name: "Codex",
	},
	{
		added: false,
		available: false,
		detected: null,
		description: "This fixture agent needs a manual install.",
		id: "acp:manual",
		name: "Manual Runtime",
	},
];

export function card(
	id: string,
	kind: string,
	name: string,
	options: { paid?: boolean; memberCount?: number } = {}
) {
	return {
		author: "Local Fixture Publisher",
		bundleMemberCount: options.memberCount ?? 0,
		category: "Productivity",
		communityStats: { downloads: 14, instances: 3, runs: 22 },
		description: `${name} fixture description`,
		firstParty: false,
		// The control plane serializes these card fields on every listing, and
		// Desktop's catalog contract rejects a listing without them.
		iconUrl: null,
		id,
		installSource: null,
		kind,
		likeCount: 2,
		likedByMe: false,
		membershipIncluded: false,
		name,
		orgVerified: false,
		pricing: options.paid
			? {
					amountMinor: 1200,
					currency: "usd",
					interval: "month",
					maxUpdates: null,
					model: "one_time",
					platformFeeBps: 1000,
					sellerOrgId: "org-fixture",
				}
			: null,
		// An unverified publisher resolves to the dotted community mark.
		publisherTrust: "dotted",
		publisherTrustSource: "none",
		requirements: {},
		ratingAverage: 4.5,
		ratingCount: 4,
		scopes: [],
		targets: [],
		updateAvailable: false,
		version: "1.0.0",
	};
}

export function makeFixture(
	options: {
		includeConnectionRequirement?: boolean;
		pluginSettingsAgent?: boolean;
	} = {}
): Fixture {
	const bundleId = "fixture/agent-setup-bundle";
	const agentTemplateId = "fixture/research-agent";
	const workflowId = "fixture/weekly-review";
	const fixture: Fixture = {
		agents: structuredClone(initialAgents),
		calls: [],
		communityAgentInstallFailures: 2,
		communityAgentInstallGate: null,
		agentCatalogFailures: 0,
		agentInstallFailures: 1,
		likes: { [bundleId]: { count: 2, liked: false } },
		marketplaceItems: {
			agent: [card(agentTemplateId, "agent", "Research Agent", { paid: true })],
			bundle: [
				card(bundleId, "bundle", "Agent Setup Bundle", {
					memberCount: 2,
				}),
			],
			theme: [card("fixture/minimal-theme", "theme", "Fixture Minimal Theme")],
			workflow: [
				card(workflowId, "workflow", "Weekly Review Workflow", { paid: true }),
			],
		},
		marketplaceDetails: {
			[`bundle:${bundleId}`]: {
				bundleMembers: [
					{
						id: agentTemplateId,
						kind: "agent",
						name: "Research Agent",
						required: true,
					},
					{
						id: "fixture/weekly-review",
						kind: "workflow",
						name: "Weekly Review Workflow",
						required: false,
					},
				],
				bundleSourceUrl: "https://example.test/topic/source",
				capabilities: [],
				communityStats: { downloads: 14, instances: 3, runs: 22 },
				description: "Install the safe agent setup in one reviewable action.",
				examplePrompts: [],
				id: bundleId,
				kind: "bundle",
				name: "Agent Setup Bundle",
				runnables: [],
				screenshots: [],
				setup: [],
				version: "1.0.0",
			},
			[`agent:${agentTemplateId}`]: {
				capabilities: ["filesystem.read"],
				communityStats: { downloads: 8, instances: 2, runs: 6 },
				description: "An unprivileged research assistant template.",
				examplePrompts: ["Summarize this local fixture."],
				id: agentTemplateId,
				kind: "agent",
				name: "Research Agent",
				runnables: [],
				screenshots: [],
				setup: [],
				version: "1.0.0",
			},
			[`workflow:${workflowId}`]: {
				capabilities: ["workflow.execute"],
				communityStats: { downloads: 5, instances: 2, runs: 10 },
				description:
					"A local-only workflow listing for checkout handoff proof.",
				examplePrompts: [],
				id: workflowId,
				kind: "workflow",
				name: "Weekly Review Workflow",
				runnables: [],
				screenshots: [],
				setup: [],
				version: "1.0.0",
			},
		},
		publishedAgents: [],
		includeConnectionRequirement: options.includeConnectionRequirement ?? false,
		composioConnectionActive: false,
		workflows: [],
	};
	if (options.pluginSettingsAgent) {
		fixture.agents.push({
			added: true,
			available: true,
			detected: null,
			description: "An installed plugin-backed voice agent.",
			id: "pocket-tts",
			name: "Pocket TTS",
		});
	}
	return fixture;
}

export async function bodyOf(route: Route) {
	try {
		return route.request().postDataJSON();
	} catch {
		return undefined;
	}
}

export async function json<FixturePayload>(
	route: Route,
	status: number,
	value: FixturePayload
) {
	await route.fulfill({
		body: JSON.stringify(value),
		contentType: "application/json",
		status,
	});
}

export async function installLocalFixture(
	page: Page,
	options: {
		includeConnectionRequirement?: boolean;
		pluginSettingsAgent?: boolean;
	} = {}
): Promise<Fixture> {
	const fixture = makeFixture(options);
	await page.addInitScript((key) => {
		localStorage.setItem(key, "fixture-session");
	}, AUTH_TOKEN_KEY);
	await page.route("http://127.0.0.1:5189/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const body = await bodyOf(route);
		fixture.calls.push({
			body,
			method,
			path: url.pathname,
			search: url.search,
		});

		if (url.pathname === "/api/agents/catalog" && method === "GET") {
			if (fixture.agentCatalogFailures > 0) {
				fixture.agentCatalogFailures -= 1;
				await json(route, 503, {
					error: "Agent catalog temporarily unavailable",
				});
				return;
			}
			await json(route, 200, {
				agents: fixture.agents.map((entry) => ({
					added: entry.added,
					available: entry.available,
					detected: entry.detected,
					description: entry.description,
					id: entry.id,
					name: entry.name,
					recommended: entry.recommended ?? false,
				})),
			});
			return;
		}
		if (url.pathname === "/api/agents/catalog/install" && method === "POST") {
			// SAFETY: The mounted runtime install action calls installAgent with the fixture catalog string ID; its request serializes { id } into this controlled POST.
			const id = (body as { id?: string } | undefined)?.id;
			if (fixture.agentInstallFailures > 0) {
				fixture.agentInstallFailures -= 1;
				await json(route, 503, {
					error: "Codex runtime install is temporarily unavailable",
				});
				return;
			}
			const entry = fixture.agents.find((candidate) => candidate.id === id);
			if (entry) {
				entry.added = true;
			}
			await json(route, 200, { success: true });
			return;
		}
		if (url.pathname === "/api/agents/catalog/uninstall" && method === "POST") {
			// SAFETY: The mounted runtime remove action calls uninstallAgent with the fixture catalog string ID; its request serializes { id } into this controlled POST.
			const id = (body as { id?: string } | undefined)?.id;
			const entry = fixture.agents.find((candidate) => candidate.id === id);
			if (entry) {
				entry.added = false;
			}
			await json(route, 200, { success: true });
			return;
		}
		if (url.pathname === "/api/agents/published/install" && method === "POST") {
			// SAFETY: The mounted published-template and bundle actions call installPublishedAgent with fixture string IDs; its request serializes { id, idempotency_key } into this controlled POST.
			const id = (body as { id: string }).id;
			if (fixture.communityAgentInstallFailures > 0) {
				const gate = fixture.communityAgentInstallGate;
				fixture.communityAgentInstallGate = null;
				if (gate) {
					await gate;
				}
				fixture.communityAgentInstallFailures -= 1;
				await json(route, 503, {
					error: "Template install is temporarily unavailable",
				});
				return;
			}
			if (fixture.publishedAgents.includes(id)) {
				await json(route, 409, { error: "Agent is already installed" });
				return;
			}
			if (!fixture.publishedAgents.includes(id)) {
				fixture.publishedAgents.push(id);
			}
			await json(route, 200, {
				agent: {
					id: "created-research-agent",
					name: "Research Agent",
					description: "Created from a fixture template.",
					system_prompt: "Research safely.",
					tools: ["filesystem.read"],
					version: "1.0.0",
				},
				requires: {
					required_plugins: ["com.ryu.web-search"],
					composio_actions: ["GMAIL_LIST_MESSAGES"],
					identity_profile_ids: ["profile-fixture"],
					memory_read_levels: ["project"],
					memory_write_enabled: true,
					policy_id: "publisher-policy",
					space_ids: ["publisher-space-a", "publisher-space-b"],
					tools: ["filesystem.read"],
				},
			});
			return;
		}
		if (
			url.pathname === "/api/workflows/catalog/install" &&
			method === "POST"
		) {
			// SAFETY: The mounted workflow-template and bundle actions call installWorkflowTemplate with fixture string IDs; postJson serializes { template_id } into this controlled POST.
			const templateId = (body as { template_id: string }).template_id;
			if (fixture.workflows.includes(templateId)) {
				await json(route, 409, { error: "Workflow is already installed" });
				return;
			}
			fixture.workflows.push(templateId);
			await json(route, 200, { workflow_id: "installed-weekly-review" });
			return;
		}
		if (url.pathname === "/api/marketplace/usage" && method === "POST") {
			await json(route, 200, { ok: true });
			return;
		}
		if (url.pathname === "/api/marketplace/catalog" && method === "GET") {
			const kind = url.searchParams.get("kind") ?? "";
			await json(route, 200, {
				items: fixture.marketplaceItems[kind] ?? [],
			});
			return;
		}
		if (
			url.pathname === "/api/fixture/marketplace-store/catalog" &&
			method === "GET"
		) {
			await json(route, 200, {
				items: [
					{
						description:
							"A row supplied by an enabled local Store-tab contribution.",
						id: "fixture-catalog-row",
						name: "Fixture catalog listing",
						tags: ["local", "contributed"],
					},
				],
				total: 1,
			});
			return;
		}
		if (
			url.pathname === "/api/marketplace/catalog/detail" &&
			method === "GET"
		) {
			const key = `${url.searchParams.get("kind")}:${url.searchParams.get("id")}`;
			await json(
				route,
				200,
				fixture.marketplaceDetails[key] ?? {
					id: key,
					kind: "unknown",
					name: key,
				}
			);
			return;
		}
		if (url.pathname === "/api/marketplace/purchase" && method === "POST") {
			await json(route, 200, {
				alreadyLicensed: false,
				license: null,
				sessionId: "checkout-fixture-session",
				url: "https://checkout.example.test/session/fixture",
			});
			return;
		}
		if (
			url.pathname === "/api/marketplace/share-codes/preview" &&
			method === "POST"
		) {
			await json(route, 200, {
				preview: {
					audience: "organization",
					capabilities: ["mcp:fixture.search"],
					connections: fixture.includeConnectionRequirement
						? [
								{
									consumers: ["mcp:fixture.search"],
									displayName: "Fixture Slack account",
									id: "fixture-slack-account",
									provider: "Composio",
									purpose: "Search and send fixture Slack messages.",
									required: true,
									toolkit: "slack",
								},
							]
						: [],
					description: "A private plugin release fixture.",
					id: "fixture/private-search",
					kind: "plugin",
					name: "Private Search Plugin",
					verification: "verified",
					version: "2.1.0",
				},
			});
			return;
		}
		if (url.pathname === "/api/composio/status" && method === "GET") {
			await json(route, 200, {
				base_url: "https://composio.example.test",
				configured: true,
			});
			return;
		}
		if (url.pathname === "/api/composio/connections" && method === "GET") {
			await json(route, 200, {
				data: fixture.composioConnectionActive
					? [
							{
								access_level: "write",
								active: true,
								id: "fixture-private-connection",
								status: "ACTIVE",
								toolkit: "slack",
							},
						]
					: [],
			});
			return;
		}
		if (
			url.pathname === "/api/composio/connections/initiate" &&
			method === "POST"
		) {
			fixture.composioConnectionActive = true;
			// SAFETY: The mounted Composio connection action uses initiateComposioConnection, which serializes its authored access-level string and toolkit into this controlled POST.
			await json(route, 200, {
				access_level: (body as { access_level?: string } | undefined)
					?.access_level,
				connection_id: "fixture-private-connection",
				redirect_url: "https://composio.example.test/oauth/fixture",
				status: "INITIATED",
			});
			return;
		}
		if (
			url.pathname === "/api/composio/connections/fixture-private-connection" &&
			method === "GET"
		) {
			await json(route, 200, {
				access_level: "write",
				active: fixture.composioConnectionActive,
				id: "fixture-private-connection",
				status: fixture.composioConnectionActive ? "ACTIVE" : "INITIATED",
				toolkit: "slack",
			});
			return;
		}
		if (url.pathname === "/api/marketplace/likes/batch" && method === "POST") {
			// SAFETY: The aliased marketplace test host JSON-serializes the real likes-store string namespace batch as { namespaces } into this controlled POST.
			const namespaces =
				(body as { namespaces?: string[] } | undefined)?.namespaces ?? [];
			await json(route, 200, {
				items: namespaces.map((namespace) => ({
					namespace,
					count: fixture.likes[namespace]?.count ?? 0,
					liked: fixture.likes[namespace]?.liked ?? false,
				})),
			});
			return;
		}
		if (url.pathname === "/api/marketplace/likes" && method === "POST") {
			// SAFETY: The aliased marketplace test host like action JSON-serializes its mounted listing string namespace as { namespace } into this controlled POST.
			const namespace = (body as { namespace: string }).namespace;
			const current = fixture.likes[namespace] ?? { count: 0, liked: false };
			const next = {
				count: current.count + (current.liked ? 0 : 1),
				liked: true,
			};
			fixture.likes[namespace] = next;
			await json(route, 200, { namespace, ...next });
			return;
		}
		if (url.pathname === "/api/marketplace/likes" && method === "DELETE") {
			// SAFETY: The aliased marketplace test host unlike action JSON-serializes its mounted listing string namespace as { namespace } into this controlled DELETE.
			const namespace = (body as { namespace: string }).namespace;
			const current = fixture.likes[namespace] ?? { count: 0, liked: false };
			const next = {
				count: Math.max(0, current.count - (current.liked ? 1 : 0)),
				liked: false,
			};
			fixture.likes[namespace] = next;
			await json(route, 200, { namespace, ...next });
			return;
		}

		// The Store shell loads these only for the global search and Home shelves.
		// Empty, typed responses keep the test deterministic without inventing a hit.
		if (url.pathname.endsWith("/models/catalog")) {
			await json(route, 200, { models: [], total: 0 });
			return;
		}
		if (
			url.pathname.endsWith("/skills/catalog/search") ||
			url.pathname.endsWith("/skills/catalog")
		) {
			await json(route, 200, { skills: [], total: 0 });
			return;
		}
		if (url.pathname.endsWith("/mcp/catalog")) {
			await json(route, 200, { servers: [], total: 0 });
			return;
		}
		if (url.pathname.endsWith("/plugins/catalog")) {
			await json(route, 200, { entries: [] });
			return;
		}
		if (url.pathname.endsWith("/apps")) {
			await json(route, 200, { apps: [] });
			return;
		}
		await json(route, 200, {});
	});
	return fixture;
}

/** Pick a Store section: a visible tab, or the strip's "More" menu for the
 *  sections that live there. */
export async function selectStoreSection(page: Page, name: string | RegExp) {
	const tab = page.getByRole("tab", { name });
	if ((await tab.count()) > 0) {
		await tab.first().click();
		return;
	}
	await page.getByRole("button", { name: "More sections" }).click();
	await page.getByRole("menuitem", { name }).first().click();
}

export const agentsTab = (page: Page) =>
	page.getByRole("tab", { name: "Agents" });
export const globalSearch = (page: Page) =>
	page.getByRole("searchbox", { name: "Search the whole marketplace…" });
export const runtimeCodexCard = (page: Page) =>
	page.getByRole("button", {
		name: /^(?:Codex|.*Codex Run Codex through ACP.*)$/,
	});
