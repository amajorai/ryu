import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { VerticalTabSnapshot } from "./harness/vertical-tab-row-proof.tsx";
import type { VerticalTabProofState } from "./harness/vertical-tab-row-tauri.mock.ts";

interface VerticalTabWindow extends Window {
	__READ_VERTICAL_TAB_STATE__: () => VerticalTabSnapshot;
	__VERTICAL_TAB_PROOF__: VerticalTabProofState;
}
declare const window: VerticalTabWindow;
type TabSnapshot = VerticalTabSnapshot["tabs"][number];

const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../..",
		"docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

const rowByTitle = (page: Page, title: string, occurrence = 0) =>
	page
		.getByRole("button", { name: `Close ${title}`, exact: true })
		.nth(occurrence)
		.locator("xpath=ancestor::li[@data-sidebar='menu-item'][1]");

const rowActivator = (row: ReturnType<typeof rowByTitle>) =>
	row.locator('[role="button"]');

async function openFreshProof(page: Page): Promise<void> {
	await page.goto("/vertical-tab-row-proof.html?seed=true&layout=vertical");
	await expect(
		page.getByRole("heading", { name: "Tabs", exact: true })
	).toBeVisible();
	await expect(rowByTitle(page, "Alpha conversation")).toBeVisible();
	await expect(rowByTitle(page, "Beta conversation")).toBeVisible();
	await expect.poll(async () => (await readState(page)).tabs.length).toBe(2);
}

async function readState(page: Page): Promise<VerticalTabSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: vertical-tab-row-proof.tsx installs __READ_VERTICAL_TAB_STATE__ before this proof page is evaluated. */ window.__READ_VERTICAL_TAB_STATE__()
	);
}

async function openTabContext(page: Page, title: string, occurrence = 0) {
	const row = rowByTitle(page, title, occurrence);
	await rowActivator(row).click({ button: "right" });
	const menu = page.locator('[data-slot="context-menu-content"]');
	await expect(menu).toBeVisible();
	return { menu, row };
}

function tabForConversation(
	state: VerticalTabSnapshot,
	conversationId: string
): TabSnapshot {
	const tab = state.tabs.find(
		(candidate) => candidate.conversationId === conversationId
	);
	if (!tab) {
		throw new Error(`Missing fixture tab for ${conversationId}`);
	}
	return tab;
}

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
				const raw = await page.evaluate(() =>
					localStorage.getItem("ryu_session_tabs")
				);
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
				const raw = await page.evaluate(() =>
					localStorage.getItem("ryu_session_tabs")
				);
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

test("vertical split block accepts a dropped tab, changes orientation, and supports both unsplit controls", async ({
	page,
}) => {
	await openFreshProof(page);
	const splitWithBeta = async () => {
		const { menu } = await openTabContext(page, "Beta conversation");
		await menu.getByRole("menuitem", { name: "Split with new chat" }).click();
	};
	const splitHeader = () =>
		page
			.getByRole("button", { name: "Unsplit", exact: true })
			.locator("xpath=..");
	const savedOrientation = async () => {
		const raw = await page.evaluate(() =>
			localStorage.getItem("ryu_session_tabs")
		);
		if (!raw) {
			return null;
		}
		const session = z
			.object({
				splits: z.array(z.object({ o: z.string().optional() })).optional(),
			})
			.parse(JSON.parse(raw));
		return session.splits?.[0]?.o ?? null;
	};

	await splitWithBeta();
	const stateAfterSplit = await readState(page);
	expect(stateAfterSplit.splits).toHaveLength(1);
	expect(tabForConversation(stateAfterSplit, "conversation-beta").splitId).toBe(
		stateAfterSplit.splits[0]?.id
	);
	const alphaRow = rowByTitle(page, "Alpha conversation");
	await rowActivator(alphaRow).dragTo(splitHeader());
	await expect
		.poll(async () => (await readState(page)).splits[0]?.tabIds.length)
		.toBe(3);
	await expect(
		page.getByText("Side by side · 3", { exact: true })
	).toBeVisible();

	await splitHeader().click({ button: "right" });
	const menu = page.locator('[data-slot="context-menu-content"]').last();
	await expect(menu).toBeVisible();
	await menu
		.getByRole("menuitemradio", { name: "Stacked", exact: true })
		.click();
	await expect.poll(savedOrientation).toBe("rows");
	await expect(page.getByText("Stacked · 3", { exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-vertical-split-block-stacked.png"),
	});

	await splitHeader().click({ button: "right" });
	await page
		.locator('[data-slot="context-menu-content"]')
		.last()
		.getByRole("menuitem", { name: "Unsplit", exact: true })
		.click();
	let state = await readState(page);
	expect(state.splits).toHaveLength(0);
	expect(state.tabs.every((tab) => tab.splitId === null)).toBe(true);

	await splitWithBeta();
	await page.getByRole("button", { name: "Unsplit", exact: true }).click();
	state = await readState(page);
	expect(state.splits).toHaveLength(0);
	expect(state.tabs.every((tab) => tab.splitId === null)).toBe(true);
	await expect(rowByTitle(page, "Alpha conversation")).toBeVisible();
	await expect(rowByTitle(page, "Beta conversation")).toBeVisible();
});

test("dispatches exact native open and move requests through the fixture and only closes after move acknowledgement", async ({
	page,
}) => {
	await openFreshProof(page);
	const beta = tabForConversation(await readState(page), "conversation-beta");
	let { menu } = await openTabContext(page, "Beta conversation");
	await expect(
		menu.getByRole("menuitem", { name: "Open in new window" })
	).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "Move tab to new window" })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-vertical-tab-context-menu.png"),
	});
	await menu.getByRole("menuitem", { name: "Open in new window" }).click();
	await expect
		.poll(
			async () =>
				(
					await page.evaluate(() =>
						/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window.__VERTICAL_TAB_PROOF__.nativeCalls.filter(
							(call) => call.command === "open_tab_window"
						)
					)
				).length
		)
		.toBe(1);
	const openCalls = await page.evaluate(() =>
		/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window.__VERTICAL_TAB_PROOF__.nativeCalls.filter(
			(call) => call.command === "open_tab_window"
		)
	);
	expect(openCalls[0].args).toEqual({
		conversationId: "conversation-beta",
		entityKey: "conversation:conversation-beta",
		node: null,
		path: "/chat",
		title: "Beta conversation",
	});
	expect((await readState(page)).tabs.some((tab) => tab.id === beta.id)).toBe(
		true
	);

	await page.evaluate(() =>
		/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window.__VERTICAL_TAB_PROOF__.windowResults.push(
			false
		)
	);
	({ menu } = await openTabContext(page, "Beta conversation"));
	await menu.getByRole("menuitem", { name: "Move tab to new window" }).click();
	await expect
		.poll(
			async () =>
				(
					await page.evaluate(() =>
						/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window.__VERTICAL_TAB_PROOF__.nativeCalls.filter(
							(call) => call.command === "open_tab_window"
						)
					)
				).length
		)
		.toBe(2);
	await expect
		.poll(async () =>
			(await readState(page)).tabs.some((tab) => tab.id === beta.id)
		)
		.toBe(true);

	await page.evaluate(() =>
		/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window.__VERTICAL_TAB_PROOF__.windowResults.push(
			true
		)
	);
	({ menu } = await openTabContext(page, "Beta conversation"));
	await menu.getByRole("menuitem", { name: "Move tab to new window" }).click();
	await expect
		.poll(
			async () =>
				(
					await page.evaluate(() =>
						/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window.__VERTICAL_TAB_PROOF__.nativeCalls.filter(
							(call) => call.command === "open_tab_window"
						)
					)
				).length
		)
		.toBe(3);
	const calls = await page.evaluate(() =>
		/* SAFETY: vertical-tab-row-tauri.mock.ts installs __VERTICAL_TAB_PROOF__ before this proof page is evaluated. */ window.__VERTICAL_TAB_PROOF__.nativeCalls.filter(
			(call) => call.command === "open_tab_window"
		)
	);
	const moveCall = calls[2].args;
	expect(moveCall).toMatchObject({
		conversationId: "conversation-beta",
		dragOut: false,
		entityKey: "conversation:conversation-beta",
		node: "local",
		path: "/chat",
		title: "Beta conversation",
		transfer: {
			node: "local",
			tab: {
				conversationId: "conversation-beta",
				id: beta.id,
				path: "/chat",
				title: "Beta conversation",
			},
			version: 1,
		},
	});
	await expect
		.poll(async () =>
			(await readState(page)).tabs.some((tab) => tab.id === beta.id)
		)
		.toBe(false);
});

for (const option of [
	{ label: "Horizontal tabs", value: "horizontal", visible: false },
	{ label: "Vertical tabs", value: "vertical", visible: true },
	{ label: "Scrollable tabs", value: "scroll", visible: false },
	{ label: "Infinite canvas", value: "canvas", visible: false },
] as const) {
	test(`selects and restores the ${option.label.toLowerCase()} layout`, async ({
		page,
	}) => {
		await openFreshProof(page);
		const { menu } = await openTabContext(page, "Alpha conversation");
		const radio = menu.getByRole("menuitemradio", {
			name: option.label,
			exact: true,
		});
		await expect(radio).toBeVisible();
		if (option.value === "horizontal") {
			await page.screenshot({
				animations: "disabled",
				fullPage: true,
				path: evidence("desktop-vertical-tab-layout-menu.png"),
			});
		}
		await radio.click();
		await expect(page.getByTestId("tab-layout")).toHaveText(option.value);
		expect(
			await page.evaluate(() => localStorage.getItem("ryu_tab_layout"))
		).toBe(option.value);
		await page.keyboard.press("Escape");
		if (option.visible) {
			await expect(rowByTitle(page, "Alpha conversation")).toBeVisible();
		} else {
			await expect(page.getByTestId("vertical-tabs-hidden")).toBeVisible();
		}

		await page.reload();
		await expect(page.getByTestId("tab-layout")).toHaveText(option.value);
		if (option.visible) {
			await expect(rowByTitle(page, "Alpha conversation")).toBeVisible();
		} else {
			await expect(page.getByTestId("vertical-tabs-hidden")).toBeVisible();
		}
	});
}
