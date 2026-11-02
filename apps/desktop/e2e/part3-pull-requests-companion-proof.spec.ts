// Continues pull-requests-companion-proof.spec.ts (split under the file token limit); helpers live in pull-requests-companion-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	assistantCalls,
	bridgeRpcs,
	callsWithPath,
	capture,
	clearCalls,
	commands,
	createStackThroughDialog,
	expectAssistantHolds,
	expectedReviewItems,
	expectNoInAppAssistant,
	expectNoReviewSideEffects,
	fixtureState,
	mountPullRequests,
	openPull,
	publishedItems,
	REPOSITORY,
	releaseRequest,
	waitForCall,
	waitForCommand,
} from "./pull-requests-companion-proof.helpers.ts";

test("stack merge menu submits default, queue, direct modes and polls queued completion", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	await createStackThroughDialog(companion);
	const cases = [
		{
			label: "Merge stack through #101",
			strategy: "squash",
			action: "default",
			auto: false,
		},
		{
			label: "Merge directly with a merge commit",
			strategy: "merge",
			action: "direct_merge",
			auto: false,
		},
		{
			label: "Queue stack through #101",
			strategy: "squash",
			action: "merge_queue",
			auto: true,
		},
	] as const;
	const mergeActions: string[] = [];
	for (const item of cases) {
		await clearCalls(page);
		await companion.getByRole("button", { name: "Merge stack" }).click();
		await companion.getByRole("menuitem", { name: item.label }).click();
		const mergeCall = await waitForCall(
			page,
			"POST",
			"/pulls/octo/ryu/101/merge"
		);
		mergeActions.push(String(mergeCall.body?.mergeAction));
		expect(mergeCall.body).toEqual({
			auto: item.auto,
			mergeAction: item.action,
			strategy: item.strategy,
		});
		const endpoint = `repos/${REPOSITORY}/pulls/101/merge-async`;
		const mergeCommand = await waitForCommand(page, `${endpoint} --header`);
		expect(mergeCommand.argv).toContain(`merge_method=${item.strategy}`);
		expect(mergeCommand.argv).toContain(`merge_action=${item.action}`);
		if (item.action === "merge_queue") {
			const statusCommand = await waitForCommand(
				page,
				`repos/${REPOSITORY}/pulls/101/merge-async/00000000-0000-4000-8000-000000000101 --header`
			);
			expect(statusCommand.failed).toBe(false);
			const statusCall = await waitForCall(
				page,
				"GET",
				"/pulls/octo/ryu/101/merge-async/status?id=00000000-0000-4000-8000-000000000101"
			);
			expect(statusCall.status).toBe(200);
			const completedState = await fixtureState(page);
			expect(completedState.pullDetails[`${REPOSITORY}#101`]?.state).toBe(
				"MERGED"
			);
			expect(completedState.pullDetails[`${REPOSITORY}#102`]?.state).toBe(
				"MERGED"
			);
			await expect(
				companion.getByRole("heading", { name: /Expose usage export/ })
			).toBeVisible();
			await expect(companion.getByRole("status")).toContainText(
				"Stack merge completed in test fixture."
			);
			await capture(
				companion,
				"pull-requests-companion-stack-queue-notice-retained.png"
			);
		}
	}
	expect(mergeActions).toEqual(["default", "direct_merge", "merge_queue"]);
	await expect(companion.getByRole("status")).toContainText(
		"Stack merge completed in test fixture."
	);
});

test("device authorization cancellation and success use only the local gh fixture", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "issues", false);
	await expect(
		companion.getByRole("heading", { name: "Connect GitHub" })
	).toBeVisible();
	const signIn = companion.getByRole("button", { name: "Sign in with GitHub" });
	await signIn.click();
	await expect(
		companion.getByRole("button", { name: "Copy one-time GitHub code" })
	).toContainText("ABCD-EFGH");
	await companion.getByRole("button", { name: "Cancel" }).click();
	await expect(companion.getByText("Sign-in cancelled.")).toBeVisible();
	const cancelCall = await waitForCall(page, "DELETE", "/auth/device");
	expect(cancelCall.status).toBe(200);
	const authCommands = (await commands(page)).filter(
		(command) => command.argv[0] === "auth"
	);
	expect(authCommands[0]?.argv).toEqual([
		"auth",
		"login",
		"--hostname",
		"github.com",
		"--git-protocol",
		"https",
		"--skip-ssh-key",
		"--web",
	]);

	await companion.getByRole("button", { name: "Sign in with GitHub" }).click();
	await expect(
		companion.getByRole("button", { name: "Copy one-time GitHub code" })
	).toContainText("ABCD-EFGH");
	const complete = await page.request.post("/__proof/auth-complete");
	expect(complete.status()).toBe(200);
	await expect(companion.getByText("GitHub · @proof-reviewer")).toBeVisible({
		timeout: 8000,
	});
	await expect(companion.locator(".inbox-topline")).toHaveText(
		"GitHub · @proof-reviewer"
	);
	await expect(
		companion.getByRole("option", { name: /Duplicate checkout jobs/ })
	).toBeVisible();
	const authState = await fixtureState(page);
	expect(authState).toMatchObject({ authenticated: true, authComplete: true });
	await capture(companion, "pull-requests-companion-device-auth-complete.png");
});

test("copy one-time GitHub code exposes a selected manual fallback when clipboard writes are denied", async ({
	page,
}) => {
	const hostPort = process.env.RYU_PULL_REQUESTS_PROOF_PORT ?? "5473";
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: `http://127.0.0.1:${hostPort}`,
	});
	const companion = await mountPullRequests(page, "issues", false);
	await companion.getByRole("button", { name: "Sign in with GitHub" }).click();
	const codeButton = companion.getByRole("button", {
		name: "Copy one-time GitHub code",
	});
	await expect(codeButton).toContainText("ABCD-EFGH");
	await codeButton.click();
	await expect(
		companion.getByText("Select the code and copy it manually.")
	).toBeVisible();
	const manualCode = companion.getByRole("textbox", {
		name: "One-time GitHub code",
	});
	await expect(manualCode).toHaveValue("ABCD-EFGH");
	await expect(manualCode).toBeFocused();
	const codeIsSelected = await manualCode.evaluate((element) => {
		if (!(element instanceof HTMLInputElement)) {
			throw new Error("Expected proof element to be an HTMLInputElement.");
		}

		const input = element;
		return (
			input.selectionStart === 0 && input.selectionEnd === input.value.length
		);
	});
	expect(codeIsSelected).toBe(true);
	await capture(
		companion,
		"pull-requests-companion-copy-code-manual-selection.png"
	);
	await companion.getByRole("button", { name: "Cancel" }).click();
	await expect(companion.getByText("Sign-in cancelled.")).toBeVisible();
});

test("Ask about this PR publishes the selected PR and its diff to the global assistant without an in-app chat or model call", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls", true, {
		assistantGrant: true,
	});
	await expect(
		companion.getByRole("heading", { name: /Protect billing retries/ })
	).toBeVisible();
	await expectAssistantHolds(page, 101, true);
	const ledger = await assistantCalls(page);
	const publishes = ledger.filter((call) => call.method === "publishContext");
	// The summary goes out as soon as the detail renders; the diff joins it once
	// the single eager diff read lands.
	expect(publishes.at(0)?.input.items).toEqual(expectedReviewItems(101, false));
	expect(publishes.at(-1)?.input.items).toEqual(expectedReviewItems(101, true));
	expect(
		publishedItems(ledger).every((item) =>
			item.id.startsWith(`pull:${REPOSITORY}#101`)
		)
	).toBe(true);
	expect(
		ledger.filter((call) => call.method === "registerSurface")
	).toHaveLength(1);
	await expect
		.poll(async () =>
			(await bridgeRpcs(page))
				.filter((rpc) => rpc.method.startsWith("assistant."))
				.map((rpc) => rpc.outcome)
		)
		.toEqual(["resolved", "resolved", "resolved"]);
	expect(
		await callsWithPath(page, "GET", "/pulls/octo/ryu/101/diff")
	).toHaveLength(1);
	await expectNoInAppAssistant(page, companion);

	await companion.getByRole("tab", { name: /^Changes/ }).click();
	await expect(companion.locator(".diff")).toContainText(
		"idempotencyKey(order)"
	);
	await expect(
		companion.getByRole("button", { name: "Load full patch" })
	).toHaveCount(0);
	expect(
		await callsWithPath(page, "GET", "/pulls/octo/ryu/101/diff")
	).toHaveLength(1);
	expect(
		(await commands(page)).filter(
			(command) =>
				command.argv.join(" ") ===
				`pr diff 101 --repo ${REPOSITORY} --patch --color never`
		)
	).toHaveLength(1);
	expect(await assistantCalls(page)).toEqual(ledger);
	await expectNoReviewSideEffects(page);
});

test("selecting another PR replaces the assistant context and drops the previous PR's late diff", async ({
	page,
}) => {
	const firstDiff = "/pulls/octo/ryu/101/diff";
	const secondDiff = "/pulls/octo/ryu/102/diff";
	const companion = await mountPullRequests(page, "pulls", true, {
		assistantGrant: true,
		holdPaths: [firstDiff, secondDiff],
	});
	await expect(
		companion.getByRole("heading", { name: /Protect billing retries/ })
	).toBeVisible();
	await expectAssistantHolds(page, 101, false);
	await expect
		.poll(async () => (await callsWithPath(page, "GET", firstDiff)).length)
		.toBe(1);
	expect((await callsWithPath(page, "GET", firstDiff))[0]?.status).toBe(0);

	await openPull(companion, 102);
	await expectAssistantHolds(page, 102, false);
	await expect
		.poll(async () => (await callsWithPath(page, "GET", secondDiff)).length)
		.toBe(1);
	const handoff = await assistantCalls(page);
	const firstSecondPublish = handoff.findIndex(
		(call) =>
			call.method === "publishContext" &&
			call.input.items.some((item) =>
				item.id.startsWith(`pull:${REPOSITORY}#102`)
			)
	);
	// PR 101's slice and surface are withdrawn before PR 102 takes over.
	expect(
		handoff
			.slice(0, firstSecondPublish)
			.map((call) => call.method)
			.slice(-2)
			.sort()
	).toEqual(["clearContext", "clearSurface"]);

	// PR 101's diff answers only after PR 102 is selected; it must be dropped.
	await releaseRequest(page, firstDiff);
	expect((await waitForCall(page, "GET", firstDiff)).status).toBe(200);
	await releaseRequest(page, secondDiff);
	expect((await waitForCall(page, "GET", secondDiff)).status).toBe(200);
	await expectAssistantHolds(page, 102, true);

	const ledger = await assistantCalls(page);
	expect(
		publishedItems(ledger).some(
			(item) => item.id === `pull:${REPOSITORY}#101:diff`
		)
	).toBe(false);
	const afterSwitch = publishedItems(ledger.slice(firstSecondPublish));
	expect(
		afterSwitch.every((item) => item.id.startsWith(`pull:${REPOSITORY}#102`))
	).toBe(true);
	expect(
		afterSwitch.some((item) => item.text.includes("idempotencyKey(order)"))
	).toBe(false);

	await companion.getByRole("tab", { name: /^Changes/ }).click();
	await expect(companion.locator(".diff")).toContainText(
		"export const change102 = true;"
	);
	await expect(companion.locator(".diff")).not.toContainText(
		"idempotencyKey(order)"
	);
	expect(await callsWithPath(page, "GET", secondDiff)).toHaveLength(1);
	await expectNoInAppAssistant(page, companion);
	await expectNoReviewSideEffects(page);
});

test("without the assistant grant the companion still reviews PRs and denied assistant calls stay silent", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const companion = await mountPullRequests(page, "pulls");
	await expect(
		companion.getByRole("heading", { name: /Protect billing retries/ })
	).toBeVisible();
	await waitForCall(page, "GET", "/pulls/octo/ryu/101/diff");
	await expect
		.poll(async () =>
			(await bridgeRpcs(page))
				.filter(
					(rpc) =>
						rpc.method.startsWith("assistant.") && rpc.outcome !== "pending"
				)
				.map((rpc) => rpc.method)
				.sort()
		)
		.toEqual([
			"assistant.publishContext",
			"assistant.publishContext",
			"assistant.registerSurface",
		]);
	for (const rpc of (await bridgeRpcs(page)).filter((item) =>
		item.method.startsWith("assistant.")
	)) {
		expect(rpc.outcome).toBe("rejected");
		expect(rpc.error).toContain(
			`Capability not granted: assistant.context (required by ${rpc.method})`
		);
	}
	// The capability gate stops them before the desktop assistant sees anything.
	expect(await assistantCalls(page)).toEqual([]);

	await companion.getByRole("tab", { name: /^Changes/ }).click();
	await expect(companion.locator(".diff")).toContainText(
		"idempotencyKey(order)"
	);
	await openPull(companion, 102);
	await expect(companion.getByText("Details for PR #102.")).toBeVisible();
	await waitForCall(page, "GET", "/pulls/octo/ryu/102/diff");
	await expect(companion.getByRole("alert")).toHaveCount(0);
	await expect(
		companion.getByText(/Capability not granted|assistant\.context/u)
	).toHaveCount(0);
	expect(await assistantCalls(page)).toEqual([]);
	expect(pageErrors).toEqual([]);
	await expectNoInAppAssistant(page, companion);
	await expectNoReviewSideEffects(page);
});
