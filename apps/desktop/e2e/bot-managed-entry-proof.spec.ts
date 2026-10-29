import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { AgentSelection } from "../src/lib/api/preferences.ts";

const cloudPreferenceKey = "default-cloud-agent-selection";
// Independent expected wire contract; the browser runs the real preference client.
const autoCloudSelection: AgentSelection = {
	agent_id: "ryu",
	provider: "managed-openrouter",
	model: "openrouter/auto",
	thinking_level: "",
	effort: "",
	access_mode: "",
};
const path = `/api/preferences/${cloudPreferenceKey}`;
const proofDir = resolve(
	process.env.RYU_BOT_ENTRY_PROOF_DIR ??
		resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-bot-entry"
		)
);
interface Call {
	auth?: string;
	body: unknown;
	method: string;
	path: string;
}
interface BotEntryDiagnostics {
	calls: Call[];
	errors: string[];
	unknown: string[];
}
const diagnostics = new WeakMap<Page, BotEntryDiagnostics>();
test.beforeEach(async ({ page }) => {
	const state: BotEntryDiagnostics = {
		unknown: [],
		errors: [],
		calls: [],
	};
	diagnostics.set(page, state);
	page.on("pageerror", (error) => state.errors.push(error.message));
	await page.clock.install();
});
test.afterEach(async ({ page }, info) => {
	const state = diagnostics.get(page)!;
	mkdirSync(proofDir, { recursive: true });
	writeFileSync(
		resolve(
			proofDir,
			`${info.title.replace(/[^a-z0-9]+/gi, "-")}-contracts.json`
		),
		JSON.stringify(state, null, 2)
	);
	expect(state.unknown).toEqual([]);
	expect(state.errors).toEqual([]);
});
async function screenshot(page: Page, name: string) {
	mkdirSync(proofDir, { recursive: true });
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({
		path: resolve(proofDir, name),
		fullPage: true,
		animations: "disabled",
	});
}
test("Bot stays pending until cloud readback, shows failed persistence, and retries the actual entry control", async ({
	page,
	baseURL,
}) => {
	let stored: string | null = null;
	let writes = 0;
	let releaseReadback: (() => void) | undefined;
	const heldReadback = new Promise<void>((resolve) => {
		releaseReadback = resolve;
	});
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const state = diagnostics.get(page)!;
			expect(url.origin).toBe(new URL(baseURL!).origin);
			expect(request.headers().authorization).toBe(
				"Bearer bot-proof-admission"
			);
			const body: unknown =
				request.method() === "GET" ? null : request.postDataJSON();
			state.calls.push({
				method: request.method(),
				path: url.pathname,
				auth: request.headers().authorization,
				body,
			});
			if (url.pathname !== path || !["GET", "PUT"].includes(request.method())) {
				state.unknown.push(`${request.method()} ${url.pathname}`);
				await route.fulfill({
					status: 501,
					json: { error: "Unexpected Bot API" },
				});
				return;
			}
			if (request.method() === "PUT") {
				expect(body).toEqual({ value: JSON.stringify(autoCloudSelection) });
				writes++;
				if (writes === 2) {
					stored = JSON.stringify(autoCloudSelection);
				}
				await route.fulfill({ json: { ok: true } });
				return;
			}
			expect(request.postData()).toBeNull();
			if (writes === 1) {
				await heldReadback;
			}
			await route.fulfill({
				status: stored === null ? 404 : 200,
				json:
					stored === null
						? { error: "unset" }
						: { key: cloudPreferenceKey, value: stored },
			});
		}
	);
	await page.goto("/bot-managed-entry-proof.html");
	await expect
		.poll(() => diagnostics.get(page)!.calls.map((call) => call.method))
		.toEqual(["GET", "PUT", "GET"]);
	await expect(page.getByTestId("bot-retry")).toBeDisabled();
	await expect(
		page.getByText("Preparing your managed workspace…", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("bot-ready-host-boundary")).toHaveCount(0);
	await screenshot(page, "bot-entry-pending-readback.png");
	releaseReadback?.();
	await expect(page.getByRole("alert")).toHaveText(
		"Couldn't confirm your managed workspace. Refresh workspace to try again."
	);
	await expect(page.getByTestId("bot-retry")).toBeEnabled();
	await expect(page.getByTestId("bot-ready-host-boundary")).toHaveCount(0);
	const failedCalls = diagnostics.get(page)!.calls.length;
	await page.clock.fastForward(6000);
	expect(diagnostics.get(page)!.calls).toHaveLength(failedCalls);
	await screenshot(page, "bot-entry-unpersisted-retry.png");
	await page
		.getByRole("button", { name: "Refresh workspace", exact: true })
		.click();
	await expect(page.getByTestId("bot-ready-host-boundary")).toBeVisible();
	expect(diagnostics.get(page)!.calls.map((call) => call.method)).toEqual([
		"GET",
		"PUT",
		"GET",
		"GET",
		"PUT",
		"GET",
	]);
	expect(stored).toBe(JSON.stringify(autoCloudSelection));
	// This screenshot documents entry dispatch only; the full chat is a separate host.
	await screenshot(page, "bot-entry-confirmed-host-boundary.png");
});

test("Bot read refusal leaves the Console cloud choice unchanged until explicit retry", async ({
	page,
	baseURL,
}) => {
	const stored = JSON.stringify({
		...autoCloudSelection,
		model: "console-selected-model",
		provider: "managed-openrouter",
	});
	let reads = 0;
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const state = diagnostics.get(page)!;
			expect(url.origin).toBe(new URL(baseURL!).origin);
			expect(request.headers().authorization).toBe(
				"Bearer bot-proof-admission"
			);
			state.calls.push({
				method: request.method(),
				path: url.pathname,
				auth: request.headers().authorization,
				body: request.postData(),
			});
			if (url.pathname !== path || request.method() !== "GET") {
				state.unknown.push(`${request.method()} ${url.pathname}`);
				await route.fulfill({
					status: 501,
					json: { error: "Unexpected Bot API" },
				});
				return;
			}
			expect(request.postData()).toBeNull();
			reads++;
			await route.fulfill({
				status: reads === 1 ? 503 : 200,
				json:
					reads === 1
						? { error: "Read temporarily unavailable" }
						: { key: cloudPreferenceKey, value: stored },
			});
		}
	);
	await page.goto("/bot-managed-entry-proof.html");
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByTestId("bot-ready-host-boundary")).toHaveCount(0);
	await page.clock.fastForward(6000);
	expect(reads).toBe(1);
	await screenshot(page, "bot-entry-read-refusal.png");
	await page
		.getByRole("button", { name: "Refresh workspace", exact: true })
		.click();
	await expect(page.getByTestId("bot-ready-host-boundary")).toBeVisible();
	expect(diagnostics.get(page)!.calls.map((call) => call.method)).toEqual([
		"GET",
		"GET",
	]);
});
