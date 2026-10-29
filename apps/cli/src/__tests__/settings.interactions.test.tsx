/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import { runsOnEnter } from "../core/autocomplete.ts";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";

// Complete envelopes published by terminal theme preference and account switch owners.
const preferenceWriteFields = z.looseObject({ value: z.string() });
const preferenceWriteObservation = z.custom<
	z.infer<typeof preferenceWriteFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		preferenceWriteFields.safeParse(value).success
);
const accountSwitchFields = z.looseObject({ userId: z.string() });
const accountSwitchObservation = z.custom<z.infer<typeof accountSwitchFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		accountSwitchFields.safeParse(value).success
);
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-contributed-command-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});

function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
		configDir = undefined;
	}
});

interface KeyInput {
	ctrl?: boolean;
	name: string;
	shift?: boolean;
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
				shift: key.shift ?? false,
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
	maxFrames = 40
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Settings render did not match: ${frame}`);
	}
	return frame;
}

/** The first Enter accepts a slash completion and the second runs it, except
 * for a bare no-argument built-in such as `/new`, which runs on the first. */
function needsSecondEnter(value: string): boolean {
	const trimmed = value.trim();
	const name = trimmed.slice(1);
	return (
		trimmed.startsWith("/") &&
		!name.includes(" ") &&
		!runsOnEnter(trimmed, { description: "", kind: "command", name })
	);
}

async function typeAndSubmit(setup: Setup, value: string): Promise<void> {
	await act(async () => {
		await setup.mockInput.typeText(value);
	});
	await setup.flush({ maxPasses: 12 });
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await setup.renderOnce();
	if (needsSecondEnter(value)) {
		await setup.flush({ maxPasses: 12 });
		await act(async () => {
			setup.mockInput.pressEnter();
		});
		await setup.renderOnce();
	}
}

async function openSettings(setup: Setup): Promise<string> {
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	return waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
}

function selectedRow(frame: string, label: string): boolean {
	return frame.split("\n").some((row) => row.includes(`› ${label}`));
}

async function selectSettingsPanel(
	setup: Setup,
	label: string
): Promise<string> {
	for (let step = 0; step < 30; step += 1) {
		const frame = setup.captureCharFrame();
		if (selectedRow(frame, label)) {
			return frame;
		}
		await press(setup, { name: "j" });
		await setup.flush({ maxPasses: 12 });
	}
	throw new Error(
		`Settings panel ${label} was not reachable: ${setup.captureCharFrame()}`
	);
}

test("Appearance guides users to /theme, validates loaded preferences, and persists a choice across reload", async () => {
	let storedPreference: z.infer<typeof appRequestValueSchema> = {
		mode: "unsupported-mode",
		preset: "unsupported-preset",
	};
	let preferenceReads = 0;
	const writes: string[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/preferences/terminal-theme") {
			if (init?.method === "PUT") {
				const body = preferenceWriteObservation.parse(
					JSON.parse(String(init.body))
				);
				writes.push(body.value);
				storedPreference = body.value;
				return Response.json({ value: storedPreference });
			}
			preferenceReads += 1;
			return Response.json({ value: storedPreference });
		}
		return Response.json({});
	});

	const initialSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = initialSetup;
	await initialSetup.renderOnce();
	await waitForFrame(initialSetup, (frame) => frame.includes("› Message"));
	await waitForFrame(initialSetup, () => preferenceReads > 0);

	await openSettings(initialSetup);
	await press(initialSetup, { name: "down" });
	await press(initialSetup, { name: "down" });
	const appearance = await waitForFrame(initialSetup, (frame) =>
		frame.includes("Terminal appearance follows")
	);
	expect(appearance).toContain("Use /theme in Chat");
	await press(initialSetup, { name: "escape" });
	await waitForFrame(initialSetup, (frame) => !frame.includes("Esc close"));
	expect(writes).toHaveLength(0);

	await typeAndSubmit(initialSetup, "/theme");
	const defaultChoice = await waitForFrame(initialSetup, (frame) =>
		frame.includes("› System (terminal)")
	);
	expect(defaultChoice).toContain("› System (terminal)");
	for (let step = 0; step < 4; step += 1) {
		await press(initialSetup, { name: "down" });
	}
	await waitForFrame(initialSetup, (frame) => frame.includes("› Ryu Mono"));
	await press(initialSetup, { name: "return" });
	await waitForFrame(initialSetup, (frame) => !frame.includes("Esc cancel"));
	await waitForFrame(initialSetup, () => writes.length === 1);
	expect(writes).toEqual(['{"mode":"system","preset":"ryu-mono"}']);

	await act(async () => {
		initialSetup.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	const reloadedSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = reloadedSetup;
	await reloadedSetup.renderOnce();
	await waitForFrame(reloadedSetup, (frame) => frame.includes("› Message"));
	await waitForFrame(reloadedSetup, () => preferenceReads > 1);
	await typeAndSubmit(reloadedSetup, "/theme");
	const restoredChoice = await waitForFrame(
		reloadedSetup,
		(frame) =>
			frame.includes("› System (terminal)") && frame.includes("● Ryu Mono")
	);
	expect(restoredChoice).toContain("● Ryu Mono");
	await press(reloadedSetup, { name: "escape" });
	await waitForFrame(reloadedSetup, (frame) => !frame.includes("Esc cancel"));
	expect(writes).toHaveLength(1);
});

test("Settings Account retries a failed read and separates account selection from panel navigation", async () => {
	let failNextAuthStatus = false;
	let authStatusReads = 0;
	let activeUserId = "alpha";
	const accountSwitches: Array<{ userId: string }> = [];
	const accounts = [
		{ userId: "alpha", name: "Alpha One", email: "alpha@example.test" },
		{ userId: "beta", name: "Beta Two", email: "beta@example.test" },
	];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname === "/api/preferences/terminal-theme") {
			return Response.json({ value: { mode: "system", preset: "ryu" } });
		}
		if (url.pathname === "/api/auth/status") {
			authStatusReads += 1;
			if (failNextAuthStatus) {
				failNextAuthStatus = false;
				return Response.json(
					{ message: "Temporary Core outage" },
					{ status: 503 }
				);
			}
			// Core's /api/auth/status publisher always serializes all five fields.
			return Response.json({
				authenticated: true,
				pending: false,
				token: `${activeUserId}-token`,
				userCode: null,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/auth/accounts") {
			return Response.json({
				accounts: accounts.map((account) => ({
					...account,
					active: account.userId === activeUserId,
				})),
				activeUserId,
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			const active = accounts.find(
				(account) => account.userId === activeUserId
			);
			return Response.json({
				user: active
					? {
							name: active.name,
							email: active.email,
							emailVerified: true,
							twoFactorEnabled: false,
						}
					: null,
			});
		}
		if (url.pathname === "/api/user/password-status") {
			return Response.json({ hasPassword: true, authMethod: "password" });
		}
		if (url.pathname === "/api/billing/subscription-status") {
			return Response.json({
				status: "active",
				plan: "pro",
				interval: "month",
			});
		}
		if (url.pathname === "/api/sessions") {
			return Response.json({ sessions: [] });
		}
		if (url.pathname === "/api/auth/accounts/switch" && method === "POST") {
			const body = accountSwitchObservation.parse(
				JSON.parse(String(init?.body))
			);
			accountSwitches.push(body);
			activeUserId = body.userId;
			return Response.json({ success: true });
		}
		return Response.json({});
	});

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("› Message"));
	await waitForFrame(setup, () => authStatusReads > 0);
	await openSettings(setup);
	await selectSettingsPanel(setup, "Profile");
	failNextAuthStatus = true;
	await press(setup, { name: "down" });
	const failedAccountRead = await waitForFrame(setup, (frame) =>
		frame.includes("/api/auth/status failed: 503")
	);
	expect(failedAccountRead).toContain("Settings");
	const readsBeforeRetry = authStatusReads;
	await press(setup, { name: "r" });
	const loadedAccounts = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Accounts") &&
			frame.includes("Alpha One") &&
			frame.includes("Beta Two")
	);
	expect(authStatusReads).toBeGreaterThan(readsBeforeRetry);
	expect(
		loadedAccounts.split("\n").find((row) => row.includes("Alpha One"))
	).toContain("›");

	await press(setup, { name: "down" });
	const selectedBeta = await waitForFrame(setup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("Beta Two") && row.includes("›"))
	);
	expect(selectedRow(selectedBeta, "Account")).toBe(true);
	await press(setup, { name: "j" });
	const sessionsPanel = await waitForFrame(setup, (frame) =>
		selectedRow(frame, "Sessions")
	);
	expect(sessionsPanel).toContain("Sessions & devices");
	await press(setup, { name: "k" });
	await waitForFrame(
		setup,
		(frame) => selectedRow(frame, "Account") && frame.includes("Beta Two")
	);
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("Beta Two") && row.includes("›"))
	);
	await press(setup, { name: "s" });
	const switched = await waitForFrame(
		setup,
		(frame) => frame.includes("Beta Two") && frame.includes("✓ active")
	);
	expect(switched).toContain("Accounts");
	expect(accountSwitches).toEqual([{ userId: "beta" }]);

	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => !frame.includes("Esc close"));
});
