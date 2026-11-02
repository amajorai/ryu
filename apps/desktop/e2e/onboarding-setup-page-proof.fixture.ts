// Shared fixture server and navigation helpers for the onboarding setup page proofs.
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";
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
import { proofEvidencePath } from "./proof-evidence-path.ts";

export const PROOF_URL = "/onboarding-setup-page-proof.html";
export const EVIDENCE = proofEvidencePath(
	"test-coverage-sweep-20260924/parallel/desktop-gateway/evidence"
);
export const TOOLKITS = ["gmail", "notion", "slack", "github", "linear"].map(
	(slug) => ({ slug, name: slug[0].toUpperCase() + slug.slice(1), logo: null })
);
export const SUGGESTIONS = ["Inbox helper", "Research helper"].map(
	(name, index) => ({
		id: `draft-${index}`,
		name,
		title: "Reviewed assistant",
		description: `A draft for ${name}`,
		reason: "Based on the connected read-only source",
		systemPrompt: `Read and summarize for ${name}. Ask before acting.`,
		tools: ["search_conversations.search"],
	})
);
export interface Call {
	authorization: string | undefined;
	body: ProofJsonRecord | null;
	method: string;
	path: string;
}
export async function fixture(
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
				// Core's quest shape: the client validates status and timestamps.
				const quest = {
					...body,
					id: "quest-proof",
					status: "open",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
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
			// The full entitlement the billing contract validates; a partial one
			// fails the subscription-status schema and reads as unpaid.
			result = {
				entitlement: options.paid
					? {
							desktopAccess: true,
							managedInference: true,
							marketplaceApps: true,
							monthlyCreditPoolMicroUsd: 0,
							plan: "pro",
							seats: 1,
						}
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
			// Release a held write and drop the server's connections first: a
			// handler still forwarding to the fixture then settles (its errors
			// are ignored while closing) instead of holding the route open.
			releaseLocalWrite();
			server.closeAllConnections();
			if (!page.isClosed()) {
				await page
					.goto("about:blank", { waitUntil: "commit" })
					.catch(() => undefined);
				await page
					.unrouteAll({ behavior: "ignoreErrors" })
					.catch(() => undefined);
			}
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
		},
	};
}
export async function localDefault(page: Page) {
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
export async function chooseOrg(page: Page) {
	await expect(page.getByRole("button", { name: /Team proof/ })).toBeVisible();
	await page.getByRole("button", { name: /Team proof/ }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
}
