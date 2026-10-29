import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { z } from "zod";
import type { marketplaceDetailWireSchema } from "../src/lib/api/marketplace-response-contracts.ts";

declare global {
	interface Window {
		__marketplaceStoreTabFixture?: { enabled: boolean; value: string };
	}
}

const STORY_URL = "/marketplace-store-interactions.html";
const AUTH_TOKEN_KEY = "ryu_session_token";
const EVIDENCE_DIR = resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
	search: string;
}

interface AgentEntry {
	added: boolean;
	available: boolean;
	description: string;
	detected: boolean | null;
	id: string;
	name: string;
	recommended?: boolean;
}

interface Fixture {
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

const initialAgents: AgentEntry[] = [
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

function card(
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

function makeFixture(
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

async function bodyOf(route: Route) {
	try {
		return route.request().postDataJSON();
	} catch {
		return undefined;
	}
}

async function json<FixturePayload>(
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

async function installLocalFixture(
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

const agentsTab = (page: Page) => page.getByRole("tab", { name: "Agents" });
const globalSearch = (page: Page) =>
	page.getByRole("searchbox", { name: "Search the whole marketplace…" });
const runtimeCodexCard = (page: Page) =>
	page.getByRole("button", {
		name: /^(?:Codex|.*Codex Run Codex through ACP.*)$/,
	});

test.describe.configure({ timeout: 90_000 });

test("Store-wide search opens a matching realm and carries the query into it", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=bundles`);
	await globalSearch(page).fill("Codex");
	await expect(
		page.getByRole("button", { name: /Codex/ }).last()
	).toBeVisible();
	await page.getByRole("button", { name: /Codex/ }).last().click();
	await expect(agentsTab(page)).toHaveAttribute("aria-selected", "true");
	await expect(runtimeCodexCard(page)).toBeVisible();
	await expect(globalSearch(page)).toHaveValue("");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const agentSearch = page.getByRole("textbox", { name: "Search agents…" });
	await expect(agentSearch).toHaveValue("Codex");
	await expect(
		fixture.calls.some(
			(call) => call.path === "/api/agents/catalog" && call.method === "GET"
		)
	).toBe(true);
});

test("Install from code validates and normalizes before preview, and reopening resets the draft", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=agents`);
	await page.getByRole("button", { name: "Install from code" }).click();
	const dialog = page.getByRole("dialog", {
		name: "Install a private package",
	});
	await expect(dialog).toContainText("Private by default");
	const input = dialog.getByRole("textbox", { name: "Package code" });
	await input.fill("bad-code");
	await expect(
		dialog.getByRole("button", { name: "Preview package" })
	).toBeDisabled();
	await expect(
		fixture.calls.filter((call) => call.path.includes("share-codes/preview"))
	).toHaveLength(0);
	await input.fill("7k4m-x2qp-9f6d");
	await input.blur();
	await expect(input).toHaveValue("7K4M-X2QP-9F6D");
	await dialog.getByRole("button", { name: "Preview package" }).click();
	await expect(dialog).toContainText("Private Search Plugin");
	await expect(dialog).toContainText("mcp:fixture.search");
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/share-codes/preview")
			.map((call) => call.body)
	).toEqual([{ code: "7K4MX2QP9F6D" }]);
	await dialog.getByRole("button", { name: "Use another code" }).click();
	await expect(
		dialog.getByRole("button", { name: "Preview package" })
	).toBeEnabled();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: "Install from code" }).click();
	await expect(
		page
			.getByRole("dialog", { name: "Install a private package" })
			.getByRole("textbox", { name: "Package code" })
	).toHaveValue("");
	expect(
		fixture.calls.filter(
			(call) =>
				call.method === "POST" && call.path.includes("share-codes/redeem")
		)
	).toHaveLength(0);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Share package" }).click();
	const shareDialog = page.getByRole("dialog", {
		name: "Create a private package code",
	});
	await expect(shareDialog).toBeVisible();
	await expect(shareDialog).toContainText("time-limited code");
	await shareDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(shareDialog).toHaveCount(0);
	expect(
		fixture.calls
			.filter(
				(call) => call.method === "POST" && call.path.includes("share-codes")
			)
			.map((call) => call.path)
	).toEqual(["/api/marketplace/share-codes/preview"]);
});

test("private package connection review cancels without writing and forwards the chosen access ceiling", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, {
		includeConnectionRequirement: true,
	});
	await page.goto(`${STORY_URL}?section=agents`);
	await page.getByRole("button", { name: "Install from code" }).click();
	const packageDialog = page.getByRole("dialog", {
		name: "Install a private package",
	});
	await packageDialog
		.getByRole("textbox", { name: "Package code" })
		.fill("7K4M-X2QP-9F6D");
	await packageDialog.getByRole("button", { name: "Preview package" }).click();
	await expect(packageDialog).toContainText("Fixture Slack account");
	await expect(packageDialog).toContainText("Needs connection");

	await packageDialog.getByRole("button", { name: "Connect" }).click();
	const permissionDialog = page.getByTestId("connection-permission-dialog");
	await expect(permissionDialog).toContainText(
		"Review access before connecting Fixture Slack account"
	);
	await permissionDialog
		.getByRole("radio", { name: "Full access, including delete" })
		.check();
	await permissionDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(permissionDialog).toHaveCount(0);
	expect(
		fixture.calls.filter(
			(call) => call.path === "/api/composio/connections/initiate"
		)
	).toHaveLength(0);
	await expect(packageDialog).toContainText("Needs connection");

	await packageDialog.getByRole("button", { name: "Connect" }).click();
	await permissionDialog.getByRole("radio", { name: "Write access" }).check();
	await permissionDialog
		.getByRole("button", { name: "Continue to connect" })
		.click();
	await expect(permissionDialog).toHaveCount(0);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/composio/connections/initiate")
			.map((call) => call.body)
	).toEqual([{ access_level: "write", toolkit: "slack" }]);
	await expect(packageDialog).toContainText(
		"Everything required is connected."
	);
	await expect(
		packageDialog.getByText("Connected", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("harness-effects")).toContainText(
		"https://composio.example.test/oauth/fixture"
	);
});

test("Themes tab renders theme listings from its exact catalog", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=themes`);
	const themesTab = page.getByRole("tab", { name: "Themes" });
	await expect(themesTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Fixture Minimal Theme", { exact: true })
	).toBeVisible();
	expect(
		fixture.calls.some(
			(call) =>
				call.method === "GET" &&
				call.path === "/api/marketplace/catalog" &&
				call.search === "?kind=theme"
		)
	).toBe(true);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-themes-body.png"),
	});
});

test("enabled app-contributed Store tab renders its catalog and detail body", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) =>
		pageErrors.push(error.stack ?? error.message)
	);
	page.on("console", (message) => {
		if (message.type() === "error") {
			pageErrors.push(message.text());
		}
	});
	await page.goto(
		`${STORY_URL}?fixtureStoreTab=1&section=plugin%3Acom.ryu.marketplace-fixture%3Afixture-library`
	);
	if (pageErrors.length > 0) {
		throw new Error(pageErrors.join("\n"));
	}
	expect(
		await page.evaluate(() => window.__marketplaceStoreTabFixture ?? null)
	).toEqual({
		enabled: true,
		value:
			"?fixtureStoreTab=1&section=plugin%3Acom.ryu.marketplace-fixture%3Afixture-library",
	});
	const tabLabels = await page.locator('[role="tab"]').allTextContents();
	expect(tabLabels).toContain("Fixture catalog");
	const fixtureTab = page.getByRole("tab", { name: "Fixture catalog" });
	await expect(fixtureTab).toHaveAttribute("aria-selected", "true");
	const listing = page.getByRole("button", {
		name: /Fixture catalog listing/,
	});
	await expect(listing).toBeVisible();
	expect(
		fixture.calls.some(
			(call) =>
				call.method === "GET" &&
				call.path === "/api/fixture/marketplace-store/catalog"
		)
	).toBe(true);
	await listing.click();
	await expect(
		page.getByRole("heading", { name: "Fixture catalog listing" }).last()
	).toBeVisible();
	await expect(
		page
			.getByText("A row supplied by an enabled local Store-tab contribution.", {
				exact: true,
			})
			.last()
	).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-contributed-tab-detail.png"),
	});
});

test("Settings on an installed plugin-backed agent opens that exact settings target", async ({
	page,
}) => {
	await installLocalFixture(page, { pluginSettingsAgent: true });
	await page.goto(`${STORY_URL}?section=agents`);
	await expect(page.getByRole("button", { name: /Pocket TTS/ })).toBeVisible();
	await page.getByRole("button", { name: "Manage", exact: true }).click();
	const settingsItem = page.getByRole("menuitem", {
		name: "Settings",
		exact: true,
	});
	await expect(settingsItem).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.getByRole("menu").screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-agent-settings-menu.png"),
	});
	await settingsItem.click();
	await expect(page.getByTestId("harness-effects")).toContainText(
		'"settingsOpened":["pocket-tts"]'
	);
});

test("runtime catalog retry, add/remove writes, installed filter, and view preference persist", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	fixture.agentCatalogFailures = 1;
	await page.goto(`${STORY_URL}?section=agents`);
	await expect(
		page.getByText("Couldn't load agents", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(runtimeCodexCard(page)).toBeVisible();
	await expect(
		page.getByText("Needs manual install", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "Unavailable on this platform" })
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "Built in" }).first()
	).toBeVisible();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"showcase"
	);

	await page.getByRole("button", { name: "Showcase view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"showcase"
	);
	await page.getByRole("button", { name: "Grid view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await expect(runtimeCodexCard(page)).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("store-agents-grid-with-runtime-states.png"),
	});
	await page.getByRole("button", { name: "List view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"list"
	);
	await page.getByRole("button", { name: "Grid view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("button", { name: "Installed", exact: true }).first()
	).toHaveAttribute("aria-pressed", "true");
	await expect(runtimeCodexCard(page)).toHaveCount(0);
	await expect(page.getByText("Agent Templates", { exact: true })).toHaveCount(
		0
	);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await expect(runtimeCodexCard(page)).toBeVisible();
	await expect(
		page.getByText("Agent Templates", { exact: true })
	).toBeVisible();

	await runtimeCodexCard(page).click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get", exact: true }).click();
	await expect(
		page.getByText("Couldn't add agent", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Codex runtime install is temporarily unavailable")
	).toBeVisible();
	await runtimeCodexCard(page).click();
	const detail = page.getByRole("dialog", { name: "Codex" });
	await expect(detail).toBeVisible();
	await expect(
		detail.getByText("Codex runtime install is temporarily unavailable")
	).toBeVisible();
	await expect(detail.getByRole("button", { name: "Add" })).toBeEnabled();
	await detail.getByRole("button", { name: "Add" }).click();
	await expect(detail.getByRole("button", { name: "Remove" })).toBeVisible();
	await expect(
		fixture.agents.find((agent) => agent.id === "acp:codex")?.added
	).toBe(true);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/catalog/install"
				).length
		)
		.toBe(2);
	const agentWrites = fixture.calls.filter(
		(call) => call.path === "/api/agents/catalog/install"
	);
	expect(agentWrites.map((call) => call.body)).toEqual([
		{ id: "acp:codex" },
		{ id: "acp:codex" },
	]);

	await detail.getByRole("button", { name: "Remove" }).click();
	await expect(
		fixture.agents.find((agent) => agent.id === "acp:codex")?.added
	).toBe(false);
	await page.keyboard.press("Escape");
	await expect(detail).toHaveCount(0);
	await page.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/catalog/install"
				).length
		)
		.toBe(3);
	await expect(
		page.getByRole("button", { name: "Manage", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Manage", exact: true }).click();
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(
		fixture.agents.find((agent) => agent.id === "acp:codex")?.added
	).toBe(false);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/agents/catalog/uninstall")
			.map((call) => call.body)
	).toEqual([{ id: "acp:codex" }, { id: "acp:codex" }]);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await page.getByRole("tab", { name: "Bundles" }).click();
	await expect(
		page.getByRole("button", { name: "Installed", exact: true }).first()
	).toHaveAttribute("aria-pressed", "true");
	await agentsTab(page).click();
	await expect(
		page.getByRole("button", { name: "Installed", exact: true }).first()
	).toHaveAttribute("aria-pressed", "true");
	await expect(runtimeCodexCard(page)).toHaveCount(0);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await runtimeCodexCard(page).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: "Codex" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Codex" })).toHaveCount(0);
	await runtimeCodexCard(page).focus();
	await page.keyboard.press("Space");
	await expect(page.getByRole("dialog", { name: "Codex" })).toBeVisible();
	await page.getByRole("button", { name: "Close" }).click();
	await expect(page.getByRole("dialog", { name: "Codex" })).toHaveCount(0);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const localSearch = page.getByRole("textbox", { name: "Search agents…" });
	await localSearch.fill("no-such-agent-in-this-fixture");
	await expect(
		page.getByText("No agents found", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).last().click();
	await expect(runtimeCodexCard(page)).toBeVisible();

	await page.getByRole("tab", { name: "Bundles" }).click();
	await expect(
		page.getByText("Agent Setup Bundle", { exact: true })
	).toBeVisible();
	await agentsTab(page).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await page.reload();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:store-view-mode"))
	).resolves.toBe(JSON.stringify({ agents: "grid" }));
});

test("agent templates disclose stripped access, fail safely, and retry the same install intent", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=agents`);
	await expect(
		page.getByText("Agent Templates", { exact: true })
	).toBeVisible();
	const communityCard = page.getByRole("button", {
		name: /Research Agent.*Local Fixture Publisher/,
	});
	const communityBuy = communityCard.getByRole("button", { name: /\$12\.00/ });
	await communityCard.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: testInfo.outputPath("agent-template-card-before-buy.png"),
	});
	await communityBuy.click();
	await expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/purchase")
			.map((call) => call.body)
	).toEqual([{ id: "fixture/research-agent", kind: "agent" }]);
	await expect(page.getByTestId("harness-effects")).toContainText(
		"https://checkout.example.test/session/fixture"
	);
	await communityCard.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Get", exact: true })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Get", exact: true }).click();
	await expect(
		page.getByText("Couldn't install this agent", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Add", exact: true }).first().click();
	await expect(
		page.getByText("Couldn't install this agent", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("dialog", { name: "Research Agent" })
	).toHaveCount(0);
	await communityCard.click();
	const detail = page.getByRole("dialog", { name: "Research Agent" });
	await expect(detail).toContainText(
		"It gets none of your credentials, Spaces or Composio actions."
	);
	await expect(detail).toContainText(
		"You can limit which of your accounts it may use under Account access after adding it."
	);
	await detail.getByRole("button", { name: /\$12\.00/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__marketplaceStoreEffects?.externalUrls.length ?? 0
			)
		)
		.toBe(2);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/purchase")
			.map((call) => call.body)
	).toEqual([
		{ id: "fixture/research-agent", kind: "agent" },
		{ id: "fixture/research-agent", kind: "agent" },
	]);
	await detail.getByRole("button", { name: "Add" }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/published/install"
				).length
		)
		.toBe(3);
	await expect(
		detail.getByText("Set this up yourself", { exact: true })
	).toBeVisible();
	await expect(detail).toContainText("com.ryu.web-search");
	await expect(detail).toContainText("GMAIL_LIST_MESSAGES");
	await expect(detail).toContainText("It asked for 2 Spaces");
	await detail.screenshot({
		path: testInfo.outputPath("agent-template-installed-disclosure.png"),
	});
	await page.getByRole("button", { name: "Close" }).click();
	await expect(detail).toHaveCount(0);
	expect(fixture.publishedAgents).toEqual(["fixture/research-agent"]);
	const installWrites = fixture.calls.filter(
		(call) => call.path === "/api/agents/published/install"
	);
	expect(installWrites).toHaveLength(3);
	// SAFETY: These records are filtered to the mounted published-agent install route; installPublishedAgent serializes fixture string IDs and its string idempotency key into each captured body.
	const payloads = installWrites.map(
		(call) => call.body as { id: string; idempotency_key: string }
	);
	expect(payloads.map((payload) => payload.id)).toEqual([
		"fixture/research-agent",
		"fixture/research-agent",
		"fixture/research-agent",
	]);
	expect(new Set(payloads.map((payload) => payload.idempotency_key)).size).toBe(
		1
	);
	expect(
		JSON.parse(
			payloads[0]?.idempotency_key.slice("community-agent-v1:".length) ?? "{}"
		)
	).toEqual({
		accountId: "marketplace-store-fixture-user",
		id: "fixture/research-agent",
		node: "http://127.0.0.1:5189",
	});
	expect(
		fixture.calls.some((call) => call.path === "/api/plugins/catalog/install")
	).toBe(false);
});

test("bundle cards like and open trusted detail with source and member state", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=bundles`);
	const bundlesTab = page.getByRole("tab", { name: "Bundles" });
	await expect(bundlesTab).toHaveAttribute("aria-selected", "true");
	const bundleCard = page
		.locator("section")
		.filter({
			has: page.getByRole("heading", { name: "From the Marketplace" }),
		})
		.filter({ hasText: "Agent Setup Bundle" });
	await expect(bundleCard).toBeVisible();
	await expect(bundleCard).toContainText("2 items · one-click install");
	await expect(
		bundleCard.getByRole("button", { name: "Buy", exact: true })
	).toHaveCount(0);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.method === "GET" &&
					call.path === "/api/marketplace/catalog" &&
					call.search === "?kind=bundle"
			)
		)
		.toBe(true);

	const like = bundleCard.getByRole("button", { name: "Like (2)" });
	await expect(like).toHaveAttribute("aria-pressed", "false");
	await like.click();
	const liked = bundleCard.getByRole("button", { name: "Unlike (3)" });
	await expect(liked).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(() => fixture.likes["fixture/agent-setup-bundle"]?.count)
		.toBe(3);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.method === "POST" && call.path === "/api/marketplace/likes"
				).length
		)
		.toBe(1);
	await liked.click();
	await expect(
		bundleCard.getByRole("button", { name: "Like (2)" })
	).toHaveAttribute("aria-pressed", "false");
	await expect
		.poll(() => fixture.likes["fixture/agent-setup-bundle"]?.count)
		.toBe(2);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/likes")
			.map((call) => ({ method: call.method, body: call.body }))
	).toEqual([
		{ method: "POST", body: { namespace: "fixture/agent-setup-bundle" } },
		{ method: "DELETE", body: { namespace: "fixture/agent-setup-bundle" } },
	]);

	await bundleCard
		.getByRole("button", {
			name: /Agent Setup Bundle.*Local Fixture Publisher/,
		})
		.click();
	const detail = page.getByRole("dialog", { name: "Agent Setup Bundle" });
	await expect(detail).toContainText(
		"Install the safe agent setup in one reviewable action."
	);
	await expect(detail).toContainText("Research Agent");
	await expect(detail).toContainText("agent · fixture/research-agent");
	await expect(detail).toContainText("Required");
	await expect(detail).toContainText("Weekly Review Workflow");
	await expect(detail).toContainText("workflow · fixture/weekly-review");
	await expect(detail).toContainText("Optional");
	const source = detail.getByRole("link", { name: "View topic source" });
	await expect(source).toHaveAttribute(
		"href",
		"https://example.test/topic/source"
	);
	await expect(source).toHaveAttribute("target", "_blank");
	await expect(source).toHaveAttribute("rel", "noopener noreferrer");
	await detail.screenshot({
		path: testInfo.outputPath("bundle-detail-members-and-safe-source.png"),
	});
});

test("bundle card and detail install use kind-specific members, expose retry, and read back installed state", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	fixture.communityAgentInstallFailures = 1;
	fixture.communityAgentInstallGate = new Promise<void>((resolve) => {
		fixture.releaseCommunityAgentInstall = resolve;
	});
	await page.goto(`${STORY_URL}?section=bundles`);
	const bundleCard = page
		.locator("section")
		.filter({
			has: page.getByRole("heading", { name: "From the Marketplace" }),
		})
		.filter({ hasText: "Agent Setup Bundle" });
	const cardInstall = bundleCard.getByRole("button", {
		name: "Install bundle",
	});
	await cardInstall.click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/published/install"
				).length
		)
		.toBe(1);
	await expect(page.getByText("Installing 0/2", { exact: true })).toBeVisible();
	await expect(cardInstall).toBeDisabled();
	fixture.releaseCommunityAgentInstall?.();
	await expect(
		page.getByText("Bundle installed with required items missing", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByText(/1 installed, 0 already present, 1 required failed/)
	).toBeVisible();
	await expect.poll(() => fixture.workflows).toEqual(["fixture/weekly-review"]);
	await expect.poll(() => fixture.publishedAgents).toEqual([]);
	await expect
		.poll(
			() =>
				fixture.calls.filter((call) => call.path === "/api/marketplace/usage")
					.length
		)
		.toBe(1);

	await cardInstall.click();
	await expect(
		page.getByText("Bundle installed", { exact: true })
	).toBeVisible();
	// The detailed installed/skipped summary is a short-lived toast. Assert it
	// while it is still onscreen, before the readback polls below.
	await expect(
		page.getByText("1 installed, 1 already present", { exact: false })
	).toBeVisible();
	await expect
		.poll(() => fixture.publishedAgents)
		.toEqual(["fixture/research-agent"]);
	await expect.poll(() => fixture.workflows).toEqual(["fixture/weekly-review"]);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/published/install"
				).length
		)
		.toBe(2);
	const dialogOpener = bundleCard.getByRole("button", {
		name: /Agent Setup Bundle.*Local Fixture Publisher/,
	});
	await dialogOpener.click();
	const detail = page.getByRole("dialog", { name: "Agent Setup Bundle" });
	await expect(detail).toBeVisible();
	const detailInstall = detail.getByRole("button", { name: "Install bundle" });
	await detailInstall.click();
	await expect(
		page.getByText("Bundle installed", { exact: true })
	).toBeVisible();
	await expect
		.poll(() => fixture.publishedAgents)
		.toEqual(["fixture/research-agent"]);
	await expect.poll(() => fixture.workflows).toEqual(["fixture/weekly-review"]);
	await expect(detail).toContainText("Bundle contents");
	await detail.screenshot({
		path: testInfo.outputPath("bundle-detail-installed-readback.png"),
	});

	const installRequests = fixture.calls.filter((call) =>
		[
			"/api/agents/published/install",
			"/api/workflows/catalog/install",
		].includes(call.path)
	);
	expect(installRequests.map((call) => call.path)).toEqual([
		"/api/agents/published/install",
		"/api/workflows/catalog/install",
		"/api/agents/published/install",
		"/api/workflows/catalog/install",
		"/api/agents/published/install",
		"/api/workflows/catalog/install",
	]);
	const agentRequests = installRequests.filter(
		(call) => call.path === "/api/agents/published/install"
	);
	for (const call of agentRequests) {
		// SAFETY: This record is filtered to the mounted published-agent install route; the bundle installer supplies its member string ID and generated string key to installPublishedAgent, which serializes both fields.
		const body = call.body as { id: string; idempotency_key: string };
		expect(body.id).toBe("fixture/research-agent");
		expect(body.idempotency_key).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
	}
	expect(
		installRequests
			.filter((call) => call.path === "/api/workflows/catalog/install")
			.map((call) => call.body)
	).toEqual([
		{ template_id: "fixture/weekly-review" },
		{ template_id: "fixture/weekly-review" },
		{ template_id: "fixture/weekly-review" },
	]);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/usage")
			.map((call) => call.body)
	).toEqual([
		{ event: "download", id: "fixture/agent-setup-bundle", kind: "bundle" },
		{ event: "download", id: "fixture/agent-setup-bundle", kind: "bundle" },
		{ event: "download", id: "fixture/agent-setup-bundle", kind: "bundle" },
	]);
});

test("workflow catalog prices, purchases, and records checkout handoff without leaving the Store", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=workflows`);
	const workflowTab = page.getByRole("tab", { name: "Workflow Templates" });
	await expect(workflowTab).toHaveAttribute("aria-selected", "true");
	const workflowStrip = page
		.locator("section")
		.filter({
			has: page.getByRole("heading", { name: "From the Marketplace" }),
		})
		.filter({ hasText: "Weekly Review Workflow" });
	await expect(workflowStrip).toBeVisible();
	await expect(workflowStrip).toContainText("$12.00");
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.method === "GET" &&
					call.path === "/api/marketplace/catalog" &&
					call.search === "?kind=workflow"
			)
		)
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("workflow-catalog-priced-card.png"),
	});

	const originalUrl = page.url();
	await workflowStrip.getByRole("button", { name: "Buy", exact: true }).click();
	await expect
		.poll(() =>
			fixture.calls.filter((call) => call.path === "/api/marketplace/purchase")
		)
		.toHaveLength(1);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/purchase")
			.map((call) => call.body)
	).toEqual([{ id: "fixture/weekly-review", kind: "workflow" }]);
	await expect(page.getByTestId("harness-effects")).toContainText(
		"https://checkout.example.test/session/fixture"
	);
	await expect(page).toHaveURL(originalUrl);
	await expect(workflowTab).toHaveAttribute("aria-selected", "true");
	await expect(workflowStrip).toBeVisible();
	await expect(
		page.getByText("Opening checkout…", { exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("workflow-checkout-handoff-recorded.png"),
	});
});
