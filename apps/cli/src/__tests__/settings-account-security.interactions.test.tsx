/* @jsxImportSource @opentui/react */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { act } from "react";
import type { core } from "zod";
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
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-cli-account-security-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});
const proofDirectory = mkdtempSync(join(tmpdir(), "ryu-cli-account-proof-"));
const photoFile = join(proofDirectory, "avatar.png");
afterAll(() => rmSync(proofDirectory, { recursive: true, force: true }));
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
	rmSync(photoFile, { force: true });
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
	const modifiers = { ctrl: key.ctrl ?? false };
	await act(async () => {
		switch (key.name) {
			case "return":
				setup.mockInput.pressEnter(modifiers);
				break;
			case "tab":
				setup.mockInput.pressTab(modifiers);
				break;
			case "backspace":
				setup.mockInput.pressBackspace(modifiers);
				break;
			case "down":
			case "left":
			case "right":
				setup.mockInput.pressArrow(key.name, modifiers);
				break;
			default:
				setup.mockInput.pressKey(key.name, modifiers);
		}
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
		throw new Error(`Settings Profile render did not match: ${frame}`);
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

const CACHE_RESET_TITLE = "Apply now? This resets the prompt cache";

/** Enter on a changed personal context opens the prompt-cache confirm. */
async function saveThroughCacheConfirm(setup: Setup): Promise<void> {
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes(CACHE_RESET_TITLE) &&
			frame.includes("About you is part of the system prompt")
	);
	await press(setup, { name: "y" });
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

// Cells captured by the existing native JSON.parse branch or FormData.get
// multipart branch; no extra parser or field admission is introduced here.
type CapturedRequestBodyCell = core.util.JSONType | ReturnType<FormData["get"]>;
interface Call {
	authorization: string | null;
	body: Record<string, CapturedRequestBodyCell>;
	method: string;
	path: string;
}
function installAccountFixture(
	options: {
		hasPassword?: boolean;
		methods?: string[];
		denyContextRead?: boolean;
	} = {}
) {
	const calls: Call[] = [];
	let hasActive = false;
	let hasPassword = options.hasPassword ?? false;
	let newEmail = "";
	let enabled = false;
	let denyVerify = true;
	let avatarId: string | null = null;
	let denyPhoto = true;
	let denyContext = true;
	let denyContextRead = options.denyContextRead ?? false;
	let context = JSON.stringify({
		nickname: "Fixture",
		occupation: "Writer",
		aboutYou: "Local context",
		aboutOrganization: "Fixture organization",
	});
	const fixtureFetch = async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body =
			init?.body instanceof FormData
				? { file: init.body.get("avatar") }
				: init?.body
					? JSON.parse(String(init.body))
					: {};
		calls.push({
			path: url.pathname,
			method,
			body,
			authorization: new Headers(init?.headers).get("authorization"),
		});
		if (url.pathname === "/api/auth/status") {
			return Response.json({
				authenticated: true,
				pending: false,
				userCode: null,
				verificationUri: null,
				token: "security-fixture-token",
			});
		}
		if (url.pathname === "/api/auth/accounts") {
			return Response.json({ accounts: [] });
		}
		if (url.pathname === "/api/auth/get-session") {
			return Response.json({
				user: {
					id: "fixture",
					name: "Fixture",
					email: "fixture@example.test",
					emailVerified: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					twoFactorEnabled: enabled,
					avatarId,
				},
				session: {
					id: "fixture-session",
					userId: "fixture",
					token: "security-fixture-token",
					expiresAt: "2027-01-01T00:00:00.000Z",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			});
		}
		if (url.pathname === "/api/profile/avatar") {
			if (denyPhoto && method === "POST") {
				denyPhoto = false;
				return Response.json({ error: "Forbidden" }, { status: 403 });
			}
			avatarId = method === "POST" ? "fixture-avatar-id" : null;
			return Response.json({
				success: true,
				avatarId,
				message: "Profile photo removed.",
			});
		}
		if (url.pathname === "/api/user/password-status") {
			return Response.json({
				hasPassword,
				provider: "credential",
				authMethod: "password",
			});
		}
		if (url.pathname === "/api/user/email-change-status") {
			return Response.json({
				hasActive,
				message: "No active email change requests",
				emailChange: hasActive
					? {
							id: "fixture-email-change",
							newEmail,
							oldEmail: "fixture@example.test",
							status: "pending",
							statusMessage: "Awaiting confirmation",
							createdAt: "2026-01-01T00:00:00.000Z",
							expiresAt: "2027-01-01T00:00:00.000Z",
						}
					: null,
			});
		}
		if (url.pathname === "/api/step-up/status") {
			return Response.json({
				satisfied: false,
				action: "change your account security settings",
				enrolmentRequired: false,
				passwordAvailable: hasPassword,
				scope: "account.security",
				twoFactorEnabled: enabled,
				windowMs: 300_000,
				methods: options.methods ?? ["magic-link"],
			});
		}
		if (url.pathname === "/api/step-up/challenge") {
			return Response.json({ sent: true });
		}
		if (url.pathname === "/api/step-up/verify") {
			if (denyVerify) {
				denyVerify = false;
				return Response.json({ error: "Invalid token" }, { status: 401 });
			}
			return Response.json({
				verified: true,
				scope: "account.security",
				expiresAt: "2027-01-01T00:00:00.000Z",
			});
		}
		if (url.pathname === "/api/user/set-password") {
			const action = hasPassword ? "changed" : "set";
			hasPassword = true;
			return Response.json({
				success: true,
				action,
				message: "Your password was successfully updated.",
			});
		}
		if (url.pathname === "/api/user/initiate-email-change") {
			hasActive = true;
			newEmail = String(body.newEmail);
			return Response.json({
				success: true,
				message: "Account update confirmed.",
			});
		}
		if (url.pathname === "/api/user/cancel-email-change") {
			hasActive = false;
			return Response.json({
				success: true,
				message: "Account update confirmed.",
			});
		}
		if (url.pathname === "/api/user/resend-verification") {
			return Response.json({
				success: true,
				message: "Account update confirmed.",
			});
		}
		if (url.pathname === "/api/auth/two-factor/enable") {
			return Response.json({
				method: "totp",
				totpURI: "otpauth://totp/Fixture?secret=FIXTUREONLY",
				backupCodes: ["FIXTURE-ONLY"],
			});
		}
		if (url.pathname === "/api/auth/two-factor/verify-totp") {
			enabled = true;
			return Response.json({
				token: "security-fixture-token",
				user: {
					id: "fixture",
					name: "Fixture",
					email: "fixture@example.test",
					emailVerified: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					twoFactorEnabled: enabled,
					avatarId,
				},
				backupCodes: ["FIXTURE-ONLY"],
			});
		}
		if (url.pathname === "/api/auth/two-factor/generate-backup-codes") {
			return Response.json({ status: true, backupCodes: ["SECOND-FIXTURE"] });
		}
		if (url.pathname === "/api/auth/two-factor/disable") {
			enabled = false;
			return Response.json({ status: true });
		}
		if (url.pathname === "/api/preferences/user-personalization") {
			if (method === "GET" && denyContextRead) {
				denyContextRead = false;
				return Response.json(
					{ error: "Context read unavailable" },
					{ status: 503 }
				);
			}
			if (method === "PUT") {
				if (denyContext) {
					denyContext = false;
					return Response.json({ error: "Forbidden" }, { status: 403 });
				}
				context = String(body.value);
			}
			return Response.json({ key: "user-personalization", value: context });
		}
		return Response.json({});
	};
	globalThis.fetch = new Proxy(realFetch, {
		apply(_target, _receiver, argumentsList) {
			return fixtureFetch(argumentsList[0], argumentsList[1]);
		},
	});
	return {
		calls,
		get context() {
			return context;
		},
	};
}
async function openAccount(setup: Setup) {
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	// General → Account is ten panel steps now that Island is not a CLI panel.
	for (let index = 0; index < 10; index++) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(setup, (frame) => frame.includes("Account security"));
}
async function typeKeys(setup: Setup, value: string) {
	for (const character of value) {
		await press(setup, { name: character });
	}
}
async function saveProof(setup: Setup, name: string) {
	const proofPath = join(proofDirectory, name);
	mkdirSync(dirname(proofPath), { recursive: true });
	await Bun.write(`${proofPath}.txt`, setup.captureCharFrame());
	await Bun.write(`${proofPath}.svg`, renderTerminalSvg(setup.captureSpans()));
}
test("Account security uses mailbox step-up, cancel, denied verification/retry and password readback", async () => {
	const fixture = installAccountFixture();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 52,
	});
	testSetup = setup;
	await openAccount(setup);
	await press(setup, { name: "w" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verify identity: magic-link")
	);
	await press(setup, { name: "tab" });
	expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
		0
	);
	await press(setup, { name: "w" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verify identity: magic-link")
	);
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verification link requested.")
	);
	await typeKeys(setup, "fixture-link-token");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not complete action")
	);
	expect(
		fixture.calls.some((call) => call.path === "/api/user/set-password")
	).toBe(false);
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("New password"));
	await typeKeys(setup, "Fixture-password-1!");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Security update confirmed.")
	);
	const posts = fixture.calls.filter((call) => call.method === "POST");
	expect(posts.map((call) => ({ path: call.path, body: call.body }))).toEqual([
		{
			path: "/api/step-up/challenge",
			body: { scope: "account.security", method: "magic-link" },
		},
		{
			path: "/api/step-up/verify",
			body: {
				scope: "account.security",
				method: "magic-link",
				code: "fixture-link-token",
			},
		},
		{
			path: "/api/step-up/verify",
			body: {
				scope: "account.security",
				method: "magic-link",
				code: "fixture-link-token",
			},
		},
		{
			path: "/api/user/set-password",
			body: { newPassword: "Fixture-password-1!" },
		},
	]);
	expect(
		posts.every(
			(call) => call.authorization === "Bearer security-fixture-token"
		)
	).toBe(true);
	const writeIndex = fixture.calls.findIndex(
		(call) => call.path === "/api/user/set-password"
	);
	expect(
		fixture.calls
			.slice(writeIndex + 1)
			.some((call) => call.path === "/api/user/password-status")
	).toBe(true);
	await saveProof(setup, "password-confirmed");
}, 60_000);
test("Account email request, cancellation, verification resend and two-factor lifecycle use canonical bodies and readback", async () => {
	const fixture = installAccountFixture();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 52,
	});
	testSetup = setup;
	await openAccount(setup);
	await press(setup, { name: "u" });
	await waitForFrame(setup, (frame) => frame.includes("Verify identity"));
	await typeKeys(setup, "token");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Could not"));
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("New email address"));
	await typeKeys(setup, "new@example.test");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Changing to new@example.test")
	);
	await press(setup, { name: "c" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Email change cancellation confirmed.")
	);
	await press(setup, { name: "v" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verification email requested.")
	);
	await press(setup, { name: "t" });
	await waitForFrame(setup, (frame) => frame.includes("Current password"));
	await typeKeys(setup, "fixture-password");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Add this URI"));
	await typeKeys(setup, "123456");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Save these backup codes")
	);
	await press(setup, { name: "return" });
	await press(setup, { name: "b" });
	await waitForFrame(setup, (frame) => frame.includes("Current password"));
	await typeKeys(setup, "fixture-password");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("SECOND-FIXTURE"));
	await press(setup, { name: "return" });
	await press(setup, { name: "t" });
	await waitForFrame(setup, (frame) => frame.includes("Current password"));
	await typeKeys(setup, "fixture-password");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Security update confirmed.")
	);
	const posts = fixture.calls.filter((call) => call.method === "POST");
	expect(
		posts.find((call) => call.path === "/api/user/initiate-email-change")?.body
	).toEqual({ newEmail: "new@example.test" });
	expect(
		posts.find((call) => call.path === "/api/user/resend-verification")?.body
	).toEqual({ email: "fixture@example.test" });
	for (const path of ["enable", "generate-backup-codes", "disable"]) {
		expect(
			posts.find((call) => call.path === `/api/auth/two-factor/${path}`)?.body
		).toEqual({ password: "fixture-password" });
	}
	expect(
		posts.find((call) => call.path === "/api/auth/two-factor/verify-totp")?.body
	).toEqual({ code: "123456" });
	expect(
		posts.every(
			(call) => call.authorization === "Bearer security-fixture-token"
		)
	).toBe(true);
	await saveProof(setup, "security-lifecycle-confirmed");
}, 60_000);
test("Profile personal context cancels without write and retries denied persistence with exact Core readback", async () => {
	const fixture = installAccountFixture();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await selectProfile(setup);
	await press(setup, { name: "p" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Cancel personal context")
	);
	await clickText(setup, "Cancel personal context");
	expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	await press(setup, { name: "p" });
	await act(async () => {
		await setup.mockInput.typeText(" Nick", 30);
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes(CACHE_RESET_TITLE));
	await press(setup, { name: "n" });
	const kept = await waitForFrame(
		setup,
		(frame) =>
			!frame.includes(CACHE_RESET_TITLE) &&
			frame.includes("Cancel personal context")
	);
	expect(kept).toContain("Nick");
	expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	expect(JSON.parse(fixture.context).nickname).toBe("Fixture");
	await saveThroughCacheConfirm(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not save personal context")
	);
	expect(JSON.parse(fixture.context).nickname).toBe("Fixture");
	await saveThroughCacheConfirm(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Personal context saved and confirmed.")
	);
	expect(JSON.parse(fixture.context)).toEqual({
		nickname: "Fixture Nick",
		occupation: "Writer",
		aboutYou: "Local context",
		aboutOrganization: "Fixture organization",
	});
	const writes = fixture.calls.filter((call) => call.method === "PUT");
	expect(writes).toHaveLength(2);
	expect(
		writes.every(
			(call) =>
				call.path === "/api/preferences/user-personalization" &&
				call.authorization === null
		)
	).toBe(true);
	expect(fixture.calls.at(-1)?.method).toBe("GET");
	await saveProof(setup, "personal-context-confirmed");
}, 60_000);
test("Profile personal context saves an unchanged value without the prompt-cache confirm", async () => {
	const fixture = installAccountFixture();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await selectProfile(setup);
	await press(setup, { name: "p" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Cancel personal context")
	);
	await press(setup, { name: "return" });
	const frame = await waitForFrame(setup, (current) =>
		current.includes("Could not save personal context")
	);
	expect(frame).not.toContain(CACHE_RESET_TITLE);
	expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
	expect(JSON.parse(fixture.context).aboutYou).toBe("Local context");
}, 30_000);
test("Profile photo uses local file multipart upload, cancel, denied retry, confirmation and removal readback", async () => {
	const fixture = installAccountFixture();
	await Bun.write(
		photoFile,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=",
			"base64"
		)
	);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 52,
	});
	testSetup = setup;
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await selectProfile(setup);
	await waitForFrame(setup, (frame) => frame.includes("a upload local image"));
	await press(setup, { name: "a" });
	await waitForFrame(setup, (frame) => frame.includes("Enter upload"));
	await press(setup, { name: "tab" });
	expect(
		fixture.calls.some((call) => call.path === "/api/profile/avatar")
	).toBe(false);
	await press(setup, { name: "a" });
	await act(async () => {
		await setup.mockInput.typeText(photoFile, 1);
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Upload rejected (403)"));
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Profile photo saved and confirmed.")
	);
	const uploads = fixture.calls.filter(
		(call) => call.path === "/api/profile/avatar" && call.method === "POST"
	);
	expect(uploads).toHaveLength(2);
	for (const call of uploads) {
		expect(call.authorization).toBe("Bearer security-fixture-token");
		expect(call.body.file).toBeInstanceOf(File);
		// SAFETY: The preceding File-instance assertion throws before this read if
		// the captured multipart avatar is not a native File.
		expect((call.body.file as File).type).toBe("image/png");
		// SAFETY: The same captured avatar passed the File-instance assertion above;
		// no statement between that assertion and this read replaces the value.
		expect(await (call.body.file as File).arrayBuffer()).toEqual(
			await Bun.file(photoFile).arrayBuffer()
		);
	}
	await press(setup, { name: "d" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Remove your profile photo?")
	);
	await press(setup, { name: "n" });
	expect(
		fixture.calls.some(
			(call) => call.path === "/api/profile/avatar" && call.method === "DELETE"
		)
	).toBe(false);
	await press(setup, { name: "d" });
	await press(setup, { name: "y" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Profile photo saved and confirmed.")
	);
	expect(
		fixture.calls.filter(
			(call) => call.path === "/api/profile/avatar" && call.method === "DELETE"
		)
	).toHaveLength(1);
	await saveProof(setup, "profile-photo-confirmed");
}, 60_000);

test("Profile Tab edits every personal context field, wraps to nickname, and discards changed drafts", async () => {
	const fixture = installAccountFixture();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await selectProfile(setup);
	await press(setup, { name: "p" });
	for (const suffix of [" Nick", " Editor", " revised", " team"]) {
		await act(async () => {
			await setup.mockInput.typeText(suffix, 1);
		});
		await setup.flush({ maxPasses: 12 });
		await press(setup, { name: "tab" });
	}
	await act(async () => {
		await setup.mockInput.typeText(" wrapped", 1);
	});
	await setup.flush({ maxPasses: 12 });
	await saveThroughCacheConfirm(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not save personal context")
	);
	expect(JSON.parse(fixture.context)).toEqual({
		nickname: "Fixture",
		occupation: "Writer",
		aboutYou: "Local context",
		aboutOrganization: "Fixture organization",
	});
	await saveThroughCacheConfirm(setup);
	const saved = await waitForFrame(setup, (frame) =>
		frame.includes("Personal context saved and confirmed.")
	);
	const expected = {
		nickname: "Fixture Nick wrapped",
		occupation: "Writer Editor",
		aboutYou: "Local context revised",
		aboutOrganization: "Fixture organization team",
	};
	expect(JSON.parse(fixture.context)).toEqual(expected);
	for (const value of Object.values(expected)) {
		expect(saved).toContain(value);
	}
	const writes = fixture.calls.filter((call) => call.method === "PUT");
	const expectedWire = JSON.stringify({
		aboutOrganization: expected.aboutOrganization,
		aboutYou: expected.aboutYou,
		nickname: expected.nickname,
		occupation: expected.occupation,
	});
	expect(
		writes.map((call) => ({
			path: call.path,
			body: call.body,
			authorization: call.authorization,
		}))
	).toEqual(
		[1, 2].map(() => ({
			path: "/api/preferences/user-personalization",
			body: { value: expectedWire },
			authorization: null,
		}))
	);
	expect(fixture.calls.at(-1)?.path).toBe(
		"/api/preferences/user-personalization"
	);
	expect(fixture.calls.at(-1)?.method).toBe("GET");
	await press(setup, { name: "p" });
	await press(setup, { name: "tab" });
	await act(async () => {
		await setup.mockInput.typeText(" discarded", 1);
	});
	await setup.flush({ maxPasses: 12 });
	await clickText(setup, "Cancel personal context");
	const restored = await waitForFrame(setup, (frame) =>
		frame.includes("p edit personal context")
	);
	expect(restored).toContain("Writer Editor");
	expect(restored).not.toContain("discarded");
	expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
	expect(JSON.parse(fixture.context)).toEqual(expected);
	await saveProof(setup, "control-gaps/personal-context-all-fields-confirmed");
}, 30_000);

test("Account offered step-up methods cycle both directions, clear input, and change an existing password with readback", async () => {
	const fixture = installAccountFixture({
		hasPassword: true,
		methods: ["password", "totp", "backup", "otp", "magic-link"],
	});
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 52,
	});
	testSetup = setup;
	await openAccount(setup);
	expect(setup.captureCharFrame()).toMatch(/Password\s+Set/);
	await press(setup, { name: "w" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verify identity: password")
	);
	await typeKeys(setup, "discarded");
	await press(setup, { name: "left" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verify identity: magic-link")
	);
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verify identity: password")
	);
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Verify identity: totp"));
	await typeKeys(setup, "12345x");
	await press(setup, { name: "backspace" });
	await typeKeys(setup, "6");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not complete action")
	);
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("New password"));
	await typeKeys(setup, "short");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("at least 8 characters"));
	expect(
		fixture.calls.some((call) => call.path === "/api/user/set-password")
	).toBe(false);
	for (let index = 0; index < 5; index++) {
		await press(setup, { name: "backspace" });
	}
	await typeKeys(setup, "Changed-password-1!x");
	await press(setup, { name: "backspace" });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Security update confirmed.")
	);
	const posts = fixture.calls.filter((call) => call.method === "POST");
	expect(posts.map((call) => ({ path: call.path, body: call.body }))).toEqual([
		{
			path: "/api/step-up/verify",
			body: { scope: "account.security", method: "totp", code: "123456" },
		},
		{
			path: "/api/step-up/verify",
			body: { scope: "account.security", method: "totp", code: "123456" },
		},
		{
			path: "/api/user/set-password",
			body: { newPassword: "Changed-password-1!" },
		},
	]);
	expect(
		posts.every(
			(call) => call.authorization === "Bearer security-fixture-token"
		)
	).toBe(true);
	const writeIndex = fixture.calls.findIndex(
		(call) => call.path === "/api/user/set-password"
	);
	expect(
		fixture.calls
			.slice(writeIndex + 1)
			.some(
				(call) =>
					call.path === "/api/user/password-status" && call.method === "GET"
			)
	).toBe(true);
	await saveProof(setup, "control-gaps/existing-password-confirmed");
}, 30_000);

test("Account security turns away a new password the sign-up rules refuse before any request, then sends the corrected one on the same identity proof", async () => {
	const fixture = installAccountFixture({
		hasPassword: true,
		methods: ["password", "totp", "backup", "otp", "magic-link"],
	});
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 52,
	});
	testSetup = setup;
	await openAccount(setup);
	await press(setup, { name: "w" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Verify identity: password")
	);
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Verify identity: totp"));
	await typeKeys(setup, "123456");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not complete action")
	);
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("New password"));

	// Each password reaches eight characters, so only the shared rules turn it
	// away, with the message the sign-up form and the server give.
	for (const [weak, reason] of [
		["abcdefg1!", "Password needs one uppercase letter"],
		["Abcdefgh!", "Password needs one number"],
		["Abcdefg12", "Password needs one symbol"],
	] as const) {
		await typeKeys(setup, weak);
		await press(setup, { name: "return" });
		await waitForFrame(setup, (frame) => frame.includes(reason));
		expect(
			fixture.calls.some((call) => call.path === "/api/user/set-password")
		).toBe(false);
		for (let index = 0; index < weak.length; index++) {
			await press(setup, { name: "backspace" });
		}
	}

	await typeKeys(setup, "Corrected-password-1!");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Security update confirmed.")
	);
	expect(
		fixture.calls
			.filter((call) => call.method === "POST")
			.map((call) => ({ path: call.path, body: call.body }))
	).toEqual([
		{
			path: "/api/step-up/verify",
			body: { scope: "account.security", method: "totp", code: "123456" },
		},
		{
			path: "/api/step-up/verify",
			body: { scope: "account.security", method: "totp", code: "123456" },
		},
		{
			path: "/api/user/set-password",
			body: { newPassword: "Corrected-password-1!" },
		},
	]);
}, 60_000);

test("Profile personal context failed read blocks edits and r retries canonical preference read", async () => {
	const fixture = installAccountFixture({ denyContextRead: true });
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	testSetup = setup;
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	await selectProfile(setup);
	await waitForFrame(setup, (frame) =>
		frame.includes("r retry personal context")
	);
	await press(setup, { name: "p" });
	expect(setup.captureCharFrame()).not.toContain("Cancel personal context");
	expect(fixture.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	const readsBefore = fixture.calls.filter(
		(call) => call.path === "/api/preferences/user-personalization"
	).length;
	await press(setup, { name: "r" });
	const frame = await waitForFrame(setup, (frame) =>
		frame.includes("p edit personal context")
	);
	expect(frame).toContain("Fixture organization");
	expect(frame).toContain("Writer");
	expect(
		fixture.calls.filter(
			(call) => call.path === "/api/preferences/user-personalization"
		)
	).toHaveLength(readsBefore + 1);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/preferences/user-personalization")
			.every((call) => call.method === "GET" && call.authorization === null)
	).toBe(true);
}, 30_000);
