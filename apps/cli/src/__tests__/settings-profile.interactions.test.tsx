/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";
import { MIN_TEXT_CONTRAST, renderedContrast } from "./color-contrast.ts";

// Actual settings/profile.tsx publishes the complete name-only request.
const profileNameFieldsSchema = z.looseObject({ name: z.string() });
type ProfileNameRequestObservation = z.infer<typeof profileNameFieldsSchema>;
const profileNameRequestObservationSchema =
	z.custom<ProfileNameRequestObservation>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			profileNameFieldsSchema.safeParse(value).success
	);
interface ProfileNameWriteObservation {
	authorization: string | null;
	body: ProfileNameRequestObservation;
}
interface ProfileWriteObservation {
	body: z.infer<typeof appResponseValueSchema>;
	method: string;
}

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

const originalAuthUrl = process.env.RYU_AUTH_URL;

beforeEach(() => {
	// These flows use a configured local account service. The unconfigured
	// loopback default is never sent account credentials (core/authBackend.ts).
	process.env.RYU_AUTH_URL = "http://localhost:3000";
});

afterEach(() => {
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
});

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
	maxFrames = 40
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(
			`Settings Profile render did not match ${predicate.toString()}: ${frame}`
		);
	}
	return frame;
}

async function openSettings(setup: Setup): Promise<void> {
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
}

async function clickText(setup: Setup, label: string): Promise<void> {
	const rows = setup.captureCharFrame().split("\n");
	const rowIndex = rows.findIndex((row) => row.includes(label));
	const columnIndex = rows[rowIndex]?.indexOf(label) ?? -1;
	if (rowIndex < 0 || columnIndex < 0) {
		throw new Error(`Could not find ${label} in:\n${rows.join("\n")}`);
	}
	await act(async () => {
		await setup.mockMouse.click(columnIndex, rowIndex);
	});
	await setup.flush({ maxPasses: 12 });
}

async function focusProfilePanel(setup: Setup): Promise<void> {
	for (let step = 0; step < 6; step += 1) {
		await press(setup, { name: "down" });
	}
	// Memory owns Up/Down for its rows; use the documented panel shortcut to
	// continue to Profile without changing a Memory preference.
	for (let step = 0; step < 4; step += 1) {
		await press(setup, { name: "j" });
	}
}

async function selectProfile(setup: Setup): Promise<string> {
	await focusProfilePanel(setup);
	return waitForFrame(setup, (frame) =>
		frame.includes("Your Ryu account profile")
	);
}

test("Settings Profile edits the authenticated account name through the existing profile API", async () => {
	let savedName = "Alex Example";
	let sessionReads = 0;
	let passwordStatusReads = 0;
	const nameUpdates: ProfileNameWriteObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname === "/api/preferences/terminal-theme") {
			return Response.json({
				value: { mode: "system", preset: "ryu" },
			});
		}
		if (url.pathname === "/api/auth/status") {
			return Response.json({
				authenticated: true,
				token: "profile-token",
				pending: false,
				userCode: null,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			sessionReads += 1;
			return Response.json({
				user: {
					name: savedName,
					email: "alex@example.test",
					emailVerified: true,
					id: "profile-user",
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					image: null,
				},
				session: {
					id: "profile-session",
					userId: "profile-user",
					token: "profile-token",
					expiresAt: "2030-09-01T10:00:00.000Z",
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					ipAddress: null,
					userAgent: null,
				},
			});
		}
		if (url.pathname === "/api/profile/name" && method === "PUT") {
			const body = profileNameRequestObservationSchema.parse(
				JSON.parse(String(init?.body))
			);
			nameUpdates.push({
				authorization: new Headers(init?.headers).get("authorization"),
				body,
			});
			savedName = body.name;
			return Response.json({
				success: true,
				name: savedName,
				message: "Your name was updated.",
			});
		}
		if (url.pathname === "/api/user/password-status") {
			passwordStatusReads += 1;
			return Response.json({ hasPassword: true, authMethod: "password" });
		}
		return Response.json({});
	});

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	const initialProfile = await selectProfile(setup);
	expect(initialProfile).toContain("Alex Example");
	expect(initialProfile).toContain("alex@example.test");
	expect(initialProfile).not.toContain("Password");
	expect(initialProfile).not.toContain("Two-factor");
	expect(initialProfile).not.toContain("Accounts");
	expect(sessionReads).toBeGreaterThan(0);
	expect(passwordStatusReads).toBe(0);

	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("Type to edit"));
	await act(async () => {
		await setup.mockInput.typeText(" jobs", 30);
	});
	await setup.flush({ maxPasses: 12 });
	const edited = await waitForFrame(setup, (frame) =>
		frame.includes("Example jobs")
	);
	expect(edited).toContain("› Profile");
	await press(setup, { name: "return" });
	const saved = await waitForFrame(setup, (frame) =>
		frame.includes("Display name updated.")
	);
	expect(saved).toContain("Alex Example jobs");
	expect(nameUpdates).toEqual([
		{
			authorization: "Bearer profile-token",
			body: { name: "Alex Example jobs" },
		},
	]);
	expect(passwordStatusReads).toBe(0);

	await press(setup, { name: "escape" });
	await waitForFrame(setup, (frame) => !frame.includes("Esc close"));
});

test("Settings Profile Edit and Save controls write the name from the rendered panel", async () => {
	let savedName = "Sam Person";
	const writes: Array<{ method: string; name: string }> = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/preferences/terminal-theme") {
			return Response.json({ value: { mode: "system", preset: "ryu" } });
		}
		if (url.pathname === "/api/auth/status") {
			return Response.json({
				authenticated: true,
				token: "profile-token",
				pending: false,
				userCode: null,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			return Response.json({
				user: {
					name: savedName,
					email: "sam@example.test",
					id: "profile-user",
					emailVerified: true,
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					image: null,
				},
				session: {
					id: "profile-session",
					userId: "profile-user",
					token: "profile-token",
					expiresAt: "2030-09-01T10:00:00.000Z",
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					ipAddress: null,
					userAgent: null,
				},
			});
		}
		if (url.pathname === "/api/profile/name") {
			const body = profileNameRequestObservationSchema.parse(
				JSON.parse(String(init?.body))
			);
			writes.push({ method: init?.method ?? "GET", name: body.name });
			savedName = body.name;
			return Response.json({
				success: true,
				name: savedName,
				message: "Your name was updated.",
			});
		}
		return Response.json({});
	});

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await selectProfile(setup);
	await waitForFrame(
		setup,
		(frame) => frame.includes("Sam Person") && frame.includes("Edit")
	);
	await clickText(setup, "Edit");
	await waitForFrame(setup, (frame) => frame.includes("Type to edit"));
	await act(async () => {
		await setup.mockInput.typeText(" Jr", 30);
	});
	await setup.flush({ maxPasses: 12 });
	await waitForFrame(setup, (frame) => frame.includes("Person Jr"));
	await clickText(setup, "Save");
	const saved = await waitForFrame(setup, (frame) =>
		frame.includes("Display name updated.")
	);
	expect(saved).toContain("Sam Person Jr");
	expect(writes).toEqual([{ method: "PUT", name: "Sam Person Jr" }]);
	await press(setup, { name: "escape" });
});

test("Settings Profile cancel and unchanged save do not write the account name", async () => {
	const writes: ProfileWriteObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/preferences/terminal-theme") {
			return Response.json({ value: { mode: "system", preset: "ryu" } });
		}
		if (url.pathname === "/api/auth/status") {
			return Response.json({
				authenticated: true,
				token: "profile-token",
				pending: false,
				userCode: null,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			return Response.json({
				user: {
					name: "Casey Example",
					email: "casey@example.test",
					id: "profile-user",
					emailVerified: true,
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					image: null,
				},
				session: {
					id: "profile-session",
					userId: "profile-user",
					token: "profile-token",
					expiresAt: "2030-09-01T10:00:00.000Z",
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					ipAddress: null,
					userAgent: null,
				},
			});
		}
		if (url.pathname === "/api/profile/name") {
			writes.push({
				body: init?.body
					? appResponseValueSchema.parse(JSON.parse(String(init.body)))
					: undefined,
				method: init?.method ?? "GET",
			});
			return Response.json({
				success: true,
				name: "Casey Example",
				message: "Your name was updated.",
			});
		}
		return Response.json({});
	});

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await selectProfile(setup);
	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("Type to edit"));
	expect(
		renderedContrast(setup.captureSpans(), "Cancel")
	).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
	await clickText(setup, "Cancel");
	const cancelled = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Casey Example") && frame.includes("e or click Edit")
	);
	expect(cancelled).toContain("casey@example.test");
	expect(writes).toHaveLength(0);

	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("Type to edit"));
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("e or click Edit"));
	expect(writes).toHaveLength(0);
});

test("Settings Profile retries a failed session read without showing Account security controls", async () => {
	let failSessionRead = true;
	let sessionReads = 0;
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/preferences/terminal-theme") {
			return Response.json({ value: { mode: "system", preset: "ryu" } });
		}
		if (url.pathname === "/api/auth/status") {
			return Response.json({
				authenticated: true,
				token: "profile-token",
				pending: false,
				userCode: null,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			sessionReads += 1;
			if (failSessionRead) {
				failSessionRead = false;
				return Response.json(
					{ message: "Temporary auth outage" },
					{ status: 503 }
				);
			}
			return Response.json({
				user: {
					name: "Taylor Person",
					email: "taylor@example.test",
					id: "profile-user",
					emailVerified: true,
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					image: null,
				},
				session: {
					id: "profile-session",
					userId: "profile-user",
					token: "profile-token",
					expiresAt: "2030-09-01T10:00:00.000Z",
					createdAt: "2026-09-01T10:00:00.000Z",
					updatedAt: "2026-09-01T10:00:00.000Z",
					ipAddress: null,
					userAgent: null,
				},
			});
		}
		return Response.json({});
	});

	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await setup.renderOnce();
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await focusProfilePanel(setup);
	const failed = await waitForFrame(setup, (frame) =>
		frame.includes("Could not load profile:")
	);
	expect(failed).toContain("Press r to retry.");
	await press(setup, { name: "r" });
	const loaded = await waitForFrame(setup, (frame) =>
		frame.includes("Taylor Person")
	);
	expect(loaded).toContain("taylor@example.test");
	expect(sessionReads).toBeGreaterThanOrEqual(2);
	await press(setup, { name: "escape" });
});
