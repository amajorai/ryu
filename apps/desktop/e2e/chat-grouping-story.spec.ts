// Real-browser spec for messaging-style SENDER RUNS in the transcript
// (`e2e/harness/chat-grouping-story.{html,tsx}`, which mounts the real
// `AgentChat` the way ChatPage does).
//
// The contract under test:
//   • consecutive user messages with no reply between them form one run, and a
//     day boundary or an assistant reply closes it;
//   • the avatar AND the timestamp are drawn once per run, on the closing row;
//   • every OTHER row in the run still occupies its 32px avatar gutter. This is
//     the requirement most easily lost: `Message` is `flex gap-2` and
//     `MessageAvatar` is `min-w-8 shrink-0`, so REMOVING the element collapses
//     the gutter and slides the bubble sideways. `chat-message-align.spec.ts`
//     catches that for the last turn; this catches it mid-run;
//   • rows inside a run sit tighter than unrelated turns.
//
// None of that is checkable off the markup alone — the run is not a subtree (it
// spans sibling `MessageScrollerItem`s by design), and "the gutter is still
// there" is a rect question — so this is a browser spec.

import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the whole transcript module graph on first navigation.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-grouping-story.html";

/** The fixture's own message count; see `buildHistory` in the story. */
const HISTORY_MESSAGE_COUNT = "9";

/** Sub-pixel rounding between independently-laid-out rows. */
const EDGE_SLACK_PX = 1;

async function openStory(page: Page) {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("story-state")).toHaveAttribute(
		"data-message-count",
		HISTORY_MESSAGE_COUNT,
		{ timeout: 60_000 }
	);
}

function items(page: Page) {
	return page.locator('[data-slot="message-scroller-item"]');
}

test("a reply, and a new day, each close a sender run", async ({ page }) => {
	await openStory(page);
	// Asserted against the fixture's own declared intent rather than a list
	// duplicated here, so changing the history cannot leave this stale.
	const expected = await page
		.getByTestId("story-state")
		.getAttribute("data-expected-positions");
	expect(expected).not.toBeNull();

	const positions = await items(page).evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-group-position"))
	);
	expect(positions.join(",")).toBe(expected);
});

test("the run draws one avatar and never collapses the gutter", async ({
	page,
}) => {
	await openStory(page);
	await expect(items(page)).toHaveCount(5, { timeout: 30_000 });

	const rows = await page.evaluate(() => {
		const out: {
			avatarWidth: number;
			bubbleRight: number;
			hasAvatarSlot: boolean;
			position: string | null;
			rowRight: number;
			visible: boolean;
		}[] = [];
		for (const item of document.querySelectorAll(
			'[data-slot="message-scroller-item"]'
		)) {
			const row = item.querySelector(".group\\/user-message");
			if (!row) {
				continue;
			}
			const slot = row.querySelector('[data-slot="message-avatar"]');
			const bubble = row.querySelector('[data-testid="user-message-bubble"]');
			out.push({
				avatarWidth: slot ? slot.getBoundingClientRect().width : 0,
				bubbleRight: bubble ? bubble.getBoundingClientRect().right : Number.NaN,
				hasAvatarSlot: Boolean(slot),
				position: item.getAttribute("data-group-position"),
				rowRight: row.getBoundingClientRect().right,
				// `invisible` is `visibility: hidden` — the box survives, the paint
				// does not. A REMOVED avatar would report width 0 above instead.
				visible: slot ? getComputedStyle(slot).visibility !== "hidden" : false,
			});
		}
		return out;
	});

	// The fixture is five user rows; a vacuous pass here would hide everything
	// else this test claims.
	expect(rows).toHaveLength(5);

	for (const row of rows) {
		// Present on EVERY row, painted only on the one that closes the run.
		expect(row.hasAvatarSlot).toBe(true);
		expect(row.avatarWidth).toBeGreaterThan(0);
		expect(row.visible).toBe(
			row.position === "single" || row.position === "last"
		);
	}

	// The gutter is identical on every row, so the bubbles' right edges line up
	// whether or not the avatar is painted. This is the assertion that fails if
	// a non-closing row drops its `MessageAvatar` instead of hiding it.
	const insets = rows.map((row) => row.rowRight - row.bubbleRight);
	for (const inset of insets) {
		expect(Math.abs(inset - insets[0])).toBeLessThanOrEqual(EDGE_SLACK_PX);
	}
});

test("the clock collapses with the avatar, once per run", async ({ page }) => {
	await openStory(page);
	await expect(items(page)).toHaveCount(5, { timeout: 30_000 });

	// The header sits ABOVE the bubble, so leaving it on every row puts a 16px
	// band plus its gap inside a run that is only 2px apart — which is most of
	// the reason a run reads as three unrelated messages. Asserted structurally
	// (header present or absent) rather than by height, because an absent header
	// and a header collapsed to 0px are different bugs and only the first is the
	// intended behaviour: an EMPTY `MessageHeader` still contributes its gap.
	const headers = await items(page).evaluateAll((nodes) =>
		nodes
			.filter((node) => node.querySelector(".group\\/user-message"))
			.map((node) => ({
				hasHeader: Boolean(node.querySelector('[data-slot="message-footer"]')),
				position: node.getAttribute("data-group-position"),
			}))
	);
	expect(headers).toHaveLength(5);
	for (const header of headers) {
		expect(header.hasHeader).toBe(
			header.position === "single" || header.position === "last"
		);
	}
});

test("rows inside a run sit tighter than unrelated turns", async ({ page }) => {
	await openStory(page);
	await expect(items(page)).toHaveCount(5, { timeout: 30_000 });

	const gaps = await items(page).evaluateAll((nodes) =>
		nodes.map((node) => ({
			marginTop: Number.parseFloat(getComputedStyle(node).marginTop),
			position: node.getAttribute("data-group-position"),
		}))
	);
	const inRun = gaps.filter(
		(gap) => gap.position === "middle" || gap.position === "last"
	);
	const between = gaps.filter(
		(gap) => gap.position === "single" || gap.position === "first"
	);
	expect(inRun.length).toBeGreaterThan(0);
	expect(between.length).toBeGreaterThan(0);
	for (const gap of inRun) {
		for (const other of between) {
			expect(gap.marginTop).toBeLessThan(other.marginTop);
		}
	}
});

test("assistant replies use the same top, middle, and bottom grouping radii", async ({
	page,
}) => {
	await openStory(page);

	const assistantBubbles = page.locator(
		'[data-assistant-group-position] [data-slot="bubble-content"]'
	);
	await expect(assistantBubbles).toHaveCount(4, { timeout: 30_000 });

	const radii = await assistantBubbles.evaluateAll((nodes) =>
		nodes.map((node) => ({
			classes: node.className,
			position: node
				.closest("[data-assistant-group-position]")
				?.getAttribute("data-assistant-group-position"),
		}))
	);

	const firstRun = radii.slice(0, 3);
	expect(firstRun.map((entry) => entry.position)).toEqual([
		"first",
		"middle",
		"last",
	]);
	expect(firstRun[0]?.classes).toContain("rounded-bl-md");
	expect(firstRun[1]?.classes).toContain("rounded-l-md");
	expect(firstRun[2]?.classes).toContain("rounded-tl-md");
	expect(radii[3]?.position).toBe("single");
});
