import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
	type PluginValue,
	pluginDocumentSchema,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";

declare global {
	interface Window {
		switchRecordingNode: (token: string | null) => void;
	}
}

const manifest = pluginDocumentSchema.parse(
	JSON.parse(
		readFileSync(
			new URL("../../../apps-store/clips/manifest.json", import.meta.url),
			"utf8"
		)
	)
);
// Core's `/api/plugins` row for an installed, enabled non-system app: the raw
// manifest plus the lifecycle fields the Desktop response codec requires.
const clipsApp = {
	...manifest,
	enabled: true,
	installed: true,
	installed_version: manifest.version ?? null,
	built_in: false,
	sidecar_name: null,
	windows_first: false,
	local_only: false,
};
const context = {
	id: "fixture-recording",
	title: "Recorded review",
	durationMs: 4000,
	createdAt: "2026-10-03T00:00:00Z",
	capture: { screen: true, mic: false, systemAudio: true },
	recommendedMoments: [{ atMs: 1000, reason: "Review" }],
	diagnosticsPath: "",
	framesEndpoint: "",
	transcriptPath: "",
	t0EpochMs: 0,
	video: "fixture.mp4",
};
test("production assistant recording controls select inputs, deduplicate pending actions, retry failures and hand off finalized context", async ({
	page,
}) => {
	const calls: { path: string; method: string; body: PluginValue }[] = [];
	const errors: string[] = [];
	page.on(
		"pageerror",
		(error) => (
			errors.push(error.message), process.stderr.write(`${error.message}\n`)
		)
	);
	page.on("console", (message) =>
		process.stderr.write(`${message.type()}:${message.text()}\n`)
	);
	page.on("requestfailed", (request) =>
		process.stderr.write(`FAILED ${request.url()}\n`)
	);
	let sourceAttempts = 0;
	const attempts: Record<string, number> = {};
	await page.addInitScript(() =>
		localStorage.setItem("ryu:interface-level", "expert")
	);
	await page.route("**/api/**", async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (!path.startsWith("/api/")) {
			await route.continue();
			return;
		}
		calls.push({
			path,
			method: req.method(),
			body: pluginValueSchema.parse(req.postDataJSON()),
		});
		let body: PluginValue = {};
		if (path === "/api/plugins") {
			body = { apps: [clipsApp] };
		} else if (path === "/api/clips/sources") {
			sourceAttempts++;
			body =
				sourceAttempts === 1
					? { available: false, reason: "Capture sources unavailable" }
					: {
							displays: [{ id: 7, label: "Review display", primary: false }],
							windows: [{ id: 42, title: "Review window" }],
						};
		} else if (/\/(start|pause|resume|stop)$/.test(path)) {
			const action = path.split("/").at(-1)!;
			attempts[action] = (attempts[action] ?? 0) + 1;
			await new Promise((resolve) => setTimeout(resolve, 350));
			body =
				attempts[action] === 1
					? { available: false, reason: `${action} refused by capture fixture` }
					: { ...context, durationMs: action === "start" ? 0 : 4000 };
		} else if (path === "/api/clips") {
			body = { clips: [context] };
		} else if (path.endsWith("/frame")) {
			await route.fulfill({
				contentType: "image/jpeg",
				body: Buffer.from(
					"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC/AB//2Q==",
					"base64"
				),
			});
			return;
		} else if (path.endsWith("/capabilities")) {
			body = { reasoning: true, tools: true, vision: true };
		} else if (path === "/api/chat/stream") {
			const parts = [
				{ type: "start", messageId: "recording-reply" },
				{ type: "text-start", id: "text" },
				{
					type: "text-delta",
					id: "text",
					delta: "Recording review completed.",
				},
				{ type: "text-end", id: "text" },
				{ type: "finish", finishReason: "stop" },
			];
			await route.fulfill({
				contentType: "text/event-stream",
				headers: { "x-vercel-ai-ui-message-stream": "v1" },
				body:
					parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
					"data: [DONE]\n\n",
			});
			return;
		} else if (path === "/api/pi-config") {
			body = {
				config: { provider: "gateway", model: "fixture", thinkingLevel: "low" },
			};
		} else if (path.includes("catalog")) {
			body = { providers: [], agents: [], thinkingLevels: [] };
		} else if (path.endsWith("/accounts")) {
			body = { accounts: [] };
		} else if (path.includes("models")) {
			body = { models: [], active: null };
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	await page.goto("/recording-controls-proof.html");
	await expect(
		page.getByRole("button", { name: "Ask Ryu", exact: true }),
		JSON.stringify(errors)
	).toBeVisible();
	await page
		.getByRole("button", { name: "Open workspace assistant", exact: true })
		.click();
	const source = () => page.getByRole("button", { name: /Capture source:/ });
	await source().click();
	await expect(page.getByRole("alert")).toContainText(
		"Capture sources unavailable"
	);
	await page.keyboard.press("Escape");
	await source().click();
	await page.getByRole("menuitem", { name: "Review display" }).click();
	await expect(source()).toHaveAccessibleName("Capture source: Review display");
	await source().click();
	await page.getByRole("menuitem", { name: "Review window" }).click();
	await expect(source()).toHaveAccessibleName("Capture source: Review window");
	await source().click();
	await page.getByRole("menuitem", { name: "Primary screen" }).click();
	await expect(source()).toHaveAccessibleName("Capture source: Screen");
	await source().click();
	await page.getByRole("menuitem", { name: "Review display" }).click();
	await page.getByRole("button", { name: "Disable Microphone" }).click();
	await expect(
		page.getByRole("button", { name: "Enable Microphone" })
	).toHaveAttribute("aria-pressed", "false");
	await page.getByRole("button", { name: "Enable System audio" }).click();
	await expect(
		page.getByRole("button", { name: "Disable System audio" })
	).toHaveAttribute("aria-pressed", "true");
	await page
		.getByRole("button", { name: "Start recording", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Starting recording" })
	).toBeDisabled();
	await expect(source()).toBeDisabled();
	await expect(page.getByRole("alert")).toContainText("start refused");
	await page
		.getByRole("button", { name: "Start recording", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Pause recording" })
	).toBeEnabled();
	for (const action of ["pause", "resume", "stop"]) {
		const label =
			action === "pause"
				? "Pause recording"
				: action === "resume"
					? "Resume recording"
					: "Stop recording";
		await page.getByRole("button", { name: label, exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Stop recording" })
		).toBeDisabled();
		await expect(page.getByRole("alert")).toContainText(`${action} refused`);
		await page.getByRole("button", { name: label, exact: true }).click();
		if (action === "pause") {
			await expect(
				page.getByRole("button", { name: "Resume recording" })
			).toBeEnabled();
			await expect(page.getByText("00:04", { exact: true })).toBeVisible();
		}
		if (action === "resume") {
			await expect(
				page.getByRole("button", { name: "Pause recording" })
			).toBeEnabled();
		}
	}
	await expect(
		page.getByRole("button", { name: "Start recording", exact: true })
	).toBeEnabled();
	await expect(
		page.getByRole("img", { name: "clip-frame-1000.jpg", exact: true })
	).toBeVisible();
	expect(
		calls.filter((c) => c.path === "/api/clips/start").map((c) => c.body)
	).toEqual([
		{
			screen: true,
			mic: false,
			systemAudio: true,
			target: { kind: "display", displayId: 7 },
			displayId: 7,
		},
		{
			screen: true,
			mic: false,
			systemAudio: true,
			target: { kind: "display", displayId: 7 },
			displayId: 7,
		},
	]);
	for (const action of ["pause", "resume", "stop"]) {
		expect(
			calls.filter((c) => c.path === `/api/clips/fixture-recording/${action}`)
		).toHaveLength(2);
	}
	expect(calls.filter((c) => c.path.endsWith("/frame"))).toHaveLength(2);
	const next = page.waitForRequest("**/api/chat/stream");
	await page.getByRole("textbox").first().fill("Review the finished recording");
	await page.getByRole("textbox").first().press("Enter");
	const nextRequest = await next;
	expect(nextRequest.headers().authorization).toBe("Bearer fixture-node-token");
	expect(JSON.stringify(nextRequest.postDataJSON())).toContain(
		"Recorded review"
	);
	expect(JSON.stringify(nextRequest.postDataJSON())).toContain(
		"data:image/jpeg;base64,"
	);
	await expect(
		page.getByText("Recording review completed.", { exact: true })
	).toBeVisible();

	expect(errors).toEqual([]);
	writeFileSync(
		test.info().outputPath("runtime-calls.json"),
		JSON.stringify({ calls, errors }, null, 2)
	);
	await expect(page.locator("[data-chat-empty-intro]")).toHaveCount(0);
	await page.screenshot({
		path: test.info().outputPath("recording-completed-attachment.png"),
		fullPage: true,
	});
});

test("saved recordings retry denied context, deduplicate pending picks, queue distinct clips and send truthful frame summaries", async ({
	page,
}) => {
	const calls: { path: string; method: string; body: PluginValue }[] = [];
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let contextAttempts = 0;
	const second = {
		...context,
		id: "second-recording",
		title: "Metadata review",
	};
	await page.addInitScript(() =>
		localStorage.setItem("ryu:interface-level", "expert")
	);
	await page.route("**/api/**", async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (!path.startsWith("/api/")) {
			await route.continue();
			return;
		}
		calls.push({
			path,
			method: req.method(),
			body: pluginValueSchema.parse(req.postDataJSON()),
		});
		let body: PluginValue = {};
		if (path === "/api/plugins") {
			body = { apps: [clipsApp] };
		} else if (path === "/api/clips") {
			body = { clips: [context, second] };
		} else if (path === `/api/clips/${context.id}/context`) {
			contextAttempts++;
			await new Promise((resolve) => setTimeout(resolve, 600));
			if (contextAttempts === 1) {
				await route.fulfill({
					status: 403,
					contentType: "application/json",
					body: JSON.stringify({ error: "Context access denied" }),
				});
				return;
			}
			body = context;
		} else if (path === `/api/clips/${second.id}/context`) {
			body = second;
		} else if (path.endsWith("/frame")) {
			if (path.includes(second.id)) {
				await route.fulfill({ status: 404, body: "Missing frame" });
				return;
			}
			await route.fulfill({
				contentType: "image/jpeg",
				body: Buffer.from(
					"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC/AB//2Q==",
					"base64"
				),
			});
			return;
		} else if (path === "/api/chat/stream") {
			const parts = [
				{ type: "start", messageId: "recording-reply" },
				{ type: "text-start", id: "text" },
				{
					type: "text-delta",
					id: "text",
					delta: "Recording review completed.",
				},
				{ type: "text-end", id: "text" },
				{ type: "finish", finishReason: "stop" },
			];
			await route.fulfill({
				contentType: "text/event-stream",
				headers: { "x-vercel-ai-ui-message-stream": "v1" },
				body:
					parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
					"data: [DONE]\n\n",
			});
			return;
		} else if (path === "/api/pi-config") {
			body = {
				config: { provider: "gateway", model: "fixture", thinkingLevel: "low" },
			};
		} else if (path.endsWith("/capabilities")) {
			body = { reasoning: true, tools: true, vision: true };
		} else if (path.includes("catalog")) {
			body = { providers: [], agents: [], thinkingLevels: [] };
		} else if (path.endsWith("/accounts")) {
			body = { accounts: [] };
		} else if (path.includes("models")) {
			body = { models: [], active: null };
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	await page.goto("/recording-controls-proof.html");
	await page.getByRole("button", { name: "Open workspace assistant" }).click();
	async function pick(title: string) {
		await page
			.getByRole("button", { name: "Attach recording", exact: true })
			.click();
		await page.getByRole("menuitem", { name: new RegExp(title) }).click();
	}
	await pick("Recorded review");
	await expect(
		page.getByRole("status").filter({ hasText: "Preparing recording" })
	).toBeVisible();
	await pick("Recorded review");
	await expect(
		page.getByRole("alert").filter({ hasText: "Could not attach recording" })
	).toBeVisible();
	expect(contextAttempts).toBe(1);
	await expect(
		page.getByRole("img", { name: "clip-frame-1000.jpg", exact: true })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Retry attachment" }).click();
	await pick("Recorded review");
	await pick("Metadata review");
	await expect(
		page.getByRole("img", { name: "clip-frame-1000.jpg", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("status").filter({ hasText: "Preparing recording" })
	).toHaveCount(0);
	expect(contextAttempts).toBe(2);
	expect(
		calls.filter((call) => call.path === `/api/clips/${second.id}/context`)
	).toHaveLength(1);
	const sent = page.waitForRequest("**/api/chat/stream");
	await page.getByRole("textbox").first().fill("Review both recordings");
	await page.getByRole("textbox").first().press("Enter");
	const request = await sent;
	const payload = request.postDataJSON();
	expect(request.headers().authorization).toBe("Bearer fixture-node-token");
	expect(payload.agent_id).toBe("ryu");
	expect(payload.messages).toHaveLength(1);
	expect(
		payload.messages[0].parts.filter(
			(part: { type: string }) => part.type === "file"
		)
	).toEqual([
		{
			type: "file",
			mediaType: "image/jpeg",
			filename: "clip-frame-1000.jpg",
			url: expect.stringMatching(/^data:image\/jpeg;base64,/),
		},
	]);
	const serialized = JSON.stringify(payload);
	expect(serialized).toContain("Recorded review");
	expect(serialized).toContain("Metadata review");
	expect(serialized).toContain("1 frames attached for the moments above.");
	expect(serialized).toContain(
		"No frames were available; this recording is attached as context without images."
	);
	expect(serialized).toContain("data:image/jpeg;base64,");
	await expect(
		page.getByText("Recording review completed.", { exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);
	writeFileSync(
		test.info().outputPath("saved-recording-request.json"),
		JSON.stringify({ payload, calls, errors }, null, 2)
	);
	await expect(page.locator("[data-chat-empty-intro]")).toHaveCount(0);
	await page.screenshot({
		path: test.info().outputPath("saved-recording-retry-completed.png"),
		fullPage: true,
	});
});

test("recording caller discards late start responses after node credential change and clears old-session controls", async ({
	page,
}) => {
	let release!: () => void;
	let started = 0;
	const calls: string[] = [];
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (!path.startsWith("/api/")) {
			await route.continue();
			return;
		}
		calls.push(path);
		let body: PluginValue = {};
		if (path === "/api/plugins") {
			body = { apps: [clipsApp] };
		} else if (path === "/api/clips/start") {
			started++;
			if (started === 1) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			body = { ...context, durationMs: 0 };
		} else if (path === "/api/pi-config") {
			body = {
				config: { provider: "gateway", model: "fixture", thinkingLevel: "low" },
			};
		} else if (path.endsWith("/capabilities")) {
			body = { reasoning: true, tools: true, vision: true };
		} else if (path.includes("catalog")) {
			body = { providers: [], agents: [], thinkingLevels: [] };
		} else if (path.endsWith("/accounts")) {
			body = { accounts: [] };
		} else if (path.includes("models")) {
			body = { models: [], active: null };
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	await page.goto("/recording-controls-proof.html");
	await page.getByRole("button", { name: "Open workspace assistant" }).click();
	await page
		.getByRole("button", { name: "Start recording", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Starting recording" })
	).toBeDisabled();
	await expect.poll(() => started).toBe(1);
	await page.evaluate(() => window.switchRecordingNode("new-node-token"));
	await expect(
		page.getByRole("button", { name: "Start recording", exact: true })
	).toBeEnabled();
	const settled = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/clips/start"
	);
	release();
	await settled;
	await expect(
		page.getByRole("button", { name: "Pause recording" })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Start recording", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Pause recording" })
	).toBeEnabled();
	await page.evaluate(() => window.switchRecordingNode(null));
	await expect(
		page.getByRole("button", { name: "Start recording", exact: true })
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Stop recording" })
	).toHaveCount(0);
	expect(calls.filter((path) => /\/(pause|resume|stop)$/.test(path))).toEqual(
		[]
	);
	writeFileSync(
		test.info().outputPath("recording-node-scope-calls.json"),
		JSON.stringify(calls, null, 2)
	);
	await page.screenshot({
		path: test.info().outputPath("recording-node-scope-completed.png"),
		fullPage: true,
	});
});
