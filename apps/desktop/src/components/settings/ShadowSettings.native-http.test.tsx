import { expect, test } from "bun:test";
import { act } from "react";
import {
	button,
	click,
	computerUseAlert,
	computerUseSection,
	container,
	edit,
	editable,
	getShadowComputerUseConfig,
	input,
	listPluginSecrets,
	loaded,
	mount,
	physicalRead,
	registerShadowSettingsHooks,
	release,
	retryComputerUse,
	target,
	unmount,
	until,
	writes,
} from "./ShadowSettings.native-http.test-support.tsx";
import {
	clientReads,
	configPath,
	dummyKey,
	failNext,
	holdNext,
	initialConfig,
	releaseHeld,
	secret,
	secretPath,
} from "./ShadowSettings.native-http-peer.test-support.ts";

registerShadowSettingsHooks();

test("actual Shadow full-config save preserves every untouched field and restores independent HTTP storage after remount, while remote node is selected", async () => {
	await mount();
	await loaded();
	await edit("Maximum computer-use steps", "9");
	await click("Save computer-use settings");
	await until(() => {
		const posts = clientReads.filter(
			(read) => read.path === configPath && read.method === "POST"
		);
		return (
			writes().length === 1 &&
			writes()[0].completed &&
			posts.length === 1 &&
			posts.at(-1)?.status === 200 &&
			posts.at(-1)?.bodyConsumed === true &&
			!button("Save computer-use settings").disabled &&
			computerUseSection().textContent?.includes(
				"Computer-use settings saved;"
			) === true
		);
	}, "Actual config POST did not reach consumed acknowledgment and saved UI");
	expect(writes()[0].body).toEqual({ ...editable(initialConfig), maxSteps: 9 });
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
	expect(await getShadowComputerUseConfig()).toEqual({
		...initialConfig,
		maxSteps: 9,
	});
	await unmount();
	await mount();
	await loaded();
	expect(input("Jev model identifier").value).toBe(initialConfig.jevModel);
	expect(input("Maximum computer-use steps").value).toBe("9");
	expect(writes()).toHaveLength(1);
});
for (const status of [403, 503]) {
	test(`config POST${status} preserves draft and physical saved fields; same-value retry persists and remount reads it`, async () => {
		await mount();
		await loaded();
		failNext("configWrite", status);
		await edit("Maximum computer-use steps", "9");
		await click("Save computer-use settings");
		await until(
			() =>
				container.textContent?.includes("Owned config write refused") === true,
			"Actual config refusal was not visible"
		);
		expect(input("Maximum computer-use steps").value).toBe("9");
		expect(await physicalRead()).toEqual(initialConfig);
		expect(container.textContent).not.toContain("Computer-use settings saved;");
		await click("Save computer-use settings");
		await until(() => {
			const posts = clientReads.filter(
				(read) => read.path === configPath && read.method === "POST"
			);
			return (
				writes().length === 2 &&
				writes()[1].completed &&
				posts.length === 2 &&
				posts.at(-1)?.status === 200 &&
				posts.at(-1)?.bodyConsumed === true &&
				!button("Save computer-use settings").disabled &&
				computerUseSection().textContent?.includes(
					"Computer-use settings saved;"
				) === true
			);
		}, "Explicit config retry did not reach consumed acknowledgment and saved UI");
		expect(writes().map((call) => call.body)).toEqual([
			{ ...editable(initialConfig), maxSteps: 9 },
			{ ...editable(initialConfig), maxSteps: 9 },
		]);
		await unmount();
		await mount();
		await loaded();
		expect(input("Maximum computer-use steps").value).toBe("9");
	});
	test(`initial config GET${status} cannot unlock a destructive default-based write; explicit Retry loads complete saved policy`, async () => {
		failNext("configRead", status);
		await mount();
		await until(
			() =>
				clientReads.some(
					(read) =>
						read.path === configPath &&
						read.method === "GET" &&
						read.status === status &&
						read.headersReceived
				) &&
				(computerUseAlert() !== null ||
					!(
						button("Save computer-use settings").disabled ||
						container.textContent?.includes("Loading computer-use settings…")
					)),
			"Failed actual config GET never reached a visible terminal state"
		);
		// The original fail-soft SDK intentionally skips reading a failed GET body.
		// Its visible loaded/default state is the terminal barrier for genuine RED;
		// a protected strict caller reaches its error UI only after reading failure.
		await act(async () => {});
		expect(button("Save computer-use settings").disabled).toBe(true);
		expect(writes()).toHaveLength(0);
		expect(computerUseAlert()).not.toBeNull();
		await retryComputerUse();
		await loaded();
		expect(input("Maximum computer-use steps").value).toBe("7");
		expect(await physicalRead()).toEqual(initialConfig);
		expect(writes()).toHaveLength(0);
	});
}
test("pending actual initial GET cannot send a default full config before saved data arrives", async () => {
	holdNext(configPath, "GET");
	await mount();
	await until(() => releaseHeld !== null, "Initial actual GET not held");
	expect(button("Save computer-use settings").disabled).toBe(true);
	await click("Save computer-use settings");
	expect(writes()).toHaveLength(0);
	await release();
	await loaded();
	expect(await physicalRead()).toEqual(initialConfig);
});
test("Jev credential PUT503 retains masked draft and unchanged write-only metadata; exact trimmed retry survives remount without starting stopped capture", async () => {
	await mount();
	await loaded();
	failNext("secretWrite", 503);
	await edit("Jev API key", `  ${dummyKey}  `);
	await click("Save key");
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === secretPath &&
					read.method === "PUT" &&
					read.status === 503 &&
					read.bodyConsumed
			) && computerUseAlert() !== null,
		"Actual credential PUT503 body and visible error alert did not settle"
	);
	// ApiError intentionally keeps its legacy path/status message; Core's
	// native reason is serverMessage. Do not require the fixture reason text.
	expect(computerUseAlert()?.textContent).toContain("503");
	expect(secret).toBeNull();
	expect(input("Jev API key").type).toBe("password");
	expect(input("Jev API key").value).toBe(`  ${dummyKey}  `);
	expect(container.textContent).not.toContain("Jev key saved encrypted.");
	expect((await listPluginSecrets(target, "@ryu/shadow"))[0].set).toBe(false);
	await click("Save key");
	await until(
		() =>
			container.textContent?.includes(
				"Jev key saved encrypted. Shadow will load it when it next starts."
			) === true,
		"Accepted secret did not acknowledge stopped capture"
	);
	expect(writes(secretPath, "PUT").map((call) => call.body)).toEqual([
		{ value: dummyKey },
		{ value: dummyKey },
	]);
	expect(secret).toBe(dummyKey);
	expect(input("Jev API key").value).toBe("");
	expect(
		JSON.stringify(await listPluginSecrets(target, "@ryu/shadow"))
	).not.toContain(dummyKey);
	await unmount();
	await mount();
	await loaded();
	expect(input("Jev API key").value).toBe("");
	expect(input("Jev API key").placeholder).toBe("Saved; enter to replace");
	expect(container.textContent).not.toContain(dummyKey);
});
