/* @jsxImportSource @opentui/react */

import { expect, test } from "bun:test";
import { App } from "../App.tsx";
import { testRender } from "./cli-test-render.ts";
import {
	installAccountFixture,
	LOCAL_TARGET,
	openAccount,
	press,
	registerAccountSecurityHooks,
	saveProof,
	trackSetup,
	typeKeys,
	waitForFrame,
} from "./settings-account-security.harness.ts";

registerAccountSecurityHooks();

test("Account security uses mailbox step-up, cancel, denied verification/retry and password readback", async () => {
	const fixture = installAccountFixture();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 52,
	});
	trackSetup(setup);
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
	trackSetup(setup);
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
	// With 2FA on, regenerating backup codes and disabling 2FA each need a
	// second-factor account.security step-up before the password prompt.
	await press(setup, { name: "b" });
	await waitForFrame(setup, (frame) => frame.includes("Verify identity: totp"));
	await typeKeys(setup, "111111");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Current password"));
	await typeKeys(setup, "fixture-password");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("SECOND-FIXTURE"));
	await press(setup, { name: "return" });
	await press(setup, { name: "t" });
	await waitForFrame(setup, (frame) => frame.includes("Verify identity: totp"));
	await typeKeys(setup, "222222");
	await press(setup, { name: "return" });
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
	const twoFactorFlow = posts
		.filter(
			(call) =>
				call.path.startsWith("/api/auth/two-factor/") ||
				(call.path === "/api/step-up/verify" && call.body.method === "totp")
		)
		.map((call) => ({ path: call.path, code: call.body.code ?? null }));
	// First enrollment stays password-only; each later change is preceded by
	// its own totp step-up proof.
	expect(twoFactorFlow).toEqual([
		{ path: "/api/auth/two-factor/enable", code: null },
		{ path: "/api/auth/two-factor/verify-totp", code: "123456" },
		{ path: "/api/step-up/verify", code: "111111" },
		{ path: "/api/auth/two-factor/generate-backup-codes", code: null },
		{ path: "/api/step-up/verify", code: "222222" },
		{ path: "/api/auth/two-factor/disable", code: null },
	]);
	expect(
		posts.every(
			(call) => call.authorization === "Bearer security-fixture-token"
		)
	).toBe(true);
	await saveProof(setup, "security-lifecycle-confirmed");
}, 60_000);
test("Account offered step-up methods cycle both directions, clear input, and change an existing password with readback", async () => {
	const fixture = installAccountFixture({
		hasPassword: true,
		methods: ["password", "totp", "backup", "otp", "magic-link"],
	});
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 52,
	});
	trackSetup(setup);
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
	trackSetup(setup);
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
