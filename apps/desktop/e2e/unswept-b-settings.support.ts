import { expect, type Locator, type Page } from "@playwright/test";

// Shared locators and helpers for the unswept-b settings specs
// (`unswept-b-settings.spec.ts` and `unswept-b-settings-dialog.spec.ts`).

declare global {
	interface Window {
		__unsweptBAnimate?: Element["animate"];
		__unsweptBApiCalls: Array<{ method: string; path: string }>;
		__unsweptBFlashes?: Record<string, number>;
		/** Which dialog was open each time a watched row was flashed. */
		__unsweptBFlashLog?: string[];
		__unsweptBNative?: Array<{ args: unknown; command: string }>;
		__unsweptBOpenChanges: boolean[];
		__unsweptBSettingsTabs?: unknown[];
	}
}

export const STORY = "/unswept-b-settings.html";

export function settingsDialog(page: Page): Locator {
	return page.locator('[data-slot="dialog-content"]').first();
}

/** The content pane's section heading (its first h2). */
export function sectionHeading(dialog: Locator): Locator {
	return dialog.locator("h2").first();
}

export function searchBox(dialog: Locator): Locator {
	return dialog.getByRole("textbox", { name: "Search settings", exact: true });
}

/** A settings row in the content pane whose title reads exactly `title`. */
export function row(dialog: Locator, title: string): Locator {
	return dialog
		.locator('[data-slot="item"]')
		.filter({
			has: dialog.page().locator('[data-slot="item-title"]', {
				hasText: new RegExp(`^${title}$`),
			}),
		})
		.first();
}

/** A search result button whose first line is exactly `label`. */
export function result(dialog: Locator, label: string): Locator {
	return dialog
		.locator('[data-slot="sidebar-menu-button"]')
		.filter({
			has: dialog.page().locator("span > span:first-child", {
				hasText: new RegExp(`^${label}$`),
			}),
		})
		.first();
}

export async function openStory(page: Page, errors: string[]) {
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(STORY);
	await expect(page.getByTestId("open-settings")).toBeVisible();
}

export async function openSettings(page: Page): Promise<Locator> {
	await page.getByTestId("open-settings").click();
	const dialog = settingsDialog(page);
	await expect(sectionHeading(dialog)).toHaveText("General", {
		timeout: 60_000,
	});
	return dialog;
}

/**
 * Whether `target` is being flashed (a running Web Animation on it) and sits
 * inside its scroll container's visible box once the smooth scroll settles.
 */
export async function revealState(target: Locator) {
	return target.evaluate(async (element) => {
		const animated = element.getAnimations().length > 0;
		let scroller: HTMLElement | null = element.parentElement;
		while (scroller) {
			const style = getComputedStyle(scroller);
			if (
				/(auto|scroll)/.test(style.overflowY) &&
				scroller.scrollHeight > scroller.clientHeight
			) {
				break;
			}
			scroller = scroller.parentElement;
		}
		let previous = -1;
		for (let frame = 0; frame < 120; frame += 1) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const top = scroller?.scrollTop ?? 0;
			if (top === previous) {
				break;
			}
			previous = top;
		}
		const box = element.getBoundingClientRect();
		const view = (scroller ?? document.documentElement).getBoundingClientRect();
		return {
			animated,
			inView: box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
			scrolled: (scroller?.scrollTop ?? 0) > 0,
		};
	});
}
