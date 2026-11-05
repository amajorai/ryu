// Shared harness for the Settings account-security and profile interaction
// suites: a stateful account-service fetch fixture plus key and frame helpers.

import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { act } from "react";
import type { core } from "zod";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import type { testRender } from "./cli-test-render.ts";

export const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
export const proofDirectory = mkdtempSync(
	join(tmpdir(), "ryu-cli-account-proof-")
);
export const photoFile = join(proofDirectory, "avatar.png");
export type Setup = Awaited<ReturnType<typeof testRender>>;
const originalAuthUrl = process.env.RYU_AUTH_URL;
let testSetup: Setup | null = null;

/** Records the rendered app so the shared afterEach can destroy it. */
export function trackSetup(setup: Setup): Setup {
	testSetup = setup;
	return setup;
}

/** Registers the per-test config, auth URL, fetch and renderer cleanup. */
export function registerAccountSecurityHooks(): void {
	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "ryu-cli-account-security-state-"));
		process.env.RYU_CLI_CONFIG_DIR = configDir;
		writeProductModePreference(
			withProductMode(defaultProductModePreference(), "console", "/chat"),
			productModePreferencePath()
		);
	});
	afterAll(() => rmSync(proofDirectory, { recursive: true, force: true }));

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
}

interface KeyInput {
	ctrl?: boolean;
	name: string;
}

export async function press(setup: Setup, key: KeyInput): Promise<void> {
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

export async function waitForFrame(
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

export async function openSettings(setup: Setup): Promise<void> {
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
}

export const CACHE_RESET_TITLE = "Apply now? This resets the prompt cache";

/** Enter on a changed personal context opens the prompt-cache confirm. */
export async function saveThroughCacheConfirm(setup: Setup): Promise<void> {
	await press(setup, { name: "return" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes(CACHE_RESET_TITLE) &&
			frame.includes("About you is part of the system prompt")
	);
	await press(setup, { name: "y" });
}

export async function clickText(setup: Setup, label: string): Promise<void> {
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

export async function focusProfilePanel(setup: Setup): Promise<void> {
	for (let step = 0; step < 6; step += 1) {
		await press(setup, { name: "down" });
	}
	// Memory owns Up/Down for its rows; use the documented panel shortcut to
	// continue to Profile without changing a Memory preference.
	for (let step = 0; step < 4; step += 1) {
		await press(setup, { name: "j" });
	}
}

export async function selectProfile(setup: Setup): Promise<string> {
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
export function installAccountFixture(
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
				// A 2FA account proves account.security with a second factor only.
				methods:
					options.methods ??
					(enabled ? ["totp", "backup", "otp"] : ["magic-link"]),
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
export async function openAccount(setup: Setup) {
	await waitForFrame(setup, (frame) => frame.includes("› New chat"));
	await openSettings(setup);
	// General → Account is ten panel steps now that Island is not a CLI panel.
	for (let index = 0; index < 10; index++) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(setup, (frame) => frame.includes("Account security"));
}
export async function typeKeys(setup: Setup, value: string) {
	for (const character of value) {
		await press(setup, { name: character });
	}
}
export async function saveProof(setup: Setup, name: string) {
	const proofPath = join(proofDirectory, name);
	mkdirSync(dirname(proofPath), { recursive: true });
	await Bun.write(`${proofPath}.txt`, setup.captureCharFrame());
	await Bun.write(`${proofPath}.svg`, renderTerminalSvg(setup.captureSpans()));
}
