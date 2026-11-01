import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	evidence,
	openFreshProof,
	openTabContext,
	readSealedSession,
	readState,
	rowActivator,
	rowByTitle,
	tabForConversation,
	type VerticalTabWindow,
} from "./vertical-tab-row-proof.helpers.ts";

declare const window: VerticalTabWindow;

test.describe.configure({ timeout: 60_000 });

test("activates vertical tab rows by pointer and Enter, then closes the exact inactive row", async ({
	page,
}) => {
	await openFreshProof(page);
	let state = await readState(page);
	const alpha = tabForConversation(state, "conversation-alpha");
	const beta = tabForConversation(state, "conversation-beta");
	expect(alpha.id).toMatch(/^workbench-item-/u);
	expect(beta.id).toMatch(/^workbench-item-/u);
	expect(beta.id).not.toBe(alpha.id);
	expect(state.activeTabId).toBe(alpha.id);

	await rowActivator(rowByTitle(page, "Beta conversation")).click();
	await expect
		.poll(async () => (await readState(page)).activeTabId)
		.toBe(beta.id);
	const alphaRow = rowByTitle(page, "Alpha conversation");
	await rowActivator(alphaRow).focus();
	await rowActivator(alphaRow).press("Enter");
	await expect
		.poll(async () => (await readState(page)).activeTabId)
		.toBe(alpha.id);

	const betaRow = rowByTitle(page, "Beta conversation");
	await betaRow.hover();
	await betaRow
		.getByRole("button", { name: "Close Beta conversation", exact: true })
		.click();
	state = await readState(page);
	expect(state.tabs.map((tab) => tab.id)).toEqual([alpha.id]);
	expect(state.activeTabId).toBe(alpha.id);
});

test("middle-click closes the vertical row under the pointer without activating it", async ({
	page,
}) => {
	await openFreshProof(page);
	const before = await readState(page);
	const alpha = tabForConversation(before, "conversation-alpha");
	tabForConversation(before, "conversation-beta");
	await rowActivator(rowByTitle(page, "Beta conversation")).click({
		button: "middle",
	});
	const after = await readState(page);
	expect(after.tabs.map((tab) => tab.id)).toEqual([alpha.id]);
	expect(after.activeTabId).toBe(alpha.id);
});

test("renames a conversation row inline, persists the title, and cancels a later draft", async ({
	page,
}) => {
	await openFreshProof(page);
	const originalAlphaId = tabForConversation(
		await readState(page),
		"conversation-alpha"
	).id;
	const alpha = rowByTitle(page, "Alpha conversation");
	await rowActivator(alpha).dblclick();
	const input = alpha.getByRole("textbox");
	await expect(input).toHaveValue("Alpha conversation");
	await input.fill("  Renamed alpha  ");
	await input.press("Enter");
	await expect
		.poll(
			async () =>
				(await readState(page)).tabs.find(
					(tab) => tab.conversationId === "conversation-alpha"
				)?.title
		)
		.toBe("Renamed alpha");
	expect(
		await page.evaluate(
			() =>
				/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window
					.__VERTICAL_TAB_PROOF__.renameCalls
		)
	).toEqual([{ conversationId: "conversation-alpha", title: "Renamed alpha" }]);
	await expect
		.poll(async () =>
			(async () => {
				const raw = await readSealedSession(page);
				if (!raw) {
					return null;
				}
				const session = z
					.object({
						tabs: z.array(
							z.object({
								conversationId: z.string().optional(),
								title: z.string().optional(),
								pinned: z.boolean().optional(),
							})
						),
					})
					.parse(JSON.parse(raw));
				return session.tabs.find(
					(tab) => tab.conversationId === "conversation-alpha"
				)?.title;
			})()
		)
		.toBe("Renamed alpha");

	const renamedRow = rowByTitle(page, "Renamed alpha");
	await rowActivator(renamedRow).dblclick();
	const draft = renamedRow.getByRole("textbox");
	await draft.fill("Discard this name");
	await draft.press("Escape");
	await expect(renamedRow.getByRole("textbox")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await readState(page)).tabs.find(
					(tab) => tab.conversationId === "conversation-alpha"
				)?.title
		)
		.toBe("Renamed alpha");

	await page.reload();
	await expect(rowByTitle(page, "Renamed alpha")).toBeVisible();
	const restored = await readState(page);
	expect(tabForConversation(restored, "conversation-alpha")).toMatchObject({
		id: originalAlphaId,
		conversationId: "conversation-alpha",
		path: "/chat",
		title: "Renamed alpha",
	});
	expect(restored.activeTabId).toBe(originalAlphaId);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-vertical-tab-renamed-row.png"),
	});
});

test("pins and unloads an inactive row, duplicates exact entity state, and closes by ID", async ({
	page,
}) => {
	await openFreshProof(page);
	let state = await readState(page);
	let alpha = tabForConversation(state, "conversation-alpha");
	let beta = tabForConversation(state, "conversation-beta");
	const originalBetaId = beta.id;
	const originalAlphaId = alpha.id;

	let { menu } = await openTabContext(page, "Alpha conversation");
	await expect(
		menu.getByRole("menuitem", { name: "Unload tab" })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	({ menu } = await openTabContext(page, "Beta conversation"));
	await expect(
		menu.getByRole("menuitem", { name: "Unload tab" })
	).toBeEnabled();
	await menu.getByRole("menuitem", { name: "Pin tab" }).click();
	await expect
		.poll(
			async () =>
				tabForConversation(await readState(page), "conversation-beta").pinned
		)
		.toBe(true);
	await expect
		.poll(async () =>
			(async () => {
				const raw = await readSealedSession(page);
				if (!raw) {
					return false;
				}
				const session = z
					.object({
						tabs: z.array(
							z.object({
								conversationId: z.string().optional(),
								title: z.string().optional(),
								pinned: z.boolean().optional(),
							})
						),
					})
					.parse(JSON.parse(raw));
				return (
					session.tabs.find((tab) => tab.conversationId === "conversation-beta")
						?.pinned ?? false
				);
			})()
		)
		.toBe(true);

	await page.reload();
	state = await readState(page);
	alpha = tabForConversation(state, "conversation-alpha");
	beta = tabForConversation(state, "conversation-beta");
	expect(beta.pinned).toBe(true);
	expect(state.activeTabId).toBe(alpha.id);
	expect(beta).toMatchObject({
		id: originalBetaId,
		conversationId: "conversation-beta",
		path: "/chat",
		title: "Beta conversation",
		pinned: true,
	});
	expect(alpha.id).toBe(originalAlphaId);

	({ menu } = await openTabContext(page, "Beta conversation"));
	await expect(menu.getByRole("menuitem", { name: "Unpin tab" })).toBeVisible();
	await menu.getByRole("menuitem", { name: "Unload tab" }).click();
	await expect
		.poll(
			async () =>
				tabForConversation(await readState(page), "conversation-beta").unloaded
		)
		.toBe(true);
	({ menu } = await openTabContext(page, "Beta conversation"));
	await expect(
		menu.getByRole("menuitem", { name: "Unload tab" })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await rowActivator(rowByTitle(page, "Beta conversation")).click();
	await expect
		.poll(async () => (await readState(page)).activeTabId)
		.toBe(beta.id);
	await expect
		.poll(
			async () =>
				tabForConversation(await readState(page), "conversation-beta").unloaded
		)
		.toBe(false);

	({ menu } = await openTabContext(page, "Alpha conversation"));
	await menu.getByRole("menuitem", { name: "Duplicate tab" }).click();
	state = await readState(page);
	const alphaTabs = state.tabs.filter(
		(tab) => tab.conversationId === "conversation-alpha"
	);
	expect(alphaTabs).toHaveLength(2);
	const duplicate = alphaTabs.find((tab) => tab.id !== alpha.id);
	expect(duplicate).toMatchObject({
		conversationId: "conversation-alpha",
		path: "/chat",
		title: "Alpha conversation",
	});
	expect(duplicate?.id).not.toBe(alpha.id);
	expect(state.activeTabId).toBe(duplicate?.id);

	const duplicateRow = rowByTitle(page, "Alpha conversation", 1);
	await duplicateRow.hover();
	await duplicateRow
		.getByRole("button", { name: "Close Alpha conversation", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await readState(page)).tabs.filter(
					(tab) => tab.conversationId === "conversation-alpha"
				).length
		)
		.toBe(1);

	({ menu } = await openTabContext(page, "Beta conversation"));
	const currentBeta = tabForConversation(
		await readState(page),
		"conversation-beta"
	);
	await menu.getByRole("menuitem", { name: "Close tab" }).click();
	await expect
		.poll(async () =>
			(await readState(page)).tabs.some((tab) => tab.id === currentBeta.id)
		)
		.toBe(false);
});

test("shows Split with new chat only outside a split, then exposes and applies Unsplit", async ({
	page,
}) => {
	await openFreshProof(page);
	const beta = tabForConversation(await readState(page), "conversation-beta");
	let { menu } = await openTabContext(page, "Beta conversation");
	await expect(
		menu.getByRole("menuitem", { name: "Split with new chat" })
	).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Unsplit" })).toHaveCount(0);
	await menu.getByRole("menuitem", { name: "Split with new chat" }).click();
	let state = await readState(page);
	const splitMember = state.tabs.find((tab) => tab.id === beta.id);
	expect(splitMember?.splitId).toBeTruthy();
	expect(state.splits).toHaveLength(1);
	const splitId = splitMember?.splitId;
	const members = state.tabs.filter((tab) => tab.splitId === splitId);
	expect(members).toHaveLength(2);
	expect(members.some((tab) => tab.id === beta.id)).toBe(true);
	expect(
		members.some((tab) => tab.title === "New chat" && !tab.conversationId)
	).toBe(true);

	({ menu } = await openTabContext(page, "Beta conversation"));
	await expect(menu.getByRole("menuitem", { name: "Unsplit" })).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "Split with new chat" })
	).toHaveCount(0);
	await expect(
		menu.getByRole("menuitem", { name: "Unload tab" })
	).toBeDisabled();
	await menu.getByRole("menuitem", { name: "Unsplit" }).click();
	state = await readState(page);
	expect(state.splits).toHaveLength(0);
	expect(state.tabs.every((tab) => tab.splitId === null)).toBe(true);
});
