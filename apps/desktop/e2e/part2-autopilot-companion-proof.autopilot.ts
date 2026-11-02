// Continues autopilot-companion-proof.autopilot.ts (split under the file token limit); helpers live in autopilot-companion-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	capture,
	mount,
	remount,
	storedState,
	waitForStoredState,
} from "./autopilot-companion-proof.helpers.ts";

test.use({
	viewport: { height: 1050, width: 1500 },
	contextOptions: { reducedMotion: "reduce" },
});

test("guardrails and both agent selectors persist across reopen; pause blocks and resume restores runs", async ({
	page,
}) => {
	let companion = await mount(page, { fresh: true, section: "guardrails" });
	const externalApproval = companion.getByRole("checkbox", {
		name: /External sends require approval/,
	});
	const scopedWrites = companion.getByRole("checkbox", {
		name: /Writes stay scoped to enabled apps/,
	});
	await expect(externalApproval).toBeChecked();
	await expect(scopedWrites).toBeChecked();
	await expect(
		companion.getByRole("option", { name: "Disabled Agent" })
	).toHaveCount(0);
	await expect(
		companion.getByRole("option", { name: "Uninstalled Agent" })
	).toHaveCount(0);
	await externalApproval.click();
	await scopedWrites.click();
	await companion
		.getByLabel("Autopilot agent lane")
		.selectOption("agent-writer");
	let state = await waitForStoredState(
		page,
		(value) =>
			value?.agentId === "agent-writer" &&
			!value.guardrails.externalApproval &&
			!value.guardrails.scopedWrites
	);
	expect(state.guardrails).toEqual({
		externalApproval: false,
		scopedWrites: false,
	});
	await capture(companion, "autopilot-guardrails-and-agent-lane-saved.png");

	await page.reload();
	companion = await mount(page, { section: "guardrails" });
	await expect(
		companion.getByRole("checkbox", { name: /External sends require approval/ })
	).not.toBeChecked();
	await expect(
		companion.getByRole("checkbox", {
			name: /Writes stay scoped to enabled apps/,
		})
	).not.toBeChecked();
	await expect(companion.getByLabel("Autopilot agent lane")).toHaveValue(
		"agent-writer"
	);
	await companion
		.getByRole("checkbox", { name: /External sends require approval/ })
		.click();
	await companion
		.getByRole("checkbox", { name: /Writes stay scoped to enabled apps/ })
		.click();
	state = await waitForStoredState(
		page,
		(value) =>
			value?.guardrails.externalApproval === true &&
			value.guardrails.scopedWrites === true
	);
	expect(state.agentId).toBe("agent-writer");

	companion = await remount(page, "overview");
	await expect(companion.locator("#autopilot-agent-lane")).toHaveValue(
		"agent-writer"
	);
	await companion
		.locator("#autopilot-agent-lane")
		.selectOption("agent-research");
	state = await waitForStoredState(
		page,
		(value) => value?.agentId === "agent-research"
	);
	expect(state.agentId).toBe("agent-research");
	await companion.locator("#autopilot-agent-lane").selectOption("agent-writer");
	state = await waitForStoredState(
		page,
		(value) => value?.agentId === "agent-writer"
	);
	await companion.getByLabel("Product name").fill("Bounded Ledger");
	await companion
		.getByLabel("What does it do today?")
		.fill("Categorizes business spend while keeping finance writes scoped.");
	await companion.getByRole("button", { name: "Save brief" }).click();
	await waitForStoredState(
		page,
		(value) => value?.strategy.productName === "Bounded Ledger"
	);
	await companion.getByRole("button", { name: "Pause" }).click();
	await expect(companion.getByText("Strategy desk paused")).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Run strategy pass" })
	).toBeDisabled();
	state = await waitForStoredState(page, (value) => value?.active === false);
	expect(state.active).toBe(false);
	await companion.getByRole("button", { name: "Resume" }).click();
	await expect(companion.getByText("Strategy desk active")).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Run strategy pass" })
	).toBeEnabled();
	state = await waitForStoredState(page, (value) => value?.active === true);
	expect(state.agentId).toBe("agent-writer");
	await capture(companion, "autopilot-resumed-run-enabled.png");
});

test("a failed KV save remains visible and can be retried without losing the edited brief", async ({
	page,
}) => {
	const companion = await mount(page, { fresh: true });
	await companion.getByLabel("Product name").fill("Retryable Brief");
	await companion
		.getByLabel("What does it do today?")
		.fill("A local workflow that survives a temporary host storage failure.");
	await page.evaluate(() =>
		window.__autopilotProof.failNextStorageSet("Fixture KV write failed once.")
	);
	await companion.getByRole("button", { name: "Save brief" }).click();
	const alert = companion.getByRole("alert");
	await expect(alert).toContainText("Fixture KV write failed once.");
	expect(await storedState(page)).toBeNull();
	await capture(companion, "autopilot-storage-write-failure-retains-draft.png");
	await alert.getByRole("button", { name: "Dismiss" }).click();
	await companion.getByRole("button", { name: "Save brief" }).click();
	const state = await waitForStoredState(
		page,
		(value) =>
			value?.strategy.productName === "Retryable Brief" &&
			value.strategy.productDescription ===
				"A local workflow that survives a temporary host storage failure."
	);
	expect(state.log[0]?.title).toBe("Strategy draft saved");
	await expect(alert).toHaveCount(0);
	await capture(companion, "autopilot-storage-write-retried.png");
});
