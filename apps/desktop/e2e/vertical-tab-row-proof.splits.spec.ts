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
		const raw = await readSealedSession(page);
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
