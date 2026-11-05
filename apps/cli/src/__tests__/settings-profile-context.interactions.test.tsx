/* @jsxImportSource @opentui/react */

import { expect, test } from "bun:test";
import { act } from "react";
import { App } from "../App.tsx";
import { testRender } from "./cli-test-render.ts";
import {
	CACHE_RESET_TITLE,
	clickText,
	installAccountFixture,
	LOCAL_TARGET,
	openSettings,
	photoFile,
	press,
	registerAccountSecurityHooks,
	saveProof,
	saveThroughCacheConfirm,
	selectProfile,
	trackSetup,
	waitForFrame,
} from "./settings-account-security.harness.ts";

registerAccountSecurityHooks();

test("Profile personal context cancels without write and retries denied persistence with exact Core readback", async () => {
	const fixture = installAccountFixture();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	trackSetup(setup);
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
	trackSetup(setup);
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
	trackSetup(setup);
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
	trackSetup(setup);
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

test("Profile personal context failed read blocks edits and r retries canonical preference read", async () => {
	const fixture = installAccountFixture({ denyContextRead: true });
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 48,
	});
	trackSetup(setup);
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
