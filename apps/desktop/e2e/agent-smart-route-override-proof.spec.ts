import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";

const STORY_URL = "/agent-smart-route-override-proof.html";
const AGENT_ID = "agent-smart-route-fixture";
const OTHER_AGENT_ID = "agent-smart-route-sibling";
const GATEWAY_CONFIG_PATH = "/api/gateway/config";
const LEGACY_PREFERENCE_PATH = "/api/preferences/agent-smart-route";
const CLASSIFY_MODEL_ID = "gemma-3-270m-it-qat-Q4_0";
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface ApiCall {
	body: ProofJsonRecord | null;
	method: string;
	path: string;
	status?: number;
}

type RouteMap = Record<string, ProofJsonRecord>;

const RouteMapSchema = z.record(z.string(), z.record(z.string(), z.json()));

const GatewayConfigWriteSchema = z.object({
	routing: z.object({
		smart_routing: z.object({ agent_routes: RouteMapSchema }),
	}),
});

interface FixtureOptions {
	deniedReads?: number;
	deniedWrites?: number;
	initialMap?: RouteMap;
	legacyMap?: RouteMap;
}

interface FixtureState {
	deniedReads: number;
	deniedWrites: number;
	legacyMap: RouteMap;
	routeMap: RouteMap;
}

const DEFAULT_CONFIG = {
	allowed_models: [],
	allowed_providers: [],
	cache_by_session: true,
	classifier_model: "",
	default_model: null,
	embedding_model: "",
	enabled: false,
	escalation_confirmations: 2,
	escalation_judge_model: "",
	escalation_message_chars: 500,
	escalation_recent_message_window: 28,
	escalation_strong_model: "",
	escalation_weak_model: "",
	random_seed: null,
	router_type: "llm_classifier",
	rules: [],
	similarity_threshold: 0.35,
	stage_capable_model: "",
	stage_confidence_threshold: 0.5,
	stage_efficient_model: "",
	stage_picker: "capable_first",
	stage_recent_message_window: 3,
	strategy: "llm",
	timeout_ms: 4000,
};

function routeConfig(overrides: ProofJsonRecord = {}) {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function parseBody(raw: string | null): ProofJsonRecord | null {
	if (!raw) {
		return null;
	}
	return parseProofJsonRecord(raw);
}

/** The routing section a current gateway serves, carrying `agent_routes`. */
function gatewayRouting(routeMap: RouteMap) {
	return {
		default_provider: "openai",
		eval_routing: { candidates: [], enabled: false, explore_ratio: 0 },
		fallback_chain: [],
		modality_map: {},
		model_map: {},
		provider_tiers: {},
		smart_routing: {
			...DEFAULT_CONFIG,
			agent_pools: {},
			agent_routes: routeMap,
		},
	};
}

/** The `agent_routes` map a gateway config PUT carried. */
function agentRoutesOf(body: ProofJsonRecord | null): RouteMap {
	const parsed = GatewayConfigWriteSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error("Gateway config write did not carry agent_routes");
	}
	return parsed.data.routing.smart_routing.agent_routes;
}

async function fulfillDenied(
	route: Parameters<Parameters<Page["route"]>[1]>[0],
	call: ApiCall
) {
	call.status = 403;
	await route.fulfill({ json: { error: "permission_denied" }, status: 403 });
}

async function installPreferenceFixture(
	page: Page,
	options: FixtureOptions = {}
) {
	const calls: ApiCall[] = [];
	const outsideRequests: string[] = [];
	const state: FixtureState = {
		routeMap: structuredClone(options.initialMap ?? {}),
		legacyMap: structuredClone(options.legacyMap ?? {}),
		deniedReads: options.deniedReads ?? 0,
		deniedWrites: options.deniedWrites ?? 0,
	};

	page.on("request", (request) => {
		if (new URL(request.url()).origin !== "http://127.0.0.1:5391") {
			outsideRequests.push(request.url());
		}
	});

	await page.route("http://127.0.0.1:5391/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const body = parseBody(request.postData());
		const call: ApiCall = {
			body,
			method: request.method(),
			path: url.pathname,
		};
		calls.push(call);

		if (url.pathname === GATEWAY_CONFIG_PATH && request.method() === "GET") {
			if (state.deniedReads > 0) {
				state.deniedReads -= 1;
				await fulfillDenied(route, call);
				return;
			}
			call.status = 200;
			await route.fulfill({
				json: { routing: gatewayRouting(state.routeMap) },
			});
			return;
		}

		if (url.pathname === GATEWAY_CONFIG_PATH && request.method() === "PUT") {
			if (state.deniedWrites > 0) {
				state.deniedWrites -= 1;
				await fulfillDenied(route, call);
				return;
			}
			state.routeMap = structuredClone(agentRoutesOf(body));
			call.status = 200;
			await route.fulfill({ json: { ok: true } });
			return;
		}

		if (url.pathname === LEGACY_PREFERENCE_PATH && request.method() === "GET") {
			call.status = 200;
			await route.fulfill({
				json: {
					key: "agent-smart-route",
					value: JSON.stringify(state.legacyMap),
				},
			});
			return;
		}

		if (url.pathname === LEGACY_PREFERENCE_PATH && request.method() === "PUT") {
			const value = body?.value;
			if (!isNativeText(value)) {
				call.status = 400;
				await route.fulfill({
					json: { error: "preference value must be serialized JSON" },
					status: 400,
				});
				return;
			}
			state.legacyMap = RouteMapSchema.parse(JSON.parse(value));
			call.status = 200;
			await route.fulfill({ json: { key: "agent-smart-route", value } });
			return;
		}

		if (url.pathname === "/api/sidecar/status" && request.method() === "GET") {
			call.status = 200;
			await route.fulfill({
				json: {
					sidecars: [{ name: "llamacpp-classify", running: false }],
				},
			});
			return;
		}

		if (
			url.pathname === "/api/models/installed" &&
			request.method() === "GET"
		) {
			call.status = 200;
			await route.fulfill({
				json: { models: [{ stem: CLASSIFY_MODEL_ID }] },
			});
			return;
		}

		call.status = 404;
		await route.fulfill({
			json: { error: "unmapped local routing fixture", path: url.pathname },
			status: 404,
		});
	});

	return { calls, outsideRequests, state };
}

async function openProof(page: Page) {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.addInitScript(() => {
		localStorage.setItem("ryu.catalog.friendly", "false");
	});
	await page.goto(STORY_URL);
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
	await expect(
		page.getByRole("heading", { name: "Per-agent smart routing" })
	).toBeVisible();
	expect(pageErrors).toEqual([]);
}

async function capture(page: Page, filename: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, filename),
	});
}

async function chooseOption(
	page: Page,
	label: string,
	option: string | RegExp
) {
	await page.getByLabel(label).click();
	await page.getByRole("option", { name: option }).click();
}

function preferenceWrites(
	fixture: Awaited<ReturnType<typeof installPreferenceFixture>>
) {
	return fixture.calls.filter(
		(call) => call.path === GATEWAY_CONFIG_PATH && call.method === "PUT"
	);
}

function preferenceReads(
	fixture: Awaited<ReturnType<typeof installPreferenceFixture>>
) {
	return fixture.calls.filter(
		(call) => call.path === GATEWAY_CONFIG_PATH && call.method === "GET"
	);
}

function writtenPreference(write: ApiCall): RouteMap {
	return agentRoutesOf(write.body);
}

test("read and save permission failures preserve the per-agent draft and sibling scope", async ({
	page,
}) => {
	const siblingConfig = routeConfig({
		enabled: true,
		router_type: "random",
		rules: [
			{ description: "Sibling route", model: "provider/sibling", weight: 2 },
		],
	});
	const fixture = await installPreferenceFixture(page, {
		initialMap: { [OTHER_AGENT_ID]: siblingConfig },
		deniedReads: 1,
		deniedWrites: 1,
	});
	await openProof(page);
	await expect(page.getByRole("alert")).toContainText(
		"Could not load per-agent routing"
	);
	expect(preferenceReads(fixture).map((call) => call.status)).toEqual([403]);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	const enabledSwitch = page.getByRole("switch", {
		name: "Override model routing for this agent",
	});
	await expect(enabledSwitch).not.toBeChecked();
	expect(preferenceReads(fixture).map((call) => call.status)).toEqual([
		403, 200,
	]);
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeVisible();

	await enabledSwitch.click();
	const classifierModel = page.getByLabel("Classifier model");
	await expect(
		page.getByRole("button", { name: "Use it", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Use it", exact: true }).click();
	await expect(classifierModel).toHaveValue(CLASSIFY_MODEL_ID);
	await classifierModel.fill("  openrouter/route-classifier  ");
	await page.getByRole("button", { name: "Add rule", exact: true }).click();
	await page
		.getByPlaceholder("When the request is about… (plain language)")
		.fill("  coding requests  ");
	await page
		.getByPlaceholder("Route to model id (e.g. claude-sonnet-4-5)")
		.fill("  openrouter/sonnet  ");
	await page
		.getByLabel("Default model when no rule matches")
		.fill("  openrouter/haiku  ");

	const save = page.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(page.getByText(/This node denied the change/)).toBeVisible();
	await expect(save).toBeEnabled();
	expect(preferenceWrites(fixture).map((call) => call.status)).toEqual([403]);
	expect(fixture.state.routeMap).toEqual({
		[OTHER_AGENT_ID]: siblingConfig,
	});
	await capture(page, "desktop-agent-smart-route-save-permission-retry.png");

	await save.click();
	await expect.poll(() => fixture.state.routeMap[AGENT_ID]).toBeDefined();
	const expectedConfig = routeConfig({
		enabled: true,
		classifier_model: "openrouter/route-classifier",
		default_model: "openrouter/haiku",
		rules: [
			{
				description: "coding requests",
				model: "openrouter/sonnet",
				weight: 1,
			},
		],
	});
	expect(fixture.state.routeMap).toEqual({
		[OTHER_AGENT_ID]: siblingConfig,
		[AGENT_ID]: expectedConfig,
	});
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
	]);
	await page.reload();
	await expect(
		page.getByRole("switch", { name: "Override model routing for this agent" })
	).toBeChecked();
	await expect(page.getByLabel("Classifier model")).toHaveValue(
		"openrouter/route-classifier"
	);
	await expect(
		page.getByPlaceholder("When the request is about… (plain language)")
	).toHaveValue("coding requests");
	await expect(
		page.getByLabel("Default model when no rule matches")
	).toHaveValue("openrouter/haiku");
	await capture(page, "desktop-agent-smart-route-saved-readback.png");

	await page
		.getByRole("switch", { name: "Override model routing for this agent" })
		.click();
	await save.click();
	await expect
		.poll(() => Object.keys(fixture.state.routeMap))
		.toEqual([OTHER_AGENT_ID]);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
		{ [OTHER_AGENT_ID]: siblingConfig },
	]);
	expect(preferenceWrites(fixture).map((call) => call.status)).toEqual([
		403, 200, 200,
	]);
	expect(preferenceReads(fixture).map((call) => call.status)).toEqual([
		403, 200, 200, 200, 200, 200,
	]);
	expect(fixture.outsideRequests).toEqual([]);
	await capture(page, "desktop-agent-smart-route-cleared-scope.png");
});

test("classifier strategies and similarity threshold persist exact model settings", async ({
	page,
}) => {
	const initialConfig = routeConfig({
		enabled: true,
		classifier_model: "openrouter/classifier-small",
	});
	const fixture = await installPreferenceFixture(page, {
		initialMap: { [AGENT_ID]: initialConfig },
	});
	await openProof(page);
	const strategy = page.getByLabel("Strategy");
	await chooseOption(page, "Strategy", "Embedding");
	await page.getByLabel("Embedding model").fill("  local/embed-v2  ");
	const threshold = page.getByRole("slider", { name: "Similarity threshold" });
	await threshold.press("ArrowRight");
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.4");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.strategy)
		.toBe("embedding");
	const embeddingConfig = routeConfig({
		...initialConfig,
		strategy: "embedding",
		embedding_model: "local/embed-v2",
		similarity_threshold: 0.4,
	});
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(embeddingConfig);
	await capture(page, "desktop-agent-smart-route-embedding.png");

	await chooseOption(page, "Strategy", "Keyword");
	await expect(page.getByLabel("Embedding model")).toHaveCount(0);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const keywordConfig = { ...embeddingConfig, strategy: "keyword" };
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.strategy)
		.toBe("keyword");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(keywordConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: embeddingConfig },
		{ [AGENT_ID]: keywordConfig },
	]);
	await page.reload();
	await expect(strategy).toContainText("Keyword");
	await expect(page.getByLabel("Classifier model")).toHaveCount(0);
	expect(fixture.outsideRequests).toEqual([]);
});

test("stage-router and escalation model fields save exact typed values", async ({
	page,
}) => {
	const fixture = await installPreferenceFixture(page, {
		initialMap: { [AGENT_ID]: routeConfig({ enabled: true }) },
	});
	await openProof(page);
	await chooseOption(page, "Router type", /^Stage router/);
	await page.getByLabel("Capable model").fill("  provider/capable  ");
	await page.getByLabel("Efficient model").fill("  provider/efficient  ");
	await chooseOption(page, "Ambiguous-turn default", "Efficient first");
	const confidence = page.getByRole("slider", {
		name: "Signal confidence threshold",
	});
	await confidence.press("ArrowRight");
	await expect(confidence).toHaveAttribute("aria-valuenow", "0.55");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const stageConfig = routeConfig({
		enabled: true,
		router_type: "stage_router",
		stage_capable_model: "provider/capable",
		stage_efficient_model: "provider/efficient",
		stage_picker: "efficient_first",
		stage_confidence_threshold: 0.55,
	});
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("stage_router");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(stageConfig);
	await capture(page, "desktop-agent-smart-route-stage-router.png");

	await chooseOption(page, "Router type", /^Escalation/);
	await page.getByLabel("Weak model").fill("provider/weak");
	await page.getByLabel("Strong model").fill("provider/strong");
	await page.getByLabel("Judge model").fill("provider/judge");
	await page.getByLabel("Confirmations before escalation").fill("4");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const escalationConfig = {
		...stageConfig,
		router_type: "escalation",
		escalation_weak_model: "provider/weak",
		escalation_strong_model: "provider/strong",
		escalation_judge_model: "provider/judge",
		escalation_confirmations: 4,
	};
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("escalation");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(escalationConfig);
	await capture(page, "desktop-agent-smart-route-escalation.png");

	const routerType = page.getByLabel("Router type");
	await chooseOption(page, "Router type", /^Passthrough/);
	await expect(routerType).toContainText("Passthrough");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("passthrough");
	const passthroughConfig = {
		...escalationConfig,
		router_type: "passthrough",
	};
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(passthroughConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: stageConfig },
		{ [AGENT_ID]: escalationConfig },
		{ [AGENT_ID]: passthroughConfig },
	]);
	expect(fixture.outsideRequests).toEqual([]);
});

test("random routing validates seed and weights, adds/removes targets, and reloads", async ({
	page,
}) => {
	const fixture = await installPreferenceFixture(page);
	await openProof(page);
	const enabledSwitch = page.getByRole("switch", {
		name: "Override model routing for this agent",
	});
	await enabledSwitch.click();
	await chooseOption(page, "Router type", /^Weighted random/);
	const seed = page.getByLabel("Seed (optional)");
	await seed.fill("-5");
	await expect(seed).toHaveValue("");
	await seed.fill("42");

	const addRule = page.getByRole("button", { name: "Add rule", exact: true });
	await addRule.click();
	await addRule.click();
	await addRule.click();
	const labels = page.getByPlaceholder("Optional target label");
	const models = page.getByPlaceholder(
		"Route to model id (e.g. claude-sonnet-4-5)"
	);
	const weights = page.getByPlaceholder("Relative weight (default 1)");
	await labels.nth(0).fill("heavy target");
	await models.nth(0).fill("provider/heavy");
	await weights.nth(0).fill("");
	await labels.nth(1).fill("light target");
	await models.nth(1).fill("provider/light");
	await weights.nth(1).fill("3.5");
	await labels.nth(2).fill("invalid weight");
	await models.nth(2).fill("provider/ignored");
	await weights.nth(2).fill("-1");
	await expect(
		page.getByRole("button", { name: "Remove rule 3" })
	).toBeVisible();
	await capture(page, "desktop-agent-smart-route-random-rules.png");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	const randomConfig = routeConfig({
		enabled: true,
		router_type: "random",
		random_seed: 42,
		rules: [
			{ description: "heavy target", model: "provider/heavy", weight: 1 },
			{ description: "light target", model: "provider/light", weight: 3.5 },
		],
	});
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("random");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(randomConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: randomConfig },
	]);
	await page.reload();
	await expect(enabledSwitch).toBeChecked();
	await expect(seed).toHaveValue("42");
	await expect(models).toHaveCount(2);
	await expect(weights.nth(0)).toHaveValue("1");
	await expect(weights.nth(1)).toHaveValue("3.5");

	await addRule.click();
	await expect(
		page.getByRole("button", { name: "Remove rule 3" })
	).toBeVisible();
	await page.getByRole("button", { name: "Remove rule 3" }).click();
	await expect(page.getByRole("button", { name: "Remove rule 3" })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => preferenceWrites(fixture).length).toBe(2);
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(randomConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: randomConfig },
		{ [AGENT_ID]: randomConfig },
	]);
	expect(fixture.outsideRequests).toEqual([]);
});

test("a legacy Core override loads as the draft and moves to the gateway on save", async ({
	page,
}) => {
	const legacyConfig = routeConfig({
		enabled: true,
		classifier_model: "openrouter/legacy-classifier",
		rules: [{ description: "legacy", model: "provider/legacy", weight: 1 }],
	});
	const fixture = await installPreferenceFixture(page, {
		legacyMap: { [AGENT_ID]: legacyConfig, [OTHER_AGENT_ID]: legacyConfig },
	});
	await openProof(page);
	await expect(
		page.getByRole("switch", { name: "Override model routing for this agent" })
	).toBeChecked();
	await expect(page.getByLabel("Classifier model")).toHaveValue(
		"openrouter/legacy-classifier"
	);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => Object.keys(fixture.state.legacyMap))
		.toEqual([OTHER_AGENT_ID]);
	expect(fixture.state.routeMap).toEqual({ [AGENT_ID]: legacyConfig });

	// Once moved, a later save writes the gateway only.
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => preferenceWrites(fixture).length).toBe(2);
	expect(
		fixture.calls.filter(
			(call) => call.path === LEGACY_PREFERENCE_PATH && call.method === "PUT"
		)
	).toHaveLength(1);
	expect(fixture.outsideRequests).toEqual([]);
});
