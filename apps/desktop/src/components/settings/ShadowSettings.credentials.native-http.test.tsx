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
	saved,
	secret,
	secretListPath,
	secretPath,
	setSavedSecret,
} from "./ShadowSettings.native-http-peer.test-support.ts";

registerShadowSettingsHooks();

test("Jev DELETE403 preserves saved secret and Clear action; exact retry removes it and fresh metadata/remount remain unset", async () => {
	setSavedSecret(dummyKey);
	await mount();
	await loaded();
	failNext("secretDelete", 403);
	await click("Clear");
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === secretPath &&
					read.method === "DELETE" &&
					read.status === 403 &&
					read.bodyConsumed
			) && computerUseAlert() !== null,
		"Actual credential DELETE403 body and visible error alert did not settle"
	);
	expect(computerUseAlert()?.textContent).toContain("403");
	expect(secret).toBe(dummyKey);
	expect(button("Clear").disabled).toBe(false);
	expect((await listPluginSecrets(target, "@ryu/shadow"))[0].set).toBe(true);
	await click("Clear");
	await until(
		() => secret === null && writes(secretPath, "DELETE").length === 2,
		"Explicit secret deletion retry missing"
	);
	expect(writes(secretPath, "DELETE").map((call) => call.body)).toEqual([
		null,
		null,
	]);
	await unmount();
	await mount();
	await loaded();
	expect((await listPluginSecrets(target, "@ryu/shadow"))[0].set).toBe(false);
	expect(
		[...container.querySelectorAll("button")].some(
			(item) => item.textContent?.trim() === "Clear"
		)
	).toBe(false);
});
test("failed credential metadata GET cannot be presented as an unset or environment-provided key; Retry reads the real saved state", async () => {
	setSavedSecret(dummyKey);
	failNext("secretRead", 503);
	await mount();
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === secretListPath &&
					read.status === 503 &&
					read.bodyConsumed
			),
		"Credential metadata refusal body was not actually consumed"
	);
	await act(async () => {});
	// A readable config remains independent of credential metadata. The unreadable
	// credential must get an honest error and a real metadata retry, not an unset
	// or process-environment claim based on a swallowed response.
	expect(computerUseAlert()).not.toBeNull();
	expect(container.textContent).not.toContain(
		"A Jev key is provided to Shadow by its process environment."
	);
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === configPath &&
					read.method === "GET" &&
					read.status === 200 &&
					read.bodyConsumed
			) &&
			!button("Save computer-use settings").disabled &&
			input("Maximum computer-use steps").value === "7",
		"Independent readable saved policy was blocked by credential metadata refusal"
	);
	await edit("Jev API key", "shadow-replacement-dummy-never-valid");
	expect(button("Save key").disabled).toBe(true);
	await click("Save key");
	expect(writes(secretPath, "PUT")).toHaveLength(0);
	await edit("Maximum computer-use steps", "9");
	await click("Save computer-use settings");
	await until(
		() =>
			writes().length === 1 &&
			clientReads
				.filter((read) => read.path === configPath && read.method === "POST")
				.at(-1)?.status === 200 &&
			clientReads
				.filter((read) => read.path === configPath && read.method === "POST")
				.at(-1)?.bodyConsumed === true &&
			!button("Save computer-use settings").disabled,
		"Independent full-policy save did not acknowledge its actual response body"
	);
	expect(writes()[0].body).toEqual({ ...editable(initialConfig), maxSteps: 9 });
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
	// An unrelated successful policy save must retain this failed read's recovery.
	expect(computerUseAlert()).not.toBeNull();
	expect(computerUseAlert()?.textContent).toContain("503");
	expect(button("Save key").disabled).toBe(true);
	expect(writes(secretPath, "PUT")).toHaveLength(0);
	expect(secret).toBe(dummyKey);
	const readCount = clientReads.filter(
		(read) => read.path === secretListPath && read.method === "GET"
	).length;
	await retryComputerUse();
	await until(
		() =>
			clientReads.filter(
				(read) => read.path === secretListPath && read.method === "GET"
			).length ===
				readCount + 1 &&
			clientReads
				.filter((read) => read.path === secretListPath && read.method === "GET")
				.at(-1)?.bodyConsumed === true,
		"Actual explicit Retry must consume one fresh credential metadata GET"
	);
	await until(
		() => input("Jev API key").placeholder === "Saved; enter to replace",
		"Fresh saved credential metadata did not reach UI"
	);
	await loaded();
	expect(input("Jev API key").placeholder).toBe("Saved; enter to replace");
	expect(button("Save key").disabled).toBe(false);
	expect(computerUseAlert()).toBeNull();
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
	expect(writes()).toHaveLength(1);
	expect(writes(secretPath, "PUT")).toHaveLength(0);
	expect(
		JSON.stringify(await listPluginSecrets(target, "@ryu/shadow"))
	).not.toContain(dummyKey);
});
test("two same-turn save events while the actual POST is held issue one full-policy request and never claim early success", async () => {
	await mount();
	await loaded();
	await edit("Maximum computer-use steps", "9");
	holdNext(configPath, "POST");
	await act(async () => {
		const save = button("Save computer-use settings");
		save.click();
		save.click();
	});
	await until(() => releaseHeld !== null, "Actual config POST not held");
	expect(writes()).toHaveLength(1);
	expect(saved).toEqual(initialConfig);
	expect(container.textContent).not.toContain("Computer-use settings saved;");
	await release();
	await until(() => {
		const posts = clientReads.filter(
			(read) => read.path === configPath && read.method === "POST"
		);
		return (
			saved.maxSteps === 9 &&
			writes().length === 1 &&
			posts.length === 1 &&
			posts[0]?.status === 200 &&
			posts[0]?.bodyConsumed === true &&
			!button("Save computer-use settings").disabled &&
			computerUseSection().textContent?.includes(
				"Computer-use settings saved;"
			) === true
		);
	}, "Held config POST did not reach consumed acknowledgment and terminal saved UI");
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
});

test("actual step-boundary edits persist only valid canonical integers, retain every other saved field, and survive fresh GET/remount", async () => {
	await mount();
	await loaded();
	for (const [typed, accepted] of [
		["0", 1],
		["21", 20],
		["3.9", 3],
	] as const) {
		const writeCount = writes().length;
		await edit("Maximum computer-use steps", typed);
		expect(input("Maximum computer-use steps").value).toBe(String(accepted));
		expect(writes()).toHaveLength(writeCount);
		expect(await physicalRead()).toEqual({
			...initialConfig,
			maxSteps: writeCount === 0 ? 7 : writeCount === 1 ? 1 : 20,
		});
		await click("Save computer-use settings");
		await until(() => {
			const posts = clientReads.filter(
				(read) => read.path === configPath && read.method === "POST"
			);
			return (
				writes().length === writeCount + 1 &&
				posts.length === writeCount + 1 &&
				posts.at(-1)?.status === 200 &&
				posts.at(-1)?.bodyConsumed === true &&
				!button("Save computer-use settings").disabled
			);
		}, "Actual bounded full-policy POST body did not reach acknowledged UI");
		expect(writes().at(-1)?.body).toEqual({
			...editable(initialConfig),
			maxSteps: accepted,
		});
		expect(await physicalRead()).toEqual({
			...initialConfig,
			maxSteps: accepted,
		});
		expect(await getShadowComputerUseConfig()).toEqual({
			...initialConfig,
			maxSteps: accepted,
		});
	}
	expect(writes()).toHaveLength(3);
	await unmount();
	await mount();
	await loaded();
	expect(input("Maximum computer-use steps").value).toBe("3");
	expect(input("Jev model identifier").value).toBe(initialConfig.jevModel);
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 3 });
	expect(writes()).toHaveLength(3);
});
