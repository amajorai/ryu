import { expect, test } from "@playwright/test";
import {
	type AgentModelsSnapshot,
	agentModelsSnapshotSchema,
} from "./agent-models-proof.contracts.ts";

// Keyboard operation of the real AgentModelsSettings in Chromium, against the
// agent-models proof harness's in-page Core fixture: the card trigger and each
// model switch must work from the keyboard with focus where a user expects it,
// and the lazy ACP probe and the `agent:<id>` write must be the same as with
// a pointer.

async function readState(
	page: import("@playwright/test").Page
): Promise<AgentModelsSnapshot> {
	return agentModelsSnapshotSchema.parse(
		await page.evaluate(() => {
			const proof = window.__agentModelsSettingsProof;
			if (!proof) {
				throw new Error("Agent models fixture is not installed");
			}
			return proof.snapshot();
		})
	);
}

function probes(snapshot: AgentModelsSnapshot): string[] {
	return snapshot.requests
		.filter((request) => request.path.endsWith("/acp-config"))
		.map((request) => request.path);
}

test("the agent card and its model switches are operable from the keyboard, probe once and write the agent scope", async ({
	page,
}) => {
	await page.goto("/agent-models-settings-proof.html?reset=true");
	const codex = page.getByRole("button", {
		name: /Codex.*(All models visible|hidden)/u,
	});
	await expect(codex).toHaveAttribute("aria-expanded", "false");
	await codex.focus();
	await page.keyboard.press("Enter");
	await expect(codex).toHaveAttribute("aria-expanded", "true");
	const codexPro = page.getByRole("switch", {
		name: "Show Codex Pro in Codex's model picker",
	});
	await expect(codexPro).toBeVisible();
	expect(probes(await readState(page))).toEqual([
		"/api/agents/codex/acp-config",
	]);

	// Tab moves from the open card into its first model switch.
	await page.keyboard.press("Tab");
	await expect(codexPro).toBeFocused();
	await page.keyboard.press("Space");
	await expect(codexPro).not.toBeChecked();
	await expect(codex).toContainText("1 model hidden");
	await expect(codexPro).toBeFocused();
	const writes = (await readState(page)).requests.filter((request) =>
		request.path.endsWith("/api/pi-config/providers/model-enabled")
	);
	expect(writes).toEqual([
		{
			body: { enabled: false, model: "codex-pro", provider: "agent:codex" },
			method: "POST",
			path: "/api/pi-config/providers/model-enabled",
		},
	]);
	expect((await readState(page)).agentModelOverrides).toEqual({
		codex: { "codex-pro": false },
	});

	// Collapse and reopen from the keyboard: the cached probe is reused.
	await page.keyboard.press("Shift+Tab");
	await expect(codex).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(codex).toHaveAttribute("aria-expanded", "false");
	await expect(codex).toContainText("1 model hidden");
	await page.keyboard.press("Space");
	await expect(codex).toHaveAttribute("aria-expanded", "true");
	await expect(codexPro).not.toBeChecked();
	expect(probes(await readState(page))).toEqual([
		"/api/agents/codex/acp-config",
	]);
});
