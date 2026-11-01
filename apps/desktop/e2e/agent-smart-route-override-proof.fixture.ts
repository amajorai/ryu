import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";
import { GATEWAY_CONFIG_REQUIRED_SECTIONS } from "./harness/gateway-proof-contracts.ts";

export const STORY_URL = "/agent-smart-route-override-proof.html";
export const AGENT_ID = "agent-smart-route-fixture";
export const OTHER_AGENT_ID = "agent-smart-route-sibling";
export const GATEWAY_CONFIG_PATH = "/api/gateway/config";
export const LEGACY_PREFERENCE_PATH = "/api/preferences/agent-smart-route";
export const CLASSIFY_MODEL_ID = "gemma-3-270m-it-qat-Q4_0";
export const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

export interface ApiCall {
	body: ProofJsonRecord | null;
	method: string;
	path: string;
	status?: number;
}

export type RouteMap = Record<string, ProofJsonRecord>;

export const RouteMapSchema = z.record(
	z.string(),
	z.record(z.string(), z.json())
);

export const GatewayConfigWriteSchema = z.object({
	routing: z.object({
		smart_routing: z.object({ agent_routes: RouteMapSchema }),
	}),
});

export interface FixtureOptions {
	deniedReads?: number;
	deniedWrites?: number;
	initialMap?: RouteMap;
	legacyMap?: RouteMap;
}

export interface FixtureState {
	deniedReads: number;
	deniedWrites: number;
	legacyMap: RouteMap;
	routeMap: RouteMap;
}

export const DEFAULT_CONFIG = {
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

export function routeConfig(overrides: ProofJsonRecord = {}) {
	return { ...DEFAULT_CONFIG, ...overrides };
}

export function parseBody(raw: string | null): ProofJsonRecord | null {
	if (!raw) {
		return null;
	}
	return parseProofJsonRecord(raw);
}

/** The routing section a current gateway serves, carrying `agent_routes`. */
export function gatewayRouting(routeMap: RouteMap) {
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
export function agentRoutesOf(body: ProofJsonRecord | null): RouteMap {
	const parsed = GatewayConfigWriteSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error("Gateway config write did not carry agent_routes");
	}
	return parsed.data.routing.smart_routing.agent_routes;
}

export async function fulfillDenied(
	route: Parameters<Parameters<Page["route"]>[1]>[0],
	call: ApiCall
) {
	call.status = 403;
	await route.fulfill({ json: { error: "permission_denied" }, status: 403 });
}

export async function installPreferenceFixture(
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
				// Desktop validates the full served config shape, which always carries
				// `auth` and `providers` (so at 07d403e33, before #914).
				json: {
					...GATEWAY_CONFIG_REQUIRED_SECTIONS,
					routing: gatewayRouting(state.routeMap),
				},
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

export async function openProof(page: Page) {
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

export async function capture(page: Page, filename: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, filename),
	});
}

export async function chooseOption(
	page: Page,
	label: string,
	option: string | RegExp
) {
	await page.getByLabel(label).click();
	await page.getByRole("option", { name: option }).click();
}

export function preferenceWrites(
	fixture: Awaited<ReturnType<typeof installPreferenceFixture>>
) {
	return fixture.calls.filter(
		(call) => call.path === GATEWAY_CONFIG_PATH && call.method === "PUT"
	);
}

export function preferenceReads(
	fixture: Awaited<ReturnType<typeof installPreferenceFixture>>
) {
	return fixture.calls.filter(
		(call) => call.path === GATEWAY_CONFIG_PATH && call.method === "GET"
	);
}

export function writtenPreference(write: ApiCall): RouteMap {
	return agentRoutesOf(write.body);
}
