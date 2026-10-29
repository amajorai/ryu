import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

import {
	type ProofJsonRecord,
	type ProofJsonValue,
	parseProofJsonRecord,
} from "./fixture-json.ts";
import { answerDesktopSecretSlot } from "./harness/desktop-secret-slots.ts";
import {
	ConnectionInputFixtureSchema,
	FixtureAddressSchema,
	type FixtureResponse,
	type NativeOnboardingFixtureState,
	type OnboardingFixtureState,
	OnboardingSourceFixtureSchema,
	OrganizationFixtureSchema,
	PreferenceFixtureSchema,
	parseNativeOnboardingFixtureState,
	parseNodeSetupFixture,
	parseOnboardingFixtureState,
} from "./onboarding-fixture-contract.ts";

declare global {
	interface Window {
		remainingNativeInvoke?: (
			command: string,
			args?: ProofJsonRecord
		) => Promise<ProofJsonValue>;
	}
}

const PROOF_URL = "/onboarding-remaining-page-proof.html";
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
	query: string;
}
async function fixture(
	page: Page,
	options: {
		failedNodeSetup?: boolean;
		existingChannels?: boolean;
		failedChannels?: boolean;
		update?: boolean;
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
			query: url.search,
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
				if (
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
			result = {
				channels: options.existingChannels
					? [{ id: "existing-channel", type: "telegram", enabled: true }]
					: [],
			};
			if (options.failedChannels) {
				status = 503;
				result = { error: "Channel read unavailable" };
			}
		} else if (url.pathname === "/api/update/check") {
			result = {
				current: "0.1.0",
				latest: "0.2.0",
				channel: "stable",
				update_available: true,
				notes: null,
				html_url: null,
				asset: null,
			};
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

/** Typed host projection: no real OS registration, update install, or browser open. */
async function nativeFixture(page: Page, phase: string) {
	const dir = await mkdtemp(path.join(tmpdir(), "ryu-remaining-native-"));
	const statePath = path.join(dir, "native.json");
	const calls: {
		command: string;
		args: ProofJsonRecord | undefined;
	}[] = [];
	const state: NativeOnboardingFixtureState = {
		autostart: false,
		tray: true,
		automatic: false,
		prepared: null,
		installed: false,
	};
	const failures = new Set<string>();
	// The sealed `auth-vault` / `license-key` slots, kept for this page's life
	// across reloads. Empty, so a vault a test seeds in localStorage migrates in.
	const slotRecord = new Map<string, string>();
	const slotStorage = {
		getItem: (key: string) => slotRecord.get(key) ?? null,
		setItem: (key: string, value: string) => {
			slotRecord.set(key, value);
		},
	};
	await writeFile(statePath, JSON.stringify(state));
	await page.exposeBinding(
		"remainingNativeInvoke",
		async (_source, command: string, rawArgs?: ProofJsonRecord) => {
			const args =
				rawArgs === undefined
					? undefined
					: parseProofJsonRecord(JSON.stringify(rawArgs));
			calls.push({ command, args });
			if (failures.delete(command)) {
				throw new Error("Fixture native command denied");
			}
			const slot = answerDesktopSecretSlot(slotStorage, command, args ?? {});
			if (slot.handled) {
				return slot.value;
			}
			let value: ProofJsonValue = null;
			switch (command) {
				case "plugin:autostart|is_enabled":
					value = state.autostart;
					break;
				case "plugin:autostart|enable":
					state.autostart = true;
					break;
				case "plugin:autostart|disable":
					state.autostart = false;
					break;
				case "get_close_to_tray":
					value = state.tray;
					break;
				case "set_close_to_tray":
					state.tray = args?.enabled === true;
					break;
				case "get_app_update_download_preference":
					value = state.automatic;
					break;
				case "set_app_update_download_preference":
					state.automatic = args?.enabled === true;
					break;
				case "plugin:app|version":
					value = "0.1.0";
					break;
				case "get_prepared_app_update":
					value = state.prepared;
					break;
				case "prepare_app_update":
					state.prepared = {
						schemaVersion: 1,
						version: "0.2.0",
						signature: "fixture-signature",
						artifactFile: "fixture.zip",
						artifactSize: 100,
						source: { kind: "stable" },
					};
					value = state.prepared;
					break;
				case "install_prepared_app_update":
					state.installed = true;
					value = true;
					break;
				case "plugin:event|listen":
					value = 1;
					break;
				case "plugin:event|unlisten":
					break;
				case "open_external":
					break;
				default:
					throw new Error(`Unimplemented native fixture command ${command}`);
			}
			await writeFile(statePath, JSON.stringify(state));
			return value;
		}
	);
	await page.addInitScript(
		({ phase }) => {
			localStorage.setItem("ryu_desktop_onboarding_phase", phase);
			localStorage.setItem("ryu_autostart_seeded", "true");
			const invoke = window.remainingNativeInvoke;
			if (!invoke) {
				throw new Error("Fixture native binding unavailable");
			}
			Object.assign(window, {
				__TAURI_INTERNALS__: {
					invoke,
					transformCallback: () => 1,
					unregisterCallback: () => {},
					metadata: {
						currentWindow: { label: "main" },
						currentWebview: { label: "main" },
					},
				},
			});
		},
		{ phase }
	);
	return {
		calls,
		failures,
		read: async () =>
			parseNativeOnboardingFixtureState(await readFile(statePath, "utf8")),
	};
}
async function screenshot(page: Page, name: string) {
	await mkdir(EVIDENCE, { recursive: true });
	await page.screenshot({
		path: path.join(EVIDENCE, `onboarding-remaining-${name}.png`),
		fullPage: true,
		animations: "disabled",
	});
}
async function phase(page: Page, value: string, nodePending = false) {
	await page.addInitScript(
		({ value, nodePending }) => {
			localStorage.setItem("ryu_desktop_onboarding_phase", value);
			if (nodePending) {
				localStorage.setItem("remaining_node_pending", "true");
			}
		},
		{ value, nodePending }
	);
}

async function reachTelegram(page: Page) {
	await phase(page, "skills", true);
	await page.goto(PROOF_URL);
	await page
		.getByRole("button", {
			name: "Continue with no optional packs",
			exact: true,
		})
		.click();
	await page.getByRole("button", { name: "Save default", exact: true }).click();
	await page.getByRole("button", { name: /Team proof/ }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Configure provider keys" })
	).toBeVisible();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.getByRole("button", { name: "Skip for now", exact: true }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
}

test("offer Not now completes the production page without checkout or task writes", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await phase(page, "activation-offer");
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("button", { name: "Not now", exact: true })
		).toBeVisible();
		await screenshot(page, "offer-before-skip");
		await page.getByRole("button", { name: "Not now", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
		expect(
			f.calls.filter(
				(c) => /checkout|quests/.test(c.path) && c.method === "POST"
			)
		).toEqual([]);
	} finally {
		await f.close();
	}
});

test("privacy docs uses exact native open contract and Continue completes production onboarding", async ({
	page,
}) => {
	const f = await fixture(page);
	const n = await nativeFixture(page, "welcome");
	try {
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", {
				name: "Read the full privacy & data breakdown",
				exact: true,
			})
			.click();
		await expect
			.poll(() => n.calls.filter((c) => c.command === "open_external").length)
			.toBe(1);
		expect(n.calls.find((c) => c.command === "open_external")?.args?.url).toBe(
			"https://onboarding.fixture.invalid/docs/surfaces/desktop/transparency"
		);
		await page
			.getByTestId("onboarding-final-continue")
			.scrollIntoViewIfNeeded();
		await screenshot(page, "privacy-docs-open");
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

for (const failed of [false, true]) {
	test(`Telegram ${failed ? "failed channel read skip" : "existing channel Continue"} uses production mic callback without duplicate writes`, async ({
		page,
	}) => {
		const f = await fixture(page, {
			existingChannels: !failed,
			failedChannels: failed,
		});
		try {
			await reachTelegram(page);
			await expect(
				page.getByRole("heading", {
					name: failed ? "Check your channels" : "You already have channels",
					exact: true,
				})
			).toBeVisible();
			expect(f.calls.find((c) => c.path === "/api/channels")).toMatchObject({
				method: "GET",
				authorization: "Bearer onboarding-fixture-session",
				body: null,
			});
			await screenshot(
				page,
				failed ? "telegram-fail-closed" : "telegram-existing"
			);
			await page
				.getByRole("button", {
					name: failed ? "Skip for now" : "Continue",
					exact: true,
				})
				.click();
			await expect
				.poll(() =>
					page.evaluate(() =>
						localStorage.getItem("ryu_desktop_onboarding_phase")
					)
				)
				.toBe("mic");
			expect(
				f.calls.filter(
					(c) => /channels|managed-bots/.test(c.path) && c.method !== "GET"
				)
			).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

test("OS preference projection rejects failed writes, retries and reads persisted host state on reload", async ({
	page,
}) => {
	const f = await fixture(page);
	const n = await nativeFixture(page, "preferences");
	try {
		await page.goto(PROOF_URL);
		const startup = page.locator(
			'[role="switch"]:has(+ #onboarding-launch-at-login)'
		);
		const tray = page.locator(
			'[role="switch"]:has(+ #onboarding-close-to-tray)'
		);
		await expect(startup).not.toBeChecked();
		await expect(tray).toBeChecked();
		n.failures.add("plugin:autostart|enable");
		await startup.click();
		await expect
			.poll(
				() =>
					n.calls.filter((c) => c.command === "plugin:autostart|enable").length
			)
			.toBe(1);
		await expect(startup).not.toBeChecked();
		expect((await n.read()).autostart).toBe(false);
		await startup.click();
		await expect(startup).toBeChecked();
		n.failures.add("set_close_to_tray");
		await tray.click();
		await expect
			.poll(
				() => n.calls.filter((c) => c.command === "set_close_to_tray").length
			)
			.toBe(1);
		await expect(tray).toBeChecked();
		expect((await n.read()).tray).toBe(true);
		await tray.click();
		await expect(tray).not.toBeChecked();
		await expect.poll(async () => (await n.read()).tray).toBe(false);
		expect(
			n.calls
				.filter((c) => c.command === "set_close_to_tray")
				.map((c) => c.args)
		).toEqual([{ enabled: false }, { enabled: false }]);
		await page.reload();
		await expect(startup).toBeChecked();
		await expect(tray).not.toBeChecked();
		await screenshot(page, "native-preferences-readback");
	} finally {
		await f.close();
	}
});

test("production update switch prepares exact signed source and explicit install uses native projection", async ({
	page,
}) => {
	const f = await fixture(page);
	const n = await nativeFixture(page, "updates");
	try {
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", { name: "Update available", exact: true })
		).toBeVisible();
		const automatic = page.getByRole("switch", {
			name: "Download app updates automatically",
		});
		await expect(automatic).not.toBeChecked();
		expect(f.calls.find((c) => c.path === "/api/update/check")).toMatchObject({
			method: "GET",
			query: "?channel=stable",
			authorization: "Bearer setup-proof-node-token",
			body: null,
		});
		n.failures.add("set_app_update_download_preference");
		await automatic.click();
		await expect
			.poll(
				() =>
					n.calls.filter(
						(c) => c.command === "set_app_update_download_preference"
					).length
			)
			.toBe(1);
		await expect(automatic).not.toBeChecked();
		await automatic.click();
		await expect(automatic).toBeChecked();
		await expect(
			page.getByRole("button", { name: "Install and restart", exact: true })
		).toBeVisible();
		expect(
			n.calls.find((c) => c.command === "prepare_app_update")?.args
		).toEqual({
			request: { expectedVersion: "0.2.0", source: { kind: "stable" } },
		});
		expect((await n.read()).installed).toBe(false);
		await page
			.getByRole("button", { name: "Install and restart", exact: true })
			.click();
		await expect.poll(async () => (await n.read()).installed).toBe(true);
		await screenshot(page, "update-prepared-install-projection");
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			)
			.toBe("choose");
	} finally {
		await f.close();
	}
});

test("closed personal offer continues local setup without purchase", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await phase(page, "activation-offer");
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", { name: "Continue with local setup", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
		expect(
			f.calls.filter(
				(c) => /checkout|quests/.test(c.path) && c.method === "POST"
			)
		).toEqual([]);
	} finally {
		await f.close();
	}
});

test("Telegram hosted login records exact browser handoff and Skip advances without account or channel writes", async ({
	page,
}) => {
	const f = await fixture(page);
	const n = await nativeFixture(page, "telegram");
	try {
		await reachTelegram(page);
		await page
			.getByRole("button", { name: "Log in with Telegram", exact: true })
			.click();
		await expect
			.poll(() => n.calls.filter((c) => c.command === "open_external").length)
			.toBe(1);
		expect(n.calls.find((c) => c.command === "open_external")?.args?.url).toBe(
			"https://onboarding.fixture.invalid/telegram/connect"
		);
		await expect(
			page.getByRole("status").filter({ hasText: "Telegram Login opened" })
		).toBeVisible();
		await screenshot(page, "telegram-hosted-handoff");
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			)
			.toBe("mic");
		expect(
			f.calls.filter(
				(c) => /channels|managed-bots/.test(c.path) && c.method !== "GET"
			)
		).toEqual([]);
	} finally {
		await f.close();
	}
});

test("production update transport failure retries and Continue reaches the node choice", async ({
	page,
}) => {
	const f = await fixture(page);
	await nativeFixture(page, "updates");
	let attempts = 0;
	await page.route("**/api/update/check?*", async (route) => {
		attempts += 1;
		if (attempts === 1) {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "Fixture update service unavailable" }),
			});
		} else {
			await route.fallback();
		}
	});
	try {
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", {
				name: "Couldn't check for updates",
				exact: true,
			})
		).toBeVisible();
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Update available", exact: true })
		).toBeVisible();
		expect(attempts).toBe(2);
		await screenshot(page, "update-retry-recovered");
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			)
			.toBe("choose");
	} finally {
		await f.close();
	}
});

test("enabled personal offer rejects denied billing permission before checkout without purchase", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await phase(page, "activation-offer");
		await page.addInitScript(() => {
			localStorage.setItem(
				"ryu_accounts",
				JSON.stringify([
					{
						userId: "offer-fixture-user",
						token: "onboarding-fixture-session",
						name: "Fixture user",
						email: "fixture@example.invalid",
					},
				])
			);
			localStorage.setItem("ryu_active_user_id", "offer-fixture-user");
			localStorage.setItem(
				"ryu.feature-flags",
				JSON.stringify({
					accountId: "offer-fixture-user",
					features: { "billing.individual_plans": true },
					fetchedAtMs: Date.now(),
				})
			);
		});
		await page.route("**/api/step-up/status?scope=billing", async (route) => {
			await route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({ error: "Fixture billing permission denied" }),
			});
		});
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", { name: "Start Pro for $49/month", exact: true })
			.click();
		await expect(page.getByRole("alert")).toContainText(
			"We couldn't start checkout. Try again."
		);
		expect(f.calls.filter((c) => /checkout/.test(c.path))).toEqual([]);
		await screenshot(page, "offer-billing-denied");
		await page.getByRole("button", { name: "Not now", exact: true }).click();
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
