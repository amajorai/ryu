import { expect } from "@playwright/test";
import type { BtwEntry } from "../src/lib/api/btw.ts";

// Fixtures and helpers for cowork-side-chats-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export async function ensureEnvironmentOpen(
	page: import("@playwright/test").Page
) {
	const section = page.getByRole("button", {
		name: "Environment",
		exact: true,
	});
	await expect(section).toBeVisible();
	if ((await section.getAttribute("aria-expanded")) !== "true") {
		await section.click();
	}
	await expect(section).toHaveAttribute("aria-expanded", "true");
}
/** Clicks the row's delete button and confirms the destructive dialog. */
export async function deleteSideChat(page: import("@playwright/test").Page) {
	await page.getByRole("button", { name: "Delete side chat" }).click();
	const confirm = page.getByRole("alertdialog", {
		name: "Delete this side chat?",
	});
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Delete side chat" }).click();
	await expect(confirm).toBeHidden();
}

export const entry: BtwEntry = {
	id: "aside/fixture",
	conversation_id: "conversation/fixture",
	question: "Why retain the saved answer?",
	answer: "It remains available until Core confirms deletion.",
	created_at: 1_790_000_000_000,
	model: "fixture-model",
};
