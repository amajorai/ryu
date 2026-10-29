import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { CompanionNativeProofPublisher } from "./harness/companion-page-proof.tsx";

declare const window: Window & {
	__COMPANION_NATIVE__: CompanionNativeProofPublisher;
	__COMPANION_REFUSE_SIZE__?: boolean;
};

const proof = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-companion-page"
);
mkdirSync(proof, { recursive: true });

interface RequestRecord {
	auth: string | undefined;
	body: unknown;
	method: string;
	path: string;
}
const diagnostics = new WeakMap<
	Page,
	{ errors: string[]; unknown: string[]; allowSizingError: boolean }
>();
const sizingError =
	"Companion could not fit its window. Reopen the overlay to retry.";
test.afterEach(async ({ page }) => {
	const state = diagnostics.get(page);
	expect(state, "Companion fixture initialized").toBeDefined();
	expect(state?.errors ?? [], "uncaught production errors").toEqual([]);
	expect(state?.unknown ?? [], "unmapped HTTP contracts").toEqual([]);
	const native = await page.evaluate(() => window.__COMPANION_NATIVE__);
	expect(native.unknown, "unmapped native contracts").toEqual([]);
	if (!state?.allowSizingError) {
		await expect(page.getByText(sizingError, { exact: true })).toHaveCount(0);
	}
});

async function waitForCompletedFit(page: Page) {
	await page.evaluate(() => document.fonts.ready);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const content = document.querySelector("#root > div");
				return (
					content instanceof HTMLElement &&
					Math.abs(
						window.innerHeight -
							Math.min(640, Math.max(80, content.scrollHeight))
					) < 1
				);
			})
		)
		.toBe(true);
}

async function open(
	page: Page,
	consent = { contextRead: false, proactive: false, doIt: false },
	paused = false,
	refuseSizing = false
) {
	const requests: RequestRecord[] = [];
	const unknown: string[] = [];
	diagnostics.set(page, {
		errors: [],
		unknown,
		allowSizingError: refuseSizing,
	});
	const errors = diagnostics.get(page)!.errors;
	await page.setViewportSize({ width: 400, height: 80 });
	await page.exposeFunction(
		"companionProofResize",
		async (size: { width: number; height: number }) => {
			await page.setViewportSize(size);
		}
	);
	await page.addInitScript((refuse) => {
		/* SAFETY: companion-page-proof.spec.ts installs __COMPANION_REFUSE_SIZE__ before this proof page is evaluated. */ window.__COMPANION_REFUSE_SIZE__ =
			refuse;
	}, refuseSizing);
	page.on("console", (message) => {
		if (message.type() === "error") {
			writeFileSync(path.join(proof, "console-last-error.txt"), message.text());
		}
	});
	page.on("requestfailed", (request) =>
		writeFileSync(
			path.join(proof, "request-last-failure.txt"),
			`${request.url()} ${request.failure()?.errorText}`
		)
	);
	page.on("pageerror", (error) => {
		errors.push(error.message);
		writeFileSync(
			path.join(proof, "runtime-errors.json"),
			JSON.stringify(errors, null, 2)
		);
	});
	await page.addInitScript(
		({ consent, paused }) =>
			!localStorage.getItem("companion-store") &&
			localStorage.setItem(
				"companion-store",
				JSON.stringify({
					companion_consent: consent,
					companion_paused: paused,
					companion_app_allowlist: ["Finder"],
				})
			),
		{ consent, paused }
	);
	const control = {
		paused,
		app_allowlist: ["Finder"],
		frames: false,
		history_retention_days: 7,
	};
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const pathname = new URL(request.url()).pathname;
			let body = null;
			try {
				body = request.postDataJSON();
			} catch {}
			const method = request.method();
			const auth = request.headers().authorization;
			requests.push({ method, path: pathname, body, auth });
			const key = `${method} ${pathname}`;
			const reject = async () => {
				unknown.push(key);
				await route.fulfill({
					status: 501,
					json: { error: `Unmapped Companion fixture contract: ${key}` },
				});
			};
			if (new URL(request.url()).search) {
				await reject();
				return;
			}
			if (pathname.startsWith("/api/shadow/")) {
				expect(auth).toBeUndefined();
			} else {
				expect(auth).toMatch(
					/^Bearer (companion-node-token|second-node-token)$/
				);
			}
			switch (key) {
				case "GET /api/agents":
					expect(body).toBeNull();
					await route.fulfill({
						json: {
							agents: [
								{
									id:
										auth === "Bearer second-node-token"
											? "agent-second"
											: "agent-first",
									name: "Companion Agent",
								},
							],
						},
					});
					return;
				case "GET /api/shadow/context/current":
					expect(body).toBeNull();
					await route.fulfill({
						json: {
							active_app: "Finder",
							window_title: "Documents",
							selected_text: "Quarterly report",
							screen_text: "Quarterly report",
						},
					});
					return;
				case "GET /api/shadow/proactive":
					expect(body).toBeNull();
					await route.fulfill({ json: { suggestions: [] } });
					return;
				case "POST /api/shadow/capture/control": {
					expect(request.headers()["content-type"]).toContain(
						"application/json"
					);
					expect(body).not.toBeNull();
					const patch = body;
					expect(["app_allowlist", "paused", "app_allowlist,paused"]).toContain(
						Object.keys(patch).sort().join(",")
					);
					z.object({
						paused: z.boolean().optional(),
						app_allowlist: z.array(z.string()).optional(),
					})
						.strict()
						.parse(patch);
					Object.assign(control, patch);
					await route.fulfill({ json: control });
					return;
				}
				case "POST /api/chat/stream":
					expect(request.headers()["content-type"]).toContain(
						"application/json"
					);
					expect(body).toMatchObject({
						conversation_id: expect.stringMatching(/^companion-[0-9a-f-]{36}$/),
						companion_source: true,
						enable_long_term: false,
						messages: [{ role: "user", content: expect.any(String) }],
					});
					expect(Object.keys(body).sort()).toEqual([
						"companion_source",
						"conversation_id",
						"enable_long_term",
						"messages",
						"response_mode",
					]);
					// Core's UI-message SSE framing (sidecar/adapters `ui_chunk`).
					await route.fulfill({
						contentType: "text/event-stream",
						headers: { "x-vercel-ai-ui-message-stream": "v1" },
						body: `${[
							{ type: "start" },
							{ id: "t1", type: "text-start" },
							{
								delta: "The report explains quarterly results.",
								id: "t1",
								type: "text-delta",
							},
							{ id: "t1", type: "text-end" },
							{ type: "finish" },
						]
							.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
							.join("")}data: [DONE]\n\n`,
					});
					return;
				case "POST /api/mcp/tools/call": {
					const agent_id =
						auth === "Bearer second-node-token"
							? "agent-second"
							: "agent-first";
					expect(body).toEqual(
						body.tool === "ghost.ghost_focus"
							? {
									tool: "ghost.ghost_focus",
									agent_id,
									arguments: { app: "Finder" },
								}
							: { tool: "ghost.ghost_screenshot", agent_id, arguments: {} }
					);
					await route.fulfill({
						json: {
							ok: true,
							output:
								body.tool === "ghost.ghost_focus" ? "Focused Finder" : null,
						},
					});
					return;
				}
				default:
					await reject();
			}
		}
	);
	await page.goto("/companion-page-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByRole("button", { name: "Companion", exact: true })
	).toBeVisible();
	await expect
		.poll(() =>
			requests.some(
				(row) =>
					row.method === "POST" &&
					row.path === "/api/shadow/capture/control" &&
					row.auth === undefined &&
					JSON.stringify(row.body) ===
						JSON.stringify({ paused, app_allowlist: ["Finder"] })
			)
		)
		.toBe(true);
	return { requests, errors };
}

test("disabled consent restores without Settings and never reads context or suggestions", async ({
	page,
}) => {
	const { requests, errors } = await open(page);
	await expect(
		page.getByText("Capture disabled", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Desktop actions are disabled.", { exact: false })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Settings", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("checkbox", { name: "Context read" })
	).not.toBeChecked();
	expect(
		requests.filter((row) => /context\/current|\/proactive$/.test(row.path))
	).toEqual([]);
	expect(errors).toEqual([]);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await waitForCompletedFit(page);
	await page.screenshot({ path: path.join(proof, "01-disabled.png") });
});

test("persisted enabled settings read local context independently of proactive consent and stream exact request", async ({
	page,
}) => {
	const { requests, errors } = await open(page, {
		contextRead: true,
		proactive: false,
		doIt: true,
	});
	await expect(page.getByText('Finder · "Quarterly report"')).toBeVisible();
	expect(requests.some((row) => row.path.endsWith("/proactive"))).toBe(false);
	await page.getByRole("button", { name: "Explain", exact: true }).click();
	await expect(
		page.getByText("The report explains quarterly results.")
	).toBeVisible();
	const chat = requests.find((row) => row.path.endsWith("/chat/stream"));
	expect(chat?.method).toBe("POST");
	expect(chat?.auth).toBe("Bearer companion-node-token");
	expect(chat?.body).toMatchObject({
		companion_source: true,
		enable_long_term: false,
		messages: [
			{ role: "user", content: expect.stringContaining("Quarterly report") },
		],
	});
	expect(errors).toEqual([]);
	await waitForCompletedFit(page);
	await page.screenshot({ path: path.join(proof, "02-answer.png") });
	writeFileSync(
		path.join(proof, "requests.json"),
		JSON.stringify(requests, null, 2)
	);
});

test("Ghost blank Enter and Escape cannot execute; trimmed target confirms once with exact agent", async ({
	page,
}) => {
	const { requests, errors } = await open(page, {
		contextRead: true,
		proactive: false,
		doIt: true,
	});
	await page.getByRole("button", { name: "Focus App", exact: true }).click();
	const target = page.getByPlaceholder("App name (e.g. Finder)");
	await target.fill("   ");
	await target.press("Enter");
	await expect(
		page.getByRole("button", { name: "Run", exact: true })
	).toBeDisabled();
	expect(
		requests.filter((row) => row.path.endsWith("/tools/call"))
	).toHaveLength(0);
	await target.press("Escape");
	await expect(page.getByText("Confirm: Focus App")).toHaveCount(0);
	await page.getByRole("button", { name: "Focus App", exact: true }).click();
	await target.fill("  Finder  ");
	await target.press("Enter");
	await expect(page.getByText("Focused Finder")).toBeVisible();
	const actions = requests.filter((row) => row.path.endsWith("/tools/call"));
	expect(actions).toHaveLength(1);
	expect(actions[0].method).toBe("POST");
	expect(actions[0].auth).toBe("Bearer companion-node-token");
	expect(actions[0].body).toEqual({
		tool: "ghost.ghost_focus",
		agent_id: "agent-first",
		arguments: { app: "Finder" },
	});
	expect(errors).toEqual([]);
	await waitForCompletedFit(page);
	await page.screenshot({ path: path.join(proof, "03-ghost-done.png") });
});

test("paused restored consent prevents sensor reads; settings persist and read back", async ({
	page,
}) => {
	const { requests } = await open(
		page,
		{ contextRead: true, proactive: true, doIt: true },
		true
	);
	await expect(page.getByText("Capture paused", { exact: true })).toBeVisible();
	expect(
		requests.filter((row) => /context\/current|\/proactive$/.test(row.path))
	).toEqual([]);
	await page
		.getByRole("button", { name: "Settings", exact: true })
		.first()
		.click();
	await page.getByRole("button", { name: "Resume", exact: true }).click();
	await page.getByRole("checkbox", { name: "Do it (Ghost actions)" }).uncheck();
	await page
		.getByRole("textbox", { name: "App allowlist" })
		.fill(" Finder, Terminal,   ");
	await page.getByRole("button", { name: "Apply", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("companion-store") ?? "{}")
						.companion_app_allowlist
			)
		)
		.toEqual(["Finder", "Terminal"]);
	expect(
		requests.some(
			(row) =>
				row.method === "POST" &&
				row.path === "/api/shadow/capture/control" &&
				row.auth === undefined &&
				JSON.stringify(row.body) === JSON.stringify({ paused: false })
		)
	).toBe(true);
	await page.reload();
	await page
		.getByRole("button", { name: "Settings", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("checkbox", { name: "Do it (Ghost actions)" })
	).not.toBeChecked();
	await expect(
		page.getByRole("textbox", { name: "App allowlist" })
	).toHaveValue("Finder, Terminal");
	expect(
		requests.some(
			(row) =>
				row.method === "POST" &&
				row.auth === undefined &&
				row.path === "/api/shadow/capture/control" &&
				JSON.stringify(row.body) ===
					JSON.stringify({ app_allowlist: ["Finder", "Terminal"] })
		)
	).toBe(true);
	await waitForCompletedFit(page);
	await page.screenshot({ path: path.join(proof, "04-settings-readback.png") });
});

test("node changes clear confirmation and fetch current agent before dispatch", async ({
	page,
}) => {
	const { requests } = await open(page, {
		contextRead: false,
		proactive: false,
		doIt: true,
	});
	await page.getByRole("button", { name: "Focus App", exact: true }).click();
	await page.getByPlaceholder("App name (e.g. Finder)").fill("Finder");
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("companion-node", { detail: "second-node-token" })
		)
	);
	await expect(page.getByText("Confirm: Focus App")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Screenshot", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Screenshot", exact: true }).click();
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByText("Done.", { exact: true })).toBeVisible();
	expect(
		requests.find((row) => row.path.endsWith("/tools/call"))
	).toMatchObject({
		method: "POST",
		auth: "Bearer second-node-token",
		body: {
			agent_id: "agent-second",
			tool: "ghost.ghost_screenshot",
			arguments: {},
		},
	});
});

async function nativeState(page: Page) {
	return page.evaluate(() => {
		const native = window.__COMPANION_NATIVE__;
		return {
			size: native.size,
			position: native.position,
			scale: native.scale,
			calls: native.calls,
			viewport: { width: innerWidth, height: innerHeight },
		};
	});
}

test("production sizing hook expands settings from the compact HiDPI window and preserves dragged position", async ({
	page,
}) => {
	await open(page);
	await expect
		.poll(async () => (await nativeState(page)).size.height)
		.toBeGreaterThan(80);
	const mounted = await nativeState(page);
	expect(mounted.scale).toBe(2);
	expect(mounted.viewport).toEqual(mounted.size);
	expect(mounted.position).toEqual({ x: 96, y: 72 });
	await page.evaluate(() => {
		window.__COMPANION_NATIVE__.position = { x: 220, y: 120 };
	});
	await page
		.getByRole("button", { name: "Settings", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("checkbox", { name: "Context read" })
	).toBeVisible();
	await expect
		.poll(async () => (await nativeState(page)).size.height)
		.toBeGreaterThan(mounted.size.height);
	const settings = await nativeState(page);
	expect(settings.size.width).toBe(400);
	expect(settings.size.height).toBeLessThanOrEqual(640);
	expect(settings.viewport).toEqual(settings.size);
	expect(settings.position).toEqual({ x: 220, y: 120 });
	expect(
		settings.calls.some(
			(call) =>
				call.command === "plugin:window|set_size" &&
				JSON.stringify(call.args) ===
					JSON.stringify({
						label: "companion",
						value: { Logical: settings.size },
					})
		)
	).toBe(true);
	expect(
		settings.calls.some((call) => call.command === "plugin:window|inner_size")
	).toBe(true);
	await expect(page.getByText(sizingError, { exact: true })).toHaveCount(0);
	await waitForCompletedFit(page);
	await page.screenshot({ path: path.join(proof, "05-sizing-settings.png") });
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect
		.poll(async () => (await nativeState(page)).size.height)
		.toBeLessThan(settings.size.height);
	expect((await nativeState(page)).position).toEqual({ x: 220, y: 120 });
	await waitForCompletedFit(page);
	await page.screenshot({ path: path.join(proof, "06-sizing-collapsed.png") });
	writeFileSync(
		path.join(proof, "sizing-command-readback.json"),
		JSON.stringify(await nativeState(page), null, 2)
	);
});

test("native resize refusal is visible and a subsequent content change retries the production bridge", async ({
	page,
}) => {
	await open(
		page,
		{ contextRead: false, proactive: false, doIt: false },
		false,
		true
	);
	await expect(page.getByText(sizingError, { exact: true })).toBeVisible();
	expect((await nativeState(page)).size).toEqual({ width: 400, height: 80 });
	expect(
		(await nativeState(page)).calls.some(
			(call) => call.command === "plugin:window|set_size"
		)
	).toBe(true);
	await page.getByText(sizingError, { exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: path.join(proof, "07-sizing-refused.png") });
	await page.evaluate(() => {
		window.__COMPANION_NATIVE__.refuseSize = false;
	});
	await page
		.getByRole("button", { name: "Settings", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("checkbox", { name: "Context read" })
	).toBeVisible();
	await expect(page.getByText(sizingError, { exact: true })).toHaveCount(0);
	await expect
		.poll(async () => (await nativeState(page)).size.height)
		.toBeGreaterThan(80);
	const recovered = await nativeState(page);
	expect(recovered.viewport).toEqual(recovered.size);
	expect(recovered.position).toEqual({ x: 96, y: 72 });
	diagnostics.get(page)!.allowSizingError = false;
	await waitForCompletedFit(page);
	await page.screenshot({ path: path.join(proof, "08-sizing-recovered.png") });
});
