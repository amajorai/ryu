import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

import {
	type ProofJsonRecord,
	parseProofJson,
	parseProofJsonRecord,
} from "./fixture-json.ts";
import {
	ConnectionInputFixtureSchema,
	FixtureAddressSchema,
	type FixtureResponse,
	type OnboardingFixtureState,
	OnboardingSourceFixtureSchema,
	OrganizationFixtureSchema,
	PreferenceFixtureSchema,
	parseNodeSetupFixture,
	parseOnboardingFixtureState,
} from "./onboarding-fixture-contract.ts";

const PROOF_URL = "/onboarding-setup-page-proof.html";
const EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/evidence"
);
const TOOLKITS = ["gmail", "notion", "slack", "github", "linear"].map(
	(slug) => ({ slug, name: slug[0].toUpperCase() + slug.slice(1), logo: null })
);
const SUGGESTIONS = ["Inbox helper", "Research helper"].map((name, index) => ({
	id: `draft-${index}`,
	name,
	title: "Reviewed assistant",
	description: `A draft for ${name}`,
	reason: "Based on the connected read-only source",
	systemPrompt: `Read and summarize for ${name}. Ask before acting.`,
	tools: ["search_conversations.search"],
}));
interface Call {
	authorization: string | undefined;
	body: ProofJsonRecord | null;
	method: string;
	path: string;
}
async function fixture(
	page: Page,
	options: {
		failedLaneSave?: "local" | "cloud";
		failedNodeSetup?: boolean;
		failedQuest?: boolean;
		suggestions?: boolean;
		failedAgentCreate?: boolean;
		holdLocalWrite?: boolean;
		paid?: boolean;
		denied?: boolean;
		failedConnections?: boolean;
		failedJob?: boolean;
		failedPreference?: boolean;
		failedSource?: boolean;
	} = {}
) {
	const dir = await mkdtemp(path.join(tmpdir(), "ryu-onboarding-page-"));
	const statePath = path.join(dir, "state.json");
	const state: OnboardingFixtureState = {
		nodeSetup: null,
		quests: [],
		rewardClaims: [],
		agents: [],
		activeOrg: "org-one",
		preferences: {},
		configured: false,
		connections: [
			{
				id: "gmail-existing",
				toolkit: "gmail",
				active: true,
				status: "ACTIVE",
				access_level: "read_only",
			},
		],
		materialized: false,
		cancelled: false,
		onboardingSource: null,
	};
	const calls: Call[] = [];
	await writeFile(statePath, JSON.stringify(state));
	let persistence = Promise.resolve();
	const persist = () => {
		const snapshot = JSON.stringify(state);
		persistence = persistence.then(async () => {
			const pending = `${statePath}.pending`;
			await writeFile(pending, snapshot);
			await rename(pending, statePath);
		});
		return persistence;
	};
	let releaseLocalWrite = () => {};
	const localWriteGate = new Promise<void>((resolve) => {
		releaseLocalWrite = resolve;
	});
	let laneWrites = 0;
	let nodeWrites = 0;
	let questCreates = 0;
	let agentCreates = 0;
	let starts = 0;
	let preferenceWrites = 0;
	let sourceWrites = 0;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) {
			raw += chunk;
		}
		const url = new URL(req.url ?? "/", "http://fixture");
		const body = raw ? parseProofJsonRecord(raw) : null;
		calls.push({
			path: url.pathname,
			method: req.method ?? "GET",
			authorization: req.headers.authorization,
			body,
		});
		let status = 200;
		let result: FixtureResponse = {};
		const catalog = () => ({
			providers: [
				{
					id: "fixture-provider",
					label: "Fixture Provider",
					configured: state.configured,
					authKind: "api-key",
					suggestedModels: [],
					supportsDiscovery: false,
				},
			],
			apiTypes: [],
			thinkingLevels: [],
		});
		const job = () => ({
			id: "profile-one",
			state: options.suggestions
				? "completed"
				: options.failedJob && starts === 1
					? "failed"
					: "building",
			error: options.failedJob && starts === 1 ? "Fixture draft failed" : null,
			materialized: state.materialized,
			conversationId: state.materialized ? "profile-chat" : null,
			startedAtMs: Date.now() - 25_000,
			agentSuggestions: options.suggestions ? SUGGESTIONS : [],
		});
		if (url.pathname === "/api/onboarding/state") {
			if (req.method === "PUT") {
				nodeWrites += 1;
				if (options.failedNodeSetup && nodeWrites === 1) {
					status = 503;
					result = { error: "Node setup fixture unavailable" };
				} else {
					state.nodeSetup = parseNodeSetupFixture(body);
				}
			}
			if (status === 200) {
				const b = state.nodeSetup;
				result = {
					version: 1,
					canConfigure: true,
					completed: false,
					completedAtMs: null,
					setupKind: b?.setupKind ?? null,
					personalization: {
						companyContext: b?.companyContext ?? "",
						companyKnowledgeEnabled: b?.companyKnowledgeEnabled ?? false,
					},
				};
			}
		} else if (url.pathname === "/api/profile/me/onboarding-source") {
			sourceWrites += 1;
			if (options.failedSource && sourceWrites === 1) {
				status = 503;
				result = { error: "Source fixture unavailable" };
			} else {
				state.onboardingSource =
					OnboardingSourceFixtureSchema.parse(body).source;
				result = { source: state.onboardingSource };
			}
		} else if (url.pathname === "/api/quests" && req.method === "POST") {
			questCreates += 1;
			if (options.failedQuest && questCreates === 1) {
				status = 503;
				result = { error: "Task fixture unavailable" };
			} else {
				const quest = {
					...body,
					id: "quest-proof",
				};
				state.quests.push(quest);
				result = { quest };
			}
		} else if (url.pathname === "/api/onboarding/activation/rewards/claim") {
			state.rewardClaims.push(body);
			result = {
				amountMicroUsd: 500_000,
				completed: 1,
				remaining: 19,
				granted: true,
			};
		} else if (url.pathname === "/api/onboarding/activation/rewards") {
			result = { amountMicroUsd: 0, completed: 0, remaining: 20 };
		} else if (url.pathname === "/api/onboarding/skills") {
			result = {
				canConfigure: true,
				configured: true,
				options: [],
				selectedPackIds: [],
				syncComplete: true,
			};
		} else if (url.pathname === "/api/billing/subscription-status") {
			result = {
				entitlement: options.paid
					? { managedInference: true, paywalled: false }
					: null,
			};
		} else if (url.pathname === "/api/auth/get-session") {
			result = { session: { activeOrganizationId: state.activeOrg } };
		} else if (url.pathname === "/api/control-plane/orgs") {
			result = {
				organizations: [
					{
						id: "org-one",
						name: "Personal proof",
						role: "owner",
						isPersonal: true,
					},
					{
						id: "org-two",
						name: "Team proof",
						role: "owner",
						isPersonal: false,
					},
				],
			};
		} else if (url.pathname === "/api/auth/organization/set-active") {
			state.activeOrg = OrganizationFixtureSchema.parse(body).organizationId;
		} else if (url.pathname === "/api/onboarding/access") {
			result = {
				allowed: !options.denied,
				managedNode: false,
				scope: "personal",
				reason: options.denied ? "not_node_owner" : "ready",
			};
		} else if (url.pathname === "/api/onboarding/profile/availability") {
			result = { allowed: true, completed: false, reason: "ready" };
		} else if (url.pathname === "/api/pi-config/catalog") {
			result = catalog();
		} else if (url.pathname === "/api/pi-config/providers") {
			state.configured = true;
			result = catalog();
		} else if (url.pathname === "/api/composio/status") {
			result = { configured: true };
		} else if (url.pathname === "/api/composio/toolkits") {
			result = { data: TOOLKITS };
		} else if (url.pathname === "/api/composio/connections") {
			result = { data: state.connections };
			if (options.failedConnections) {
				status = 503;
				result = { error: "Fixture connection read unavailable" };
			}
		} else if (url.pathname === "/api/composio/connections/initiate") {
			const b = ConnectionInputFixtureSchema.parse(body);
			state.connections.push({
				id: "new-notion",
				toolkit: b.toolkit,
				access_level: b.access_level,
				active: true,
				status: "ACTIVE",
			});
			result = {
				connection_id: "new-notion",
				redirect_url: "",
				status: "INITIATED",
			};
		} else if (url.pathname === "/api/composio/connections/new-notion") {
			result = state.connections.at(-1);
		} else if (url.pathname.startsWith("/api/preferences/")) {
			const key = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			if (req.method === "PUT") {
				if (options.holdLocalWrite && key === "default-local-agent-selection") {
					await localWriteGate;
				}
				if (key === "product-analytics-enabled") {
					preferenceWrites += 1;
				}
				const failedLaneKey = `default-${options.failedLaneSave}-agent-selection`;
				if (key === failedLaneKey) {
					laneWrites += 1;
				}
				if (key === failedLaneKey && laneWrites === 1) {
					status = 503;
				} else if (
					options.failedPreference &&
					key === "product-analytics-enabled" &&
					preferenceWrites === 1
				) {
					status = 503;
				} else {
					state.preferences[key] = PreferenceFixtureSchema.parse(body).value;
				}
			}
			result = { key, value: state.preferences[key] ?? "" };
		} else if (url.pathname === "/api/onboarding/profile/start") {
			starts += 1;
			result = job();
		} else if (url.pathname.includes("/profile/background/")) {
			state.materialized = true;
			result = job();
		} else if (url.pathname.includes("/profile/cancel/")) {
			state.cancelled = true;
			result = { ...job(), state: "cancelled" };
		} else if (url.pathname.includes("/profile/status/")) {
			result = job();
		} else if (url.pathname === "/api/channels") {
			result = [];
		} else if (url.pathname === "/api/agents") {
			if (req.method === "POST") {
				agentCreates += 1;
				if (options.failedAgentCreate && agentCreates === 2) {
					status = 503;
					result = { error: "Fixture agent save unavailable" };
				} else {
					const agent = {
						...body,
						id: `saved-${agentCreates}`,
					};
					state.agents.push(agent);
					result = { agent };
				}
			} else {
				result = { agents: state.agents };
			}
		} else if (url.pathname === "/api/credits/wallet") {
			result = { wallet: null, ledger: [] };
		}
		await persist();
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(result));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = FixtureAddressSchema.parse(server.address());
	let closing = false;
	await page.route("**/*", async (route) => {
		try {
			if (closing) {
				await route.abort();
				return;
			}
			const url = new URL(route.request().url());
			if (url.pathname.startsWith("/api/")) {
				const response = await route.fetch({
					url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
				});
				await route.fulfill({ response });
				return;
			}
			if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
				await route.abort();
				return;
			}
			await route.continue();
		} catch (error) {
			if (!closing) {
				throw error;
			}
		}
	});
	return {
		calls,
		releaseLocalWrite,
		read: async () =>
			parseOnboardingFixtureState(await readFile(statePath, "utf8")),
		close: async () => {
			closing = true;
			if (!page.isClosed()) {
				await page
					.goto("about:blank", { waitUntil: "commit" })
					.catch(() => undefined);
				await page.unrouteAll({ behavior: "wait" }).catch(() => undefined);
			}
			releaseLocalWrite();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
		},
	};
}
async function localDefault(page: Page) {
	await page.goto(PROOF_URL);
	await page
		.getByRole("button", {
			name: "Continue with no optional packs",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("heading", { name: "Set your local default" })
	).toBeVisible();
	await page.getByRole("button", { name: "Save default", exact: true }).click();
}
async function chooseOrg(page: Page) {
	await expect(page.getByRole("button", { name: /Team proof/ })).toBeVisible();
	await page.getByRole("button", { name: /Team proof/ }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
}
async function toProfile(page: Page) {
	await localDefault(page);
	await chooseOrg(page);
	await expect(
		page.getByRole("heading", { name: "Connect your accounts" })
	).toBeVisible();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.getByRole("button", { name: "Save default", exact: true }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Build my profile" })
	).toBeVisible();
}

test("production org/provider/cloud/import callers persist exact mutations and reload auto-import", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await localDefault(page);
		await chooseOrg(page);
		const key = page.getByLabel("Fixture Provider API key");
		await expect(key).toHaveAttribute("type", "password");
		await key.fill("  fixture-key-only  ");
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByText("Configured on this node")).toBeVisible();
		expect(
			f.calls.find((c) => c.path === "/api/pi-config/providers")?.body
		).toEqual({ apiKey: "fixture-key-only", provider: "fixture-provider" });
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect(
			page.getByText("No importable threads were found on this node.")
		).toBeVisible();
		const toggle = page.getByRole("switch");
		await expect(toggle).toBeChecked();
		await toggle.click();
		await page.reload();
		await expect(page.getByRole("switch")).not.toBeChecked();
		const saved = await f.read();
		expect(saved.activeOrg).toBe("org-two");
		expect(saved.preferences["default-cloud-agent-selection"]).toBe("");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:auto-import-agent-threads")
			)
		).toBe("false");
		expect(
			f.calls
				.filter((c) => c.path === "/api/auth/organization/set-active")
				.at(-1)?.body
		).toEqual({ organizationId: "org-two" });
		await mkdir(EVIDENCE, { recursive: true });
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-import-toggle-readback.png"
			),
			fullPage: true,
		});
	} finally {
		await f.close();
	}
});

test("production acquisition answer retries exact session mutation and navigates activation steps", async ({
	page,
}) => {
	const f = await fixture(page, { failedSource: true, paid: true });
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "activation-source")
		);
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("button", { name: "Continue", exact: true })
		).toBeDisabled();
		await page.getByRole("radio", { name: "Search", exact: true }).click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByText(
				"We couldn't save that answer. Try again or check your connection."
			)
		).toBeVisible();
		expect((await f.read()).onboardingSource).toBeNull();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Recommended for you" })
		).toBeVisible();
		const writes = f.calls.filter(
			(c) => c.path === "/api/profile/me/onboarding-source"
		);
		expect(writes).toHaveLength(2);
		for (const call of writes) {
			expect(call).toMatchObject({
				method: "PATCH",
				authorization: "Bearer onboarding-fixture-session",
				body: { source: "search" },
			});
		}
		expect((await f.read()).onboardingSource).toBe("search");
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page.getByRole("button", { name: "See your first task" }).click();
		await expect(
			page.getByRole("heading", { name: "Your subscription is ready" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue to task" }).click();
		await expect(
			page.getByRole("button", { name: "Start task" })
		).toBeVisible();
		await page.getByRole("button", { name: "Start task" }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"This workspace cannot create an onboarding task. Ask the node owner to continue."
		);
		expect(
			f.calls.some((c) => c.method === "POST" && c.path === "/api/quests")
		).toBe(false);
		expect(
			f.calls.some((c) => c.method === "POST" && c.path.includes("checkout"))
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("production appearance controls persist both presets, theme and roundness before continuation", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "theme")
		);
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", { name: "Make it yours" })
		).toBeVisible();
		await page
			.locator("label")
			.filter({
				has: page.locator('input[name="onboarding-theme"][value="dark"]'),
			})
			.click();
		for (const index of [0, 1]) {
			await page.getByRole("combobox").nth(index).click();
			await page.getByRole("option").last().click();
		}
		const slider = page.getByRole("slider", { name: "Roundness" });
		await slider.focus();
		await slider.press("End");
		const saved = await page.evaluate(() => ({
			theme: localStorage.getItem("theme"),
			light: localStorage.getItem("ryu_light_preset"),
			dark: localStorage.getItem("ryu_dark_preset"),
			radius: localStorage.getItem("ryu_radius"),
		}));
		expect(saved.theme).toBe("dark");
		expect(saved.light).toBeTruthy();
		expect(saved.dark).toBeTruthy();
		await page.reload();
		await expect(
			page.getByRole("radio", { name: /^Dark\s+Dark$/ })
		).toBeChecked();
		await expect(slider).toHaveAttribute("aria-valuenow", saved.radius ?? "");
		expect(
			await page.evaluate(() => ({
				light: localStorage.getItem("ryu_light_preset"),
				dark: localStorage.getItem("ryu_dark_preset"),
			}))
		).toEqual({ light: saved.light, dark: saved.dark });
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Set your preferences" })
		).toBeVisible();
	} finally {
		await f.close();
	}
});

test("production desktop preferences persist appearance and continue to privacy", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "preferences")
		);
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", { name: "Set your preferences" })
		).toBeVisible();
		await page
			.locator('[role="switch"]:has(+ #onboarding-inset-sidebar)')
			.click();
		await page
			.locator('[role="switch"]:has(+ #onboarding-pointer-cursor)')
			.click();
		expect(
			await page.evaluate(() => ({
				sidebar: localStorage.getItem("ryu:sidebar-variant"),
				pointer: localStorage.getItem("ryu_pointer_cursor"),
				attribute: document.documentElement.getAttribute("data-pointer-cursor"),
			}))
		).toEqual({ sidebar: "inset", pointer: "true", attribute: "true" });
		await page.reload();
		await expect(
			page.locator('[role="switch"]:has(+ #onboarding-inset-sidebar)')
		).toBeChecked();
		await expect(
			page.locator('[role="switch"]:has(+ #onboarding-pointer-cursor)')
		).toBeChecked();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(page.getByTestId("onboarding-final-continue")).toBeVisible();
	} finally {
		await f.close();
	}
});

test("production privacy choices reject failed write, retry and persist all four after reload", async ({
	page,
}) => {
	const f = await fixture(page, { failedPreference: true });
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "welcome")
		);
		await page.goto(PROOF_URL);
		const analytics = page.locator(
			'[role="switch"]:has(+ #onboarding-product-analytics)'
		);
		await expect(analytics).toBeChecked();
		await analytics.click();
		await expect
			.poll(
				() =>
					f.calls.filter(
						(c) =>
							c.method === "PUT" &&
							c.path === "/api/preferences/product-analytics-enabled"
					).length
			)
			.toBe(1);
		await expect(analytics).toBeChecked();
		expect(
			(await f.read()).preferences["product-analytics-enabled"]
		).toBeUndefined();
		await analytics.click();
		await expect(analytics).not.toBeChecked();
		await page
			.locator('[role="switch"]:has(+ #onboarding-community-stats)')
			.click();
		await page
			.locator('[role="switch"]:has(+ #onboarding-crash-reports)')
			.click();
		await page
			.locator('[role="switch"]:has(+ #onboarding-diagnostics-export)')
			.click();
		await expect
			.poll(
				async () => (await f.read()).preferences["diagnostics-export-enabled"]
			)
			.toBe("true");
		for (const [key, value] of Object.entries({
			"product-analytics-enabled": "false",
			"community-stats-enabled": "false",
			"crash-reports-enabled": "false",
			"diagnostics-export-enabled": "true",
		})) {
			expect((await f.read()).preferences[key]).toBe(value);
			expect(
				f.calls
					.filter(
						(c) => c.method === "PUT" && c.path === `/api/preferences/${key}`
					)
					.at(-1)
			).toMatchObject({
				authorization: "Bearer setup-proof-node-token",
				body: { value },
			});
		}
		await page.reload();
		for (const id of [
			"product-analytics",
			"community-stats",
			"crash-reports",
		]) {
			await expect(
				page.locator(`[role="switch"]:has(+ #onboarding-${id})`)
			).not.toBeChecked();
		}
		await expect(
			page.locator('[role="switch"]:has(+ #onboarding-diagnostics-export)')
		).toBeChecked();
		await mkdir(EVIDENCE, { recursive: true });
		await page
			.getByText("Choose your privacy settings", { exact: true })
			.locator("..")
			.screenshot({
				path: path.join(
					EVIDENCE,
					"onboarding-production-privacy-persisted-readback.png"
				),
				animations: "disabled",
			});
		await page.getByTestId("onboarding-final-continue").click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
	} finally {
		await f.close();
	}
});

test("production paid connections search, reveal more, require permission, and read back connection", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true });
	try {
		await localDefault(page);
		await chooseOrg(page);
		await expect(
			page.getByRole("button", { name: "Connected", exact: true })
		).toBeDisabled();
		await page.getByRole("button", { name: "More integrations" }).click();
		await page
			.getByPlaceholder("Search Gmail, Notion, Slack, GitHub, or more")
			.fill("Notion");
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		const dialog = page.getByTestId("connection-permission-dialog");
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).not.toBeVisible();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(dialog).toBeVisible();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
		await dialog.getByRole("button", { name: "Continue to connect" }).click();
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Connected", exact: true })
		).toBeDisabled();
		const call = f.calls.find((c) => c.path.endsWith("/initiate"));
		expect(call?.body).toEqual({
			toolkit: "notion",
			access_level: "risk_based",
		});
		expect(call?.authorization).toBe("Bearer setup-proof-node-token");
		expect((await f.read()).connections.at(-1)?.toolkit).toBe("notion");
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-production-connected-readback.png"),
			fullPage: true,
		});
	} finally {
		await f.close();
	}
});

test("production profile failure retry materializes background and continues", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, failedJob: true });
	try {
		await toProfile(page);
		await page.getByRole("button", { name: "Build my profile" }).click();
		await expect(page.getByText("Fixture draft failed")).toBeVisible();
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		await page.getByRole("button", { name: "Run in background" }).click();
		await expect(
			page.getByRole("button", { name: "Continue setup", exact: true })
		).toBeVisible();
		expect((await f.read()).materialized).toBe(true);
		const starts = f.calls.filter((c) => c.path.endsWith("/profile/start"));
		expect(starts).toHaveLength(2);
		expect(starts[0]?.body).toMatchObject({
			recentDays: 90,
			shareUserOrg: false,
			importedConversationIds: [],
			sourceIds: ["gmail-existing"],
		});
		expect(starts[0]?.authorization).toBe("Bearer setup-proof-node-token");
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-profile-background-completed.png"
			),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "Continue setup", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
	} finally {
		await f.close();
	}
});

test("production profile cancel calls exact job and permission denial skips gateway mutations", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true });
	try {
		await toProfile(page);
		await page.getByRole("button", { name: "Build my profile" }).click();
		await page.getByRole("button", { name: "Skip and cancel" }).click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		expect((await f.read()).cancelled).toBe(true);
		expect(
			f.calls.some(
				(c) =>
					c.method === "POST" &&
					c.path === "/api/onboarding/profile/cancel/profile-one"
			)
		).toBe(true);
	} finally {
		await f.close();
	}
});

test("production gateway denial advances to the cloud lane without organization or provider mutations", async ({
	page,
}) => {
	const f = await fixture(page, { denied: true });
	try {
		await localDefault(page);
		await expect(
			page.getByRole("button", { name: "Use local for now" })
		).toBeVisible();
		expect(
			f.calls.some(
				(c) =>
					c.path === "/api/pi-config/providers" ||
					c.path === "/api/auth/organization/set-active"
			)
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("production failed connection read suppresses duplicate connects and allows safe continuation", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, failedConnections: true });
	try {
		await localDefault(page);
		await chooseOrg(page);
		await expect(
			page.getByText(
				"Ryu could not verify your existing connections, so onboarding will not start another one."
			)
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Connect", exact: true })
		).toHaveCount(0);
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Set your cloud default" })
		).toBeVisible();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
	} finally {
		await f.close();
	}
});

test("production local and cloud lane selections persist distinct exact defaults", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true });
	try {
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", {
				name: "Continue with no optional packs",
				exact: true,
			})
			.click();
		await page
			.getByRole("button", { name: "Choose default local agent", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "Custom model id" })
			.fill(" fixture/local ");
		await page
			.getByRole("button", { name: "Use this model", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Save default", exact: true })
			.click();
		await chooseOrg(page);
		await expect(
			page.getByRole("heading", { name: "Connect your accounts" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: "Choose default cloud agent", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "Custom model id" })
			.fill(" fixture/cloud ");
		await page
			.getByRole("button", { name: "Use this model", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Save default", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Import existing threads" })
		).toBeVisible();
		const saved = await f.read();
		const writes = f.calls.filter(
			(c) =>
				c.method === "PUT" &&
				[
					"/api/preferences/default-local-agent-selection",
					"/api/preferences/default-cloud-agent-selection",
				].includes(c.path)
		);
		expect(writes).toHaveLength(2);
		for (const lane of ["local", "cloud"]) {
			expect(
				parseProofJson(saved.preferences[`default-${lane}-agent-selection`])
			).toEqual({
				access_mode: "",
				agent_id: lane === "local" ? "" : "ryu",
				effort: "",
				model: `fixture/${lane}`,
				provider: "",
				thinking_level: "",
			});
		}
		for (const call of writes) {
			expect(call.authorization).toBe("Bearer setup-proof-node-token");
			expect(call.body).toEqual({
				value:
					saved.preferences[
						decodeURIComponent(call.path.split("/").at(-1) ?? "")
					],
			});
		}
	} finally {
		await f.close();
	}
});

test("production setup disables continuation and agent selection until the lane write finishes", async ({
	page,
}) => {
	const f = await fixture(page, { holdLocalWrite: true });
	try {
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", {
				name: "Continue with no optional packs",
				exact: true,
			})
			.click();
		const save = page.getByRole("button", {
			name: "Save default",
			exact: true,
		});
		await save.click();
		await expect
			.poll(
				() =>
					f.calls.filter(
						(c) =>
							c.method === "PUT" &&
							c.path === "/api/preferences/default-local-agent-selection"
					).length
			)
			.toBe(1);
		await expect(page.locator("fieldset")).toHaveAttribute("aria-busy", "true");
		await expect(save).toBeDisabled();
		await expect(
			page.getByRole("button", {
				name: "Choose default local agent",
				exact: true,
			})
		).toBeDisabled();
		expect(
			(await f.read()).preferences["default-local-agent-selection"]
		).toBeUndefined();
		await mkdir(EVIDENCE, { recursive: true });
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-production-save-busy.png"),
			fullPage: true,
		});
		f.releaseLocalWrite();
		await expect(
			page.getByRole("heading", { name: "Choose your organization" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Team proof/ })
		).toBeEnabled();
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-production-save-completed.png"),
			fullPage: true,
		});
		expect(
			f.calls.filter(
				(c) =>
					c.method === "PUT" &&
					c.path === "/api/preferences/default-local-agent-selection"
			)
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});

async function toSuggestions(page: Page) {
	await toProfile(page);
	await page
		.getByRole("button", { name: "Build my profile", exact: true })
		.click();
	await expect(
		page.getByText("Your profile and 2 agent drafts are ready", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Suggested agents for your work" })
	).toBeVisible();
}

test("production suggested agents require prompt review and retry only the failed persisted draft", async ({
	page,
}) => {
	const f = await fixture(page, {
		paid: true,
		suggestions: true,
		failedAgentCreate: true,
	});
	try {
		await toSuggestions(page);
		await expect(
			page.getByRole("button", { name: "Select an agent", exact: true })
		).toBeDisabled();
		for (const draft of SUGGESTIONS) {
			const card = page.getByTestId(`agent-suggestion-${draft.id}`);
			await card
				.getByRole("button", { name: `Select ${draft.name}`, exact: true })
				.click();
			await expect(card.getByTestId("suggested-prompt")).toHaveText(
				draft.systemPrompt
			);
			await card.locator("summary").click();
			await expect(card.getByTestId("suggested-prompt")).not.toBeVisible();
			await card.locator("summary").click();
		}
		await expect(
			page.getByRole("button", {
				name: "Review 2 selected drafts",
				exact: true,
			})
		).toBeDisabled();
		expect(
			f.calls.some((c) => c.method === "POST" && c.path === "/api/agents")
		).toBe(false);
		for (const draft of SUGGESTIONS) {
			await page
				.getByRole("checkbox", {
					name: `I reviewed ${draft.name}`,
					exact: true,
				})
				.click();
		}
		await page
			.getByRole("button", { name: "Add 2 agents", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveText(
			"Added 1. Couldn't add Research helper. Try again or skip."
		);
		expect((await f.read()).agents.map((a) => a.name)).toEqual([
			"Inbox helper",
		]);
		await expect(page.getByTestId("agent-suggestion-draft-0")).toHaveCount(0);
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-agent-partial-retry.png"
			),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "Add 1 agent", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		const writes = f.calls.filter(
			(c) => c.method === "POST" && c.path === "/api/agents"
		);
		expect(writes).toHaveLength(3);
		expect((await f.read()).agents.map((a) => a.name)).toEqual([
			"Inbox helper",
			"Research helper",
		]);
		for (const [index, call] of writes.entries()) {
			const draft = SUGGESTIONS[index === 0 ? 0 : 1];
			expect(call.authorization).toBe("Bearer setup-proof-node-token");
			expect(call.body).toEqual({
				name: draft.name,
				title: draft.title,
				description: draft.description,
				system_prompt: draft.systemPrompt,
				engine: "acp:pi",
				model: "openrouter/auto",
				chat_model: {
					engine: "managed-openrouter",
					model_id: "openrouter/auto",
				},
				tools: draft.tools,
				persona: { display_name: null, tone: null },
				safety_profile: "read_only",
			});
		}
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-suggested-agents-completed.png"
			),
			fullPage: true,
		});
	} finally {
		await f.close();
	}
});

test("production suggested agent deselection and skip do not create agents", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, suggestions: true });
	try {
		await toSuggestions(page);
		await page
			.getByRole("button", { name: "Select Inbox helper", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Deselect Inbox helper", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Select an agent", exact: true })
		).toBeDisabled();
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		expect(
			f.calls.some((c) => c.method === "POST" && c.path === "/api/agents")
		).toBe(false);
		expect((await f.read()).agents).toEqual([]);
	} finally {
		await f.close();
	}
});

test("production owner activation confirms connection permission, claims reward and retries the first task", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, failedQuest: true });
	try {
		await toProfile(page);
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		await page.getByRole("button", { name: "Skip", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Make it yours" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Set your preferences" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page.getByTestId("onboarding-final-continue").click();
		await page.getByRole("radio", { name: "Search", exact: true }).click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Recommended for you" })
		).toBeVisible();
		const notion = page
			.locator("div.rounded-2xl")
			.filter({ has: page.getByText("Notion", { exact: true }) })
			.filter({
				has: page.getByRole("button", {
					name: "Connect · +$0.50",
					exact: true,
				}),
			});
		await notion
			.getByRole("button", { name: "Connect · +$0.50", exact: true })
			.click();
		const permission = page.getByTestId("connection-permission-dialog");
		await permission
			.getByRole("button", { name: "Cancel", exact: true })
			.click();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
		await notion
			.getByRole("button", { name: "Connect · +$0.50", exact: true })
			.click();
		await permission
			.getByRole("button", { name: "Continue to connect", exact: true })
			.click();
		await expect(permission).not.toBeVisible();
		expect((await f.read()).rewardClaims).toEqual([
			{ appSlug: "notion", connectionId: "new-notion" },
		]);
		expect(
			f.calls.find((c) => c.path.endsWith("/rewards/claim"))
		).toMatchObject({
			authorization: "Bearer onboarding-fixture-session",
			body: { appSlug: "notion", connectionId: "new-notion" },
		});
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: "See your first task", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Continue to task", exact: true })
			.click();
		await page.getByRole("button", { name: "Start task", exact: true }).click();
		await expect(page.getByRole("alert")).toHaveText("/api/quests failed: 503");
		expect((await f.read()).quests).toEqual([]);
		await page.getByRole("button", { name: "Start task", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
		const writes = f.calls.filter(
			(c) => c.method === "POST" && c.path === "/api/quests"
		);
		expect(writes).toHaveLength(2);
		expect(writes[0].body).toEqual(writes[1].body);
		expect(writes[1].authorization).toBe("Bearer setup-proof-node-token");
		expect((await f.read()).quests).toHaveLength(1);
		expect(
			parseProofJson(
				await page.evaluate(
					() => localStorage.getItem("ryu_onboarding_activation_task") ?? "null"
				)
			)
		).toMatchObject({ id: "quest-proof" });
	} finally {
		await f.close();
	}
});

for (const kind of ["personal", "team"] as const) {
	test(`production node context ${kind} retries a failed state save and persists only its scope`, async ({
		page,
	}) => {
		const f = await fixture(page, { failedNodeSetup: true });
		try {
			await page.addInitScript(() =>
				localStorage.setItem("ryu_desktop_onboarding_phase", "node-setup")
			);
			await page.goto(PROOF_URL);
			await expect(
				page.getByRole("button", { name: "Continue", exact: true })
			).toBeDisabled();
			await page
				.getByRole("radio", {
					name: kind === "team" ? "Team or company use" : "Personal use",
					exact: true,
				})
				.click();
			await page
				.getByLabel(
					kind === "team"
						? "More information about your company"
						: "More information about you"
				)
				.fill("Reviewable setup context");
			// A personal note is part of every thread's system prompt, so the
			// step confirms the prompt-cache reset before each attempt.
			const continueNodeSetup = async () => {
				await page
					.getByRole("button", { name: "Continue", exact: true })
					.click();
				if (kind === "personal") {
					await page
						.getByRole("alertdialog")
						.getByRole("button", { name: "Apply now", exact: true })
						.click();
				}
			};
			await continueNodeSetup();
			await expect(page.getByRole("alert")).toHaveText(
				"/api/onboarding/state failed: 503"
			);
			expect((await f.read()).nodeSetup).toBeNull();
			await continueNodeSetup();
			await expect(
				page.getByRole("button", {
					name: "Continue with no optional packs",
					exact: true,
				})
			).toBeVisible();
			const writes = f.calls.filter(
				(c) => c.method === "PUT" && c.path === "/api/onboarding/state"
			);
			expect(writes).toHaveLength(2);
			for (const call of writes) {
				expect(call).toMatchObject({
					authorization: "Bearer setup-proof-node-token",
					body: {
						companyContext: kind === "team" ? "Reviewable setup context" : "",
						companyKnowledgeEnabled: kind === "team",
						completed: false,
						setupKind: kind,
					},
				});
			}
			expect((await f.read()).nodeSetup).toEqual(writes[1].body);
			const personalWrites = f.calls.filter(
				(c) => c.method === "PUT" && c.path.includes("personalization")
			);
			expect(personalWrites).toHaveLength(kind === "personal" ? 1 : 0);
		} finally {
			await f.close();
		}
	});
}

for (const lane of ["local", "cloud"] as const) {
	test(`production ${lane} default failed save preserves draft and retries identical persisted selection`, async ({
		page,
	}) => {
		const f = await fixture(page, { failedLaneSave: lane, paid: true });
		try {
			if (lane === "cloud") {
				await localDefault(page);
				await chooseOrg(page);
				await expect(
					page.getByRole("heading", { name: "Connect your accounts" })
				).toBeVisible();
				await page
					.getByRole("button", { name: "Continue", exact: true })
					.click();
			} else {
				await page.goto(PROOF_URL);
				await page
					.getByRole("button", {
						name: "Continue with no optional packs",
						exact: true,
					})
					.click();
			}
			await page
				.getByRole("button", {
					name: `Choose default ${lane} agent`,
					exact: true,
				})
				.click();
			await page
				.getByRole("textbox", { name: "Custom model id" })
				.fill(`fixture/${lane}-retry`);
			await page
				.getByRole("button", { name: "Use this model", exact: true })
				.click();
			const heading = page.getByRole("heading", {
				name: `Set your ${lane} default`,
			});
			const save = page.getByRole("button", {
				name: "Save default",
				exact: true,
			});
			await save.click();
			await expect(page.getByRole("alert")).toHaveText(
				`Could not save your ${lane} default. Try again.`
			);
			await expect(heading).toBeVisible();
			await expect(save).toBeEnabled();
			await page
				.getByRole("button", {
					name: `Choose default ${lane} agent`,
					exact: true,
				})
				.click();
			await expect(
				page.getByRole("textbox", { name: "Custom model id" })
			).toHaveValue(`fixture/${lane}-retry`);
			await page
				.getByRole("button", { name: "Use this model", exact: true })
				.click();
			const key = `default-${lane}-agent-selection`;
			expect((await f.read()).preferences[key]).toBeUndefined();
			expect(
				await page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			).toBe(`${lane}-default`);
			await mkdir(EVIDENCE, { recursive: true });
			await page.screenshot({
				path: path.join(EVIDENCE, `onboarding-${lane}-save-error.png`),
				fullPage: true,
			});
			await save.click();
			await expect(
				page.getByRole("heading", {
					name:
						lane === "local"
							? "Choose your organization"
							: "Import existing threads",
				})
			).toBeVisible();
			await expect(page.getByRole("alert")).toHaveCount(0);
			const expectedSelection = {
				access_mode: "",
				agent_id: lane === "local" ? "" : "ryu",
				effort: "",
				model: `fixture/${lane}-retry`,
				provider: "",
				thinking_level: "",
			};
			const writes = f.calls.filter(
				(c) => c.method === "PUT" && c.path === `/api/preferences/${key}`
			);
			expect(writes).toHaveLength(2);
			for (const call of writes) {
				expect(call.authorization).toBe("Bearer setup-proof-node-token");
				expect(call.body).toEqual(writes[0].body);
				expect(
					parseProofJson(PreferenceFixtureSchema.parse(call.body).value)
				).toEqual(expectedSelection);
			}
			expect(parseProofJson((await f.read()).preferences[key])).toEqual(
				expectedSelection
			);
			await page.screenshot({
				path: path.join(
					EVIDENCE,
					`onboarding-${lane}-save-retry-completed.png`
				),
				fullPage: true,
			});
		} finally {
			await f.close();
		}
	});
}
