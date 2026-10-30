// Real-browser spec for the chat date-grouping story (`e2e/harness/
// chat-date-groups-story.{html,tsx}`), which mounts the REAL transcript over a
// three-day history dated with `createdAt` — ChatPage's actual shape.
//
// The contract under test:
//   • one centred separator per day run, labelled Today / Yesterday / weekday;
//   • the floating chip names the day you are currently reading and swaps as
//     you scroll past a boundary — but it only appears once that day's own
//     inline separator has scrolled out of view, and it stays hidden while the
//     reader rests at the live edge;
//   • the chip and the pinned-user-message bar never overlap while both show —
//     that is what `sticky top-9` on the bar buys, and it is a rect question;
//   • with the pin toggle OFF the chip does not move (its lane is reserved
//     unconditionally);
//   • a scripted scroll sweep produces NO "Maximum update depth" error. The
//     pinned bar sits IN FLOW and is elected from scroll position, which is how
//     React #185 happened the first time; a second scroll-driven element that
//     entered flow would bring it straight back.
//
// Everything above needs a real layout — separators are `content-visibility`
// neighbours, the chip is absolutely positioned, and `currentAnchorId` only
// is driven by an IntersectionObserver on the separators — so this is a
// browser spec rather than a render test.
//
// Deliberately NOT covered here: the grouping RULES (undated turns, midnight,
// zone changes, non-monotonic merged transcripts). Those are pure and live in
// `packages/blocks/src/desktop/agent-elements/date-groups.test.ts`.

import { expect, type Locator, type Page, test } from "@playwright/test";

// Cold Vite compiles the whole transcript module graph on first navigation.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-date-groups-story.html";

/** `DAY_OFFSETS.length * TURNS_PER_DAY * 2` in the story. */
const HISTORY_MESSAGE_COUNT = "48";
/** One per day in the fixture. */
const EXPECTED_SEPARATORS = 3;

function viewport(page: Page): Locator {
	return page.locator('[data-slot="message-scroller-viewport"]');
}

function separators(page: Page): Locator {
	return page.locator('[data-slot="chat-date-separator"]');
}

function floatingChip(page: Page): Locator {
	return page.locator('[data-slot="chat-floating-date"]');
}

function pinnedBar(page: Page): Locator {
	return page.locator('[data-slot="pinned-user-message-bar"]');
}

async function openStory(page: Page, query = ""): Promise<string[]> {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => {
		consoleErrors.push(error.message);
	});
	await page.goto(`${STORY_URL}${query}`);
	await expect(page.getByTestId("story-state")).toHaveAttribute(
		"data-message-count",
		HISTORY_MESSAGE_COUNT,
		// Cold Vite compiles the transcript graph on first navigation, which can
		// outlast the default 5s assertion timeout.
		{ timeout: 60_000 }
	);
	return consoleErrors;
}

/** Walk the transcript top to bottom in viewport-sized steps. */
async function scrollSweep(page: Page): Promise<void> {
	const scroller = viewport(page);
	await scroller.evaluate((el) => {
		el.scrollTop = 0;
	});
	const steps = await scroller.evaluate((el) =>
		Math.ceil(el.scrollHeight / Math.max(1, el.clientHeight))
	);
	for (let i = 0; i <= steps; i += 1) {
		await scroller.evaluate((el, index) => {
			el.scrollTop = el.clientHeight * index;
		}, i);
		await page.waitForTimeout(120);
	}
}

test("every day run opens with one centred separator", async ({ page }) => {
	await openStory(page);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});

	// The fixture is "two days ago, yesterday, today", in that order.
	const labels = await separators(page).allInnerTexts();
	expect(labels).toHaveLength(EXPECTED_SEPARATORS);
	expect(labels[1].trim()).toBe("Yesterday");
	expect(labels[2].trim()).toBe("Today");
	// Two days back is a weekday name, never "Today"/"Yesterday".
	expect(["Today", "Yesterday"]).not.toContain(labels[0].trim());
	expect(labels[0].trim().length).toBeGreaterThan(0);

	// A separator must be a PLAIN child of Content, invisible to the scroller:
	// with a `messageId` it would be treated as an item, and with a scroll
	// anchor it would be chosen over a new user turn as the scroll target.
	const attrs = await separators(page).evaluateAll((nodes) =>
		nodes.map((node) => ({
			anchor: node.getAttribute("data-scroll-anchor"),
			messageId: node.getAttribute("data-message-id"),
			parent: node.parentElement?.getAttribute("data-slot") ?? null,
		}))
	);
	for (const attr of attrs) {
		expect(attr.messageId).toBeNull();
		expect(attr.anchor).toBeNull();
		expect(attr.parent).toBe("message-scroller-content");
	}
});

/**
 * Scroll so the `index`-th separator sits `offset` px above the top edge.
 *
 * Turns are `content-visibility: auto` with a placeholder size, so the first
 * jump lands on estimated heights; the neighbours then render at their real
 * height and move the separator. Re-aim until it settles.
 */
async function scrollPastSeparator(
	page: Page,
	index: number,
	offset: number
): Promise<void> {
	await viewport(page).evaluate(
		async (el, { at, by }) => {
			const frame = () =>
				new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
			const settle = async () => {
				await frame();
				await new Promise((resolve) => setTimeout(resolve, 150));
				await frame();
			};
			let settledReads = 0;
			for (let attempt = 0; attempt < 10 && settledReads < 2; attempt += 1) {
				const separator = el.querySelectorAll(
					'[data-slot="chat-date-separator"]'
				)[at];
				if (!separator) {
					throw new Error(`no separator ${at}`);
				}
				const delta =
					separator.getBoundingClientRect().top -
					el.getBoundingClientRect().top +
					by;
				if (Math.abs(delta) < 2) {
					settledReads += 1;
				} else {
					settledReads = 0;
					el.scrollTop += delta;
				}
				await settle();
			}
		},
		{ at: index, by: offset }
	);
}

test("the floating chip names the day being read and swaps on scroll", async ({
	page,
}) => {
	await openStory(page);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});

	const scroller = viewport(page);
	// Today's separator scrolled just out of view, reader no longer at rest.
	await scrollPastSeparator(page, 2, 160);
	await expect(floatingChip(page)).toHaveText("Today", { timeout: 30_000 });

	// Back at rest on the live edge the transcript carries no floating chrome,
	// even though today's separator is still out of view above.
	await scroller.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(floatingChip(page)).toHaveCount(0, { timeout: 30_000 });

	// Yesterday's separator out of view, today's still below: Yesterday.
	await scrollPastSeparator(page, 1, 160);
	await expect(floatingChip(page)).toHaveText("Yesterday", {
		timeout: 30_000,
	});

	// The top of the transcript shows the oldest separator inline, so the chip
	// must not echo it.
	await scroller.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(floatingChip(page)).toHaveCount(0, { timeout: 30_000 });

	// Past the oldest separator, its weekday label takes over.
	await scrollPastSeparator(page, 0, 160);
	await expect(floatingChip(page)).toBeVisible({ timeout: 30_000 });
	await expect(floatingChip(page)).not.toHaveText(/Today|Yesterday/);
});

test("the chip stays hidden while the current day's separator is on screen", async ({
	page,
}) => {
	await openStory(page);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});
	// Yesterday's separator sits 120px BELOW the top edge, and the turns above
	// it belong to the oldest day: the chip names that day, never "Yesterday".
	await scrollPastSeparator(page, 1, -120);
	await expect(separators(page).nth(1)).toBeInViewport();
	await expect(floatingChip(page)).toBeVisible({ timeout: 30_000 });
	await expect(floatingChip(page)).not.toHaveText(/Today|Yesterday/);
});

test("the chip and the pinned bar never overlap while both are shown", async ({
	page,
}) => {
	await openStory(page);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});

	const scroller = viewport(page);
	// Deep enough into the transcript that a user message is above the fold and
	// the pin bar is elected.
	await scroller.evaluate((el) => {
		el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
		el.scrollTop = Math.floor(el.scrollHeight * 0.6);
	});
	await expect(pinnedBar(page)).toBeVisible({ timeout: 30_000 });
	await expect(floatingChip(page)).toBeVisible();

	const chipBox = await floatingChip(page).boundingBox();
	const barBox = await pinnedBar(page).boundingBox();
	expect(chipBox).not.toBeNull();
	expect(barBox).not.toBeNull();
	if (chipBox && barBox) {
		// The chip's lane sits entirely ABOVE the bar's painted top edge.
		expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(barBox.y + 1);
	}
});

test("the pinned message is shown while scrolling up and hides while scrolling down", async ({
	page,
}) => {
	await openStory(page);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});

	const scroller = viewport(page);
	await scroller.evaluate((element) => {
		element.dispatchEvent(
			new WheelEvent("wheel", { bubbles: true, deltaY: -1 })
		);
		element.scrollTop = Math.floor(element.scrollHeight * 0.7);
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await expect(pinnedBar(page)).toBeVisible({ timeout: 30_000 });

	await scroller.evaluate((element) => {
		element.dispatchEvent(
			new WheelEvent("wheel", { bubbles: true, deltaY: 1 })
		);
		element.scrollTop = Math.min(
			element.scrollHeight - element.clientHeight,
			element.scrollTop + 180
		);
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await expect(pinnedBar(page)).toHaveCount(0);
});

test("the chip keeps its position with the pinned message turned off", async ({
	page,
}) => {
	await openStory(page);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});
	const scroller = viewport(page);
	await scroller.evaluate((el) => {
		el.scrollTop = Math.floor(el.scrollHeight * 0.6);
	});
	await expect(floatingChip(page)).toBeVisible({ timeout: 30_000 });
	const withPin = await floatingChip(page).boundingBox();

	await openStory(page, "?pin=off");
	await expect(page.getByTestId("story-state")).toHaveAttribute(
		"data-pin",
		"off"
	);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});
	await expect(pinnedBar(page)).toHaveCount(0);
	const scrollerOff = viewport(page);
	await scrollerOff.evaluate((el) => {
		el.scrollTop = Math.floor(el.scrollHeight * 0.6);
	});
	await expect(floatingChip(page)).toBeVisible({ timeout: 30_000 });
	const withoutPin = await floatingChip(page).boundingBox();

	expect(withPin).not.toBeNull();
	expect(withoutPin).not.toBeNull();
	if (withPin && withoutPin) {
		expect(Math.abs(withPin.y - withoutPin.y)).toBeLessThanOrEqual(1);
	}
});

test("a full scroll sweep raises no update-depth error", async ({ page }) => {
	const consoleErrors = await openStory(page);
	await expect(separators(page)).toHaveCount(EXPECTED_SEPARATORS, {
		timeout: 30_000,
	});
	await scrollSweep(page);

	const loopErrors = consoleErrors.filter(
		(text) =>
			text.includes("Maximum update depth") ||
			text.includes("Minified React error #185")
	);
	expect(loopErrors).toEqual([]);
});
