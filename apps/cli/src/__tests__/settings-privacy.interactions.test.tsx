/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const PRIVACY_KEYS = [
	"product-analytics-enabled",
	"community-stats-enabled",
	"profile-activity-enabled",
	"crash-reports-enabled",
	"diagnostics-export-enabled",
	"diagnostics-otlp-endpoint",
	"diagnostics-otlp-content-mode",
	"support-access-local-enabled",
	"support-access-local-expiry",
] as const;
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let isolatedHome: string | null = null;
beforeEach(() => {
	isolatedHome = mkdtempSync(join(tmpdir(), "ryu-cli-interactions-"));
	process.env.HOME = isolatedHome;
	delete process.env.USERPROFILE;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(isolatedHome)
	);
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (isolatedHome) {
		rmSync(isolatedHome, { recursive: true, force: true });
	}
	isolatedHome = null;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
});

interface RequestRecord {
	body?: { value?: string };
	method: string;
	path: string;
}

interface CoreMockOptions {
	failFirstAnalyticsWrite?: boolean;
	failFirstCrashRead?: boolean;
	failFirstSupportExpiryWrite?: boolean;
	ignoreFirstAnalyticsWrite?: boolean;
}

function installPrivacyCore(options: CoreMockOptions = {}) {
	const stored = new Map<string, string>();
	const requests: RequestRecord[] = [];
	let analyticsPutAttempts = 0;
	let crashGetAttempts = 0;
	let supportExpiryPutAttempts = 0;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/data-path") {
				if (
					url.origin !== LOCAL_TARGET.url ||
					url.search !== "" ||
					method !== "GET" ||
					init?.body !== undefined
				) {
					throw new Error(
						`Unexpected canonical Core request: ${method} ${url}`
					);
				}
				requests.push({ method, path: url.pathname });
				return Response.json({
					current: "/isolated/privacy-storage-readback",
					is_custom: false,
					size_bytes: 2048,
					free_space_bytes: 4096,
				});
			}
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname.startsWith("/api/preferences/")) {
				const key = decodeURIComponent(
					url.pathname.slice("/api/preferences/".length)
				);
				if (PRIVACY_KEYS.some((preference) => preference === key)) {
					const parsedBody = init?.body
						? z
								.object({ value: z.string().optional() })
								.safeParse(JSON.parse(String(init.body)))
						: undefined;
					const body = parsedBody?.success ? parsedBody.data : undefined;
					requests.push({ body, method, path: url.pathname });
					if (key === "product-analytics-enabled" && method === "PUT") {
						analyticsPutAttempts += 1;
						if (options.failFirstAnalyticsWrite && analyticsPutAttempts === 1) {
							return Response.json(
								{ error: "temporary preference write failure" },
								{ status: 503 }
							);
						}
					}
					if (key === "crash-reports-enabled" && method === "GET") {
						crashGetAttempts += 1;
						if (options.failFirstCrashRead && crashGetAttempts === 1) {
							return Response.json(
								{ error: "temporary preference read failure" },
								{ status: 503 }
							);
						}
					}
					if (method === "PUT") {
						if (body?.value === undefined) {
							return Response.json(
								{ error: "value must be a string" },
								{ status: 400 }
							);
						}
						if (key === "support-access-local-expiry") {
							supportExpiryPutAttempts += 1;
							if (
								options.failFirstSupportExpiryWrite &&
								supportExpiryPutAttempts === 1
							) {
								return Response.json(
									{ error: "expiry write denied" },
									{ status: 403 }
								);
							}
						}
						if (
							!(
								key === "product-analytics-enabled" &&
								options.ignoreFirstAnalyticsWrite &&
								analyticsPutAttempts === 1
							)
						) {
							stored.set(key, body.value);
						}
						return Response.json({ key, value: body.value });
					}
					return Response.json({ key, value: stored.get(key) ?? null });
				}
			}
			if (url.pathname === "/api/diagnostics/otlp/test-span") {
				requests.push({ method, path: url.pathname });
				return Response.json({
					ok: true,
					span: "ryu.test",
					endpoint: "https://collector.example.test",
				});
			}
			return Response.json({});
		},
		{ preconnect: realFetch.preconnect }
	);
	return { requests, stored };
}

interface KeyInput {
	ctrl?: boolean;
	name: string;
}

async function press(setup: Setup, key: KeyInput): Promise<void> {
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: key.name.length === 1 ? key.name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	});
}

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	maxFrames = 100
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Privacy settings render did not match: ${frame}`);
	}
	return frame;
}

async function openPrivacy(setup: Setup): Promise<string> {
	await waitForFrame(setup, (frame) => frame.includes("Message"));
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
	// General → Privacy is eighteen panel steps now that Island is not a CLI
	// panel.
	for (let index = 0; index < 18; index += 1) {
		await press(setup, { name: "j" });
	}
	return waitForFrame(
		setup,
		(frame) =>
			frame.includes("Anonymous usage analytics") &&
			frame.includes("Local support access")
	);
}

async function renderApp(): Promise<Setup> {
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 120,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	return setup;
}

test("Privacy loads Core defaults, retries a failed save, verifies readback, and restores the saved choice", async () => {
	const core = installPrivacyCore({ failFirstAnalyticsWrite: true });
	let setup = await renderApp();
	const defaults = await openPrivacy(setup);
	expect(defaults).toContain("Anonymous usage analytics");
	expect(defaults).toContain("Community stats");
	expect(defaults).toContain("Profile activity");
	expect(defaults).toContain("Crash reports");
	expect(defaults).toContain("OFF · opt-in");
	expect(defaults).toContain("not set");
	expect(defaults).toContain("Local support access");
	expect(defaults).toContain("1 hour");
	expect(
		new Set(
			core.requests
				.filter((item) => item.method === "GET")
				.map((item) => item.path)
		)
	).toEqual(new Set(PRIVACY_KEYS.map((key) => `/api/preferences/${key}`)));

	await press(setup, { name: "return" });
	const failed = await waitForFrame(setup, (frame) =>
		frame.includes("Couldn't save the analytics choice")
	);
	expect(failed).toContain("ON");
	expect(core.stored.has("product-analytics-enabled")).toBe(false);

	await press(setup, { name: "r" });
	const saved = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Saved and confirmed from Core.") && frame.includes("OFF")
	);
	expect(saved).toContain("Anonymous usage analytics");
	const analyticsWrites = core.requests.filter(
		(item) =>
			item.path === "/api/preferences/product-analytics-enabled" &&
			item.method === "PUT"
	);
	expect(analyticsWrites).toHaveLength(2);
	expect(analyticsWrites.map((item) => item.body)).toEqual([
		{ value: "false" },
		{ value: "false" },
	]);
	expect(
		core.requests.filter(
			(item) =>
				item.path === "/api/preferences/product-analytics-enabled" &&
				item.method === "GET"
		).length
	).toBeGreaterThanOrEqual(2);

	await act(async () => {
		setup.renderer.destroy();
		await Promise.resolve();
	});
	setup = await renderApp();
	const reloaded = await openPrivacy(setup);
	expect(reloaded).toContain("Anonymous usage analytics");
	expect(reloaded).toContain("OFF");
});

test("Privacy saves the customer OTLP endpoint, keeps export opt-in, and grants support with a hard expiry", async () => {
	const core = installPrivacyCore();
	const setup = await renderApp();
	await openPrivacy(setup);

	for (let index = 0; index < 5; index += 1) {
		await press(setup, { name: "down" });
	}
	await waitForFrame(setup, (frame) => frame.includes("OTLP endpoint"));
	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("Endpoint"));
	for (const character of "https://collector.example.test") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	const endpointSaved = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("https://collector.example.test")
	);
	expect(endpointSaved).toContain("OTLP endpoint");
	expect(core.stored.get("diagnostics-otlp-endpoint")).toBe(
		"https://collector.example.test"
	);

	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) => frame.includes("Diagnostics export"));
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Diagnostics export") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("diagnostics-export-enabled")).toBe("true");

	for (let index = 0; index < 3; index += 1) {
		await press(setup, { name: "down" });
	}
	await waitForFrame(setup, (frame) =>
		frame.includes("› Support-access duration")
	);
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("8 hours"));
	await press(setup, { name: "left" });
	await waitForFrame(setup, (frame) => frame.includes("1 hour"));
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("8 hours"));
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("24 hours"));
	await press(setup, { name: "left" });
	await waitForFrame(setup, (frame) => frame.includes("8 hours"));
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("Local support access"));
	await press(setup, { name: "return" });
	const supportEnabled = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("ON until")
	);
	expect(supportEnabled).toContain("Local support access");
	for (const label of [
		"Anonymous usage analytics",
		"Community stats",
		"Profile activity",
		"Crash reports",
		"Diagnostics export",
		"OTLP endpoint",
		"Content mode",
		"Support-access duration",
		"Local support access",
	]) {
		expect(supportEnabled).toContain(label);
	}
	const proofPath = process.env.RYU_CLI_PRIVACY_PROOF;
	if (proofPath) {
		writeFileSync(`${proofPath}.svg`, renderTerminalSvg(setup.captureSpans()));
		writeFileSync(`${proofPath}.txt`, supportEnabled);
		writeFileSync(
			`${proofPath}.requests.json`,
			JSON.stringify(core.requests, null, 2)
		);
	}
	const supportWrites = core.requests.filter(
		(item) =>
			item.method === "PUT" &&
			(item.path.endsWith("support-access-local-expiry") ||
				item.path.endsWith("support-access-local-enabled"))
	);
	expect(supportWrites.slice(0, 2).map((item) => item.path)).toEqual([
		"/api/preferences/support-access-local-expiry",
		"/api/preferences/support-access-local-enabled",
	]);
	expect(supportWrites.at(0)?.body?.value).toMatch(/^\d+$/);
	expect(Number(supportWrites[0]?.body?.value)).toBeGreaterThan(Date.now());
	expect(supportWrites[1]?.body?.value).toBe("true");
	for (const key of [
		"diagnostics-otlp-endpoint",
		"diagnostics-export-enabled",
		"support-access-local-expiry",
		"support-access-local-enabled",
	]) {
		const writeIndex = core.requests.findLastIndex(
			(item) => item.method === "PUT" && item.path === `/api/preferences/${key}`
		);
		expect(writeIndex).toBeGreaterThanOrEqual(0);
		expect(
			core.requests
				.slice(writeIndex + 1)
				.some(
					(item) =>
						item.method === "GET" && item.path === `/api/preferences/${key}`
				)
		).toBe(true);
	}
	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) =>
		frame.includes("› Support-access duration")
	);
	await press(setup, { name: "left" });
	const lockedDuration = await waitForFrame(setup, (frame) =>
		frame.includes("End the current grant before changing its duration.")
	);
	expect(lockedDuration).toContain("8 hours");
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame.includes("› Local support access")
	);
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Local support access") &&
			frame.includes("OFF") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(core.stored.get("support-access-local-enabled")).toBe("false");
	expect(
		core.requests.some(
			(item) => item.path === "/api/support-access/diagnostics"
		)
	).toBe(false);
});

test("Privacy saves the Community stats, Profile activity, and Crash reports choices and clears the OTLP endpoint", async () => {
	const core = installPrivacyCore();
	core.stored.set(
		"diagnostics-otlp-endpoint",
		"https://collector.example.test"
	);
	const setup = await renderApp();
	await openPrivacy(setup);

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Community stats"));
	await press(setup, { name: "return" });
	const communityOff = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Community stats") &&
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("OFF")
	);
	expect(communityOff).toContain("› Community stats");

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Profile activity"));
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("› Profile activity") &&
			frame.includes("Saved and confirmed from Core.") &&
			core.stored.get("profile-activity-enabled") === "false"
	);

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("› Crash reports"));
	await press(setup, { name: "return" });
	const crashReportsOff = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Crash reports") &&
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("OFF")
	);
	expect(crashReportsOff).toContain("› Crash reports");

	for (let index = 0; index < 2; index += 1) {
		await press(setup, { name: "down" });
	}
	await waitForFrame(setup, (frame) => frame.includes("› OTLP endpoint"));
	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("Endpoint"));
	await press(setup, { name: "return" });
	const endpointCleared = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("OTLP endpoint") &&
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("not set")
	);
	expect(endpointCleared).toContain("OTLP endpoint");
	expect(core.stored.get("community-stats-enabled")).toBe("false");
	expect(core.stored.get("profile-activity-enabled")).toBe("false");
	expect(core.stored.get("crash-reports-enabled")).toBe("false");
	expect(core.stored.get("diagnostics-otlp-endpoint")).toBe("");
	expect(
		core.requests
			.filter((item) => item.method === "PUT")
			.map((item) => [item.path, item.body?.value])
	).toEqual([
		["/api/preferences/community-stats-enabled", "false"],
		["/api/preferences/profile-activity-enabled", "false"],
		["/api/preferences/crash-reports-enabled", "false"],
		["/api/preferences/diagnostics-otlp-endpoint", ""],
	]);
});

test("Privacy load failure stays visible and r retries the canonical Core reads", async () => {
	const core = installPrivacyCore({ failFirstCrashRead: true });
	const setup = await renderApp();
	const failed = await openPrivacy(setup);
	expect(failed).toContain("Couldn't load privacy preferences");
	expect(core.requests.some((item) => item.method === "PUT")).toBe(false);

	await press(setup, { name: "r" });
	const recovered = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Anonymous usage analytics") &&
			frame.includes("Community stats") &&
			!frame.includes("Couldn't load privacy preferences")
	);
	expect(recovered).toContain("OFF · opt-in");
	expect(
		core.requests.filter(
			(item) =>
				item.path === "/api/preferences/crash-reports-enabled" &&
				item.method === "GET"
		).length
	).toBe(2);
});

test("Privacy arrows move rows while j/k change Settings panels", async () => {
	const core = installPrivacyCore();
	const setup = await renderApp();
	const initial = await openPrivacy(setup);
	expect(initial).toContain("› Anonymous usage analytics");
	expect(initial).toContain("j/k change Settings panels");

	await press(setup, { name: "j" });
	const nextPanel = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("› Storage") &&
			frame.includes("/isolated/privacy-storage-readback")
	);
	expect(nextPanel).not.toContain("Anonymous usage analytics");
	expect(nextPanel).toContain(
		"The data folder this node uses and its disk usage."
	);
	expect(
		core.requests.filter((item) => item.path === "/api/data-path")
	).toEqual([{ method: "GET", path: "/api/data-path" }]);
	await press(setup, { name: "k" });
	const privacyPanel = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("› Privacy") && frame.includes("Anonymous usage analytics")
	);
	expect(privacyPanel).toContain("Privacy");
	await press(setup, { name: "down" });
	const nextRow = await waitForFrame(setup, (frame) =>
		frame.includes("› Community stats")
	);
	expect(nextRow).toContain("Anonymous usage analytics");
	await press(setup, { name: "up" });
	const originalRow = await waitForFrame(setup, (frame) =>
		frame.includes("› Anonymous usage analytics")
	);
	expect(originalRow).toContain("Community stats");

	for (const label of [
		"Community stats",
		"Profile activity",
		"Crash reports",
		"Diagnostics export",
		"OTLP endpoint",
		"Content mode",
		"Support-access duration",
		"Local support access",
	]) {
		await press(setup, { name: "down" });
		const selectedFrame = await waitForFrame(setup, (frame) =>
			frame.includes(`› ${label}`)
		);
		expect(selectedFrame).toContain("Anonymous usage analytics");
		expect(selectedFrame).toContain("Local support access");
	}

	expect(core.requests.filter((item) => item.method === "PUT")).toHaveLength(0);
});

function settingsCardText(frame: string): string {
	return frame
		.split("\n")
		.map((line) => (line.split("│")[1] ?? "").split("█").at(-1) ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

test("Privacy rejects an acknowledged write without matching Core readback and retries the exact original choice", async () => {
	const core = installPrivacyCore({ ignoreFirstAnalyticsWrite: true });
	core.stored.set("product-analytics-enabled", "true");
	const setup = await renderApp();
	await openPrivacy(setup);
	await press(setup, { name: "return" });
	const failed = await waitForFrame(setup, (frame) =>
		settingsCardText(frame).includes(
			"Core did not confirm product-analytics-enabled"
		)
	);
	expect(settingsCardText(failed)).toContain(
		"Couldn't save the analytics choice"
	);
	expect(failed).not.toContain("Saved and confirmed from Core.");
	expect(failed).toContain("ON");
	expect(core.stored.get("product-analytics-enabled")).toBe("true");
	await press(setup, { name: "r" });
	const recovered = await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);
	expect(recovered).not.toContain("Core did not confirm");
	expect(core.stored.get("product-analytics-enabled")).toBe("false");
	expect(
		core.requests
			.filter((entry) => entry.path.endsWith("product-analytics-enabled"))
			.map((entry) => [entry.method, entry.body?.value])
	).toEqual([
		["GET", undefined],
		["PUT", "false"],
		["GET", undefined],
		["PUT", "false"],
		["GET", undefined],
	]);
});

test("Privacy never enables support after a denied expiry write and retries the same bounded grant before enabling", async () => {
	const core = installPrivacyCore({ failFirstSupportExpiryWrite: true });
	const setup = await renderApp();
	await openPrivacy(setup);
	for (let index = 0; index < 8; index += 1) {
		await press(setup, { name: "down" });
	}
	await waitForFrame(setup, (frame) =>
		frame.includes("› Local support access")
	);
	await press(setup, { name: "return" });
	const denied = await waitForFrame(setup, (frame) =>
		settingsCardText(frame).includes("Couldn't save granting support access")
	);
	expect(denied).not.toContain("Saved and confirmed from Core.");
	expect(denied).not.toContain("ON until");
	expect(core.stored.has("support-access-local-enabled")).toBe(false);
	expect(core.stored.has("support-access-local-expiry")).toBe(false);
	const failedWrites = core.requests.filter((entry) => entry.method === "PUT");
	expect(failedWrites).toHaveLength(1);
	expect(failedWrites[0]?.path).toBe(
		"/api/preferences/support-access-local-expiry"
	);
	const requestedExpiry = Number(failedWrites[0]?.body?.value);
	expect(requestedExpiry).toBeGreaterThan(Date.now());
	expect(requestedExpiry).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
	await press(setup, { name: "r" });
	const recovered = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Saved and confirmed from Core.") &&
			frame.includes("ON until")
	);
	expect(recovered).not.toContain("Couldn't save");
	const grantRequests = core.requests.filter(
		(entry) =>
			entry.path.endsWith("support-access-local-expiry") ||
			entry.path.endsWith("support-access-local-enabled")
	);
	expect(
		grantRequests
			.slice(2)
			.map((entry) => [entry.method, entry.path, entry.body?.value])
	).toEqual([
		[
			"PUT",
			"/api/preferences/support-access-local-expiry",
			String(requestedExpiry),
		],
		[
			"PUT",
			"/api/preferences/support-access-local-expiry",
			String(requestedExpiry),
		],
		["PUT", "/api/preferences/support-access-local-enabled", "true"],
		["GET", "/api/preferences/support-access-local-expiry", undefined],
		["GET", "/api/preferences/support-access-local-enabled", undefined],
	]);
	expect(core.stored.get("support-access-local-expiry")).toBe(
		String(requestedExpiry)
	);
	expect(core.stored.get("support-access-local-enabled")).toBe("true");
	expect(
		core.requests.some((entry) => entry.path.startsWith("/api/support-access/"))
	).toBe(false);
});

test("Privacy toggles the OTLP content mode and sends a test span on t", async () => {
	const core = installPrivacyCore();
	const setup = await renderApp();
	await openPrivacy(setup);
	for (let index = 0; index < 6; index += 1) {
		await press(setup, { name: "down" });
	}
	const metadataOnly = await waitForFrame(setup, (frame) =>
		frame.includes("› Content mode")
	);
	expect(metadataOnly).toContain("Metadata only");
	await press(setup, { name: "return" });
	const fullContent = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Full content") &&
			frame.includes("Saved and confirmed from Core.")
	);
	expect(fullContent).toContain("leave this device");
	expect(core.stored.get("diagnostics-otlp-content-mode")).toBe("content");

	await press(setup, { name: "t" });
	const sent = await waitForFrame(setup, (frame) =>
		settingsCardText(frame).includes("Test span sent")
	);
	expect(settingsCardText(sent)).toContain("ryu.test");
	expect(
		core.requests.filter(
			(item) =>
				item.method === "POST" &&
				item.path === "/api/diagnostics/otlp/test-span"
		)
	).toHaveLength(1);
});
