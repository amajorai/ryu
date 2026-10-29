import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";

// Register before React and isolate this file from non-browser Bun suites.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentOptimizationsView } = await import("./AgentOptimizationsView.tsx");
const { request } = await import("../../lib/api/client.ts");

import type { OptimizerRecommendation } from "../../lib/api/optimizer.ts";

const target = {
	url: "http://127.0.0.1:7980",
	token: "synthetic-optimizer-node",
	userJwt: "synthetic-optimizer-user",
};
const realFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	globalThis.fetch = realFetch;
	document.body.replaceChildren();
});

const recommendation: OptimizerRecommendation = {
	id: "original/suggestion",
	agentId: "support:agent",
	title: "Use the less expensive model",
	kind: "model",
	status: "pending",
	createdAt: "2026-10-05T00:00:00Z",
	summary: "The replay preserved quality.",
	change: { type: "set_model", from: "original-model", to: "cheaper-model" },
	evidence: { cases: 3, sessions: 12, verified: true, savings: 0.5 },
};
const path = "/api/agents/support%3Aagent/optimizations";
function button(label: string): HTMLButtonElement {
	const matches = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].filter((element) => element.textContent?.trim() === label);
	if (matches.length !== 1) {
		throw new Error(
			`Expected one button named ${label}, found ${matches.length}`
		);
	}
	const element = matches[0];
	if (!element) {
		throw new Error(`Missing actual optimizer button: ${label}`);
	}
	return element;
}
async function click(label: string) {
	await act(async () => button(label).click());
}
async function mount(onApplied: () => Promise<void> | void) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			createElement(AgentOptimizationsView, {
				target,
				agentId: recommendation.agentId,
				onApplied,
			})
		)
	);
}

test("a committed apply failure reloads the actual agent and same-ID recovery survives new analysis and remount without a second configuration write", async () => {
	let applied = false;
	let acknowledged = false;
	let analyzed = false;
	let historyUnavailable = false;
	let applyAttempts = 0;
	let configurationWrites = 0;
	let agentReads = 0;
	const calls: { method: string; path: string; body: unknown }[] = [];
	const unknown: string[] = [];
	const state = () => ({
		readiness: { ready: true, required: 10, sessions: 12 },
		lastAnalysis: analyzed
			? {
					at: "2026-10-05T01:00:00Z",
					candidates: [],
					cases: 3,
					sessions: 12,
					notes: [],
				}
			: null,
		historyUnavailable,
		recommendations: historyUnavailable
			? []
			: analyzed
				? [{ ...recommendation, status: "superseded" }]
				: [{ ...recommendation, status: acknowledged ? "applied" : "pending" }],
		recoveryRecommendations: applied && !acknowledged ? [recommendation] : [],
	});
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			const method = init?.method ?? "GET";
			const body: unknown =
				init?.body === undefined ? null : JSON.parse(String(init.body));
			calls.push({ method, path: url.pathname, body });
			if (
				url.origin === target.url &&
				!url.search &&
				headers.get("authorization") === `Bearer ${target.token}` &&
				headers.get("x-ryu-user-jwt") === target.userJwt
			) {
				if (method === "GET" && body === null && url.pathname === path) {
					return Response.json(state());
				}
				if (
					method === "GET" &&
					body === null &&
					url.pathname === "/api/agents/support%3Aagent"
				) {
					agentReads += 1;
					return Response.json({
						id: recommendation.agentId,
						model: applied ? "cheaper-model" : "original-model",
						revision: configurationWrites,
					});
				}
				if (
					method === "POST" &&
					body === null &&
					url.pathname === `${path}/original%2Fsuggestion/apply`
				) {
					applyAttempts += 1;
					if (applyAttempts === 1) {
						applied = true;
						configurationWrites += 1;
						return Response.json(
							{
								error: "Agent saved; acknowledgement unavailable",
								agentUpdated: true,
								recoveryRequired: true,
								recommendationId: recommendation.id,
							},
							{ status: 500 }
						);
					}
					if (applyAttempts === 2) {
						return Response.json(
							{ error: "Recovery temporarily unavailable" },
							{ status: 503 }
						);
					}
					if (applyAttempts === 3) {
						acknowledged = true;
						return Response.json({
							recommendation: { ...recommendation, status: "applied" },
							agent: { model: "cheaper-model" },
						});
					}
				}
				if (
					method === "POST" &&
					url.pathname === `${path}/analyze` &&
					JSON.stringify(body) === JSON.stringify({ candidateModels: [] })
				) {
					analyzed = true;
					return Response.json(state());
				}
			}
			unknown.push(`${method} ${url.href}`);
			throw new Error(
				`Unexpected optimizer recovery request: ${method} ${url.href}`
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	function Editor() {
		const [current, setCurrent] = useState("original-model / revision 0");
		return createElement(
			"section",
			null,
			createElement(
				"output",
				{ "aria-label": "Current agent configuration" },
				current
			),
			createElement(AgentOptimizationsView, {
				target,
				agentId: recommendation.agentId,
				onApplied: async () => {
					const agent = await request<{ model: string; revision: number }>(
						target,
						"/api/agents/support%3Aagent",
						{},
						z.object({ model: z.string(), revision: z.number() }).passthrough()
					);
					setCurrent(`${agent.model} / revision ${agent.revision}`);
				},
			})
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(createElement(Editor)));
	await click("Apply");
	expect(document.querySelector("output")?.textContent).toBe(
		"cheaper-model / revision 1"
	);
	expect(agentReads).toBe(1);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"500"
	);
	expect(button("Retry recording suggestion").disabled).toBe(false);
	expect(
		[...document.querySelectorAll("button")].some(
			(element) => element.textContent === "Apply"
		)
	).toBe(false);
	await click("Run analysis");
	expect(document.body.textContent).toContain("Replaced by a newer analysis");
	expect(button("Retry recording suggestion").disabled).toBe(false);
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
	historyUnavailable = true;
	// Recovery must be discovered from Core on a fresh mount, independently of
	// this component's previous error state or superseded recommendation status.
	await mount(async () => {
		await request(
			target,
			"/api/agents/support%3Aagent",
			{},
			gatewayJsonValueSchema
		);
	});
	expect(document.body.textContent).toContain(
		"Suggestion history is unavailable"
	);
	expect(button("Retry recording suggestion").disabled).toBe(false);
	await click("Retry recording suggestion");
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"503"
	);
	expect(button("Retry recording suggestion").disabled).toBe(false);
	expect(agentReads).toBe(1);
	await click("Retry recording suggestion");
	expect(document.querySelector('[role="alert"]')).toBeNull();
	expect(document.body.textContent).not.toContain("Retry recording suggestion");
	expect(agentReads).toBe(2);
	expect(configurationWrites).toBe(1);
	expect(applyAttempts).toBe(3);
	expect(calls.filter((call) => call.method === "POST")).toEqual([
		{ method: "POST", path: `${path}/original%2Fsuggestion/apply`, body: null },
		{ method: "POST", path: `${path}/analyze`, body: { candidateModels: [] } },
		{ method: "POST", path: `${path}/original%2Fsuggestion/apply`, body: null },
		{ method: "POST", path: `${path}/original%2Fsuggestion/apply`, body: null },
	]);
	expect(unknown).toEqual([]);
});

for (const refusal of [
	{
		label: "another recommendation identity",
		status: 500,
		recommendationId: "different-id",
		agentUpdated: true,
	},
	{
		label: "a forbidden decision",
		status: 403,
		recommendationId: recommendation.id,
		agentUpdated: true,
	},
	{
		label: "malformed recovery flags",
		status: 500,
		recommendationId: recommendation.id,
		agentUpdated: "true",
	},
]) {
	test(`${refusal.label} cannot announce an applied agent or start recovery`, async () => {
		let reloads = 0;
		let applies = 0;
		const unknown: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = new URL(String(input));
				const headers = new Headers(init?.headers);
				if (
					url.origin === target.url &&
					!url.search &&
					init?.body === undefined &&
					headers.get("authorization") === `Bearer ${target.token}` &&
					headers.get("x-ryu-user-jwt") === target.userJwt
				) {
					if ((init?.method ?? "GET") === "GET" && url.pathname === path) {
						return Response.json({
							readiness: { ready: true, required: 10, sessions: 12 },
							recommendations: [recommendation],
							recoveryRecommendations: [],
							lastAnalysis: null,
						});
					}
					if (
						init?.method === "POST" &&
						url.pathname === `${path}/original%2Fsuggestion/apply`
					) {
						applies += 1;
						return Response.json(
							{
								error: "Decision refused",
								agentUpdated: refusal.agentUpdated,
								recoveryRequired: true,
								recommendationId: refusal.recommendationId,
							},
							{ status: refusal.status }
						);
					}
				}
				unknown.push(url.href);
				throw new Error(`Unexpected optimizer refusal request: ${url.href}`);
			},
			{ preconnect: realFetch.preconnect }
		);
		await mount(() => {
			reloads += 1;
		});
		await click("Apply");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			String(refusal.status)
		);
		expect(document.body.textContent).not.toContain(
			"Retry recording suggestion"
		);
		expect(button("Apply").disabled).toBe(false);
		expect(reloads).toBe(0);
		expect(applies).toBe(1);
		expect(unknown).toEqual([]);
	});
}
