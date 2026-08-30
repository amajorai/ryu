// Real-browser spec for the composer "+" story (`e2e/harness/
// composer-plus-story.{html,tsx}`), which mounts the REAL shared `InputBar` — the
// bar the chat page, launchpad, Ask Ryu dock and builder panes all render.
//
// The regression it guards: the "+" opened a dropdown only when the host wired an
// OPTIONAL row (goal / ghost / plugin toggle / media gen). Surfaces that wired
// none — the launchpad and the builder panes — silently got a bare button that
// opened the OS file picker instead. Both spellings compile and both build, so
// this has to be clicked to be certified.

import { expect, test } from "@playwright/test";

// The story pulls a large module graph; vite compiles it on first navigation, so
// allow generous headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/composer-plus-story.html";

/** The "+" trigger inside one of the story's two mounts. */
function plusIn(page: import("@playwright/test").Page, testId: string) {
	return page.getByTestId(testId).getByRole("button", { name: "Add" });
}

test.describe("composer + menu — real InputBar in isolation", () => {
	test("a surface wiring ONLY attach still gets the dropdown", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		// Nothing is open until the "+" is clicked.
		await expect(
			page.getByRole("option", { name: "Files and images" })
		).toHaveCount(0);

		await plusIn(page, "minimal").click();

		// The affordance is a menu, not a straight-to-file-dialog button.
		await expect(
			page.getByRole("option", { name: "Files and images" })
		).toBeVisible();
	});

	test("the attach row inside the menu reaches the host handler", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("attach-count")).toHaveText("0");

		await plusIn(page, "minimal").click();
		await page.getByRole("option", { name: "Files and images" }).click();

		await expect(page.getByTestId("attach-count")).toHaveText("1");
	});

	test("an attachment-only turn uses Send instead of live voice mode", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const mount = page.getByTestId("attachment-only");

		await expect(
			mount.getByRole("button", { name: "Start voice call", exact: true })
		).toBeVisible();
		await mount.getByRole("button", { name: "Add", exact: true }).click();
		await page.getByRole("option", { name: /Files and images/ }).click();
		await mount.getByRole("textbox").click();

		await expect(mount.getByTestId("attachment-stage")).toHaveText("attached");
		await expect(mount.getByRole("img", { name: "brief.png" })).toBeVisible();
		await expect(
			mount.getByRole("button", { name: "Start voice call", exact: true })
		).toHaveCount(0);
		const send = mount.getByRole("button", { name: "Send", exact: true });
		await expect(send).toBeEnabled();
		await page.screenshot({
			path: "test-results/attachment-only-send-proof.png",
			fullPage: true,
		});

		await send.click();
		await expect(mount.getByTestId("attachment-sent")).toHaveText(
			"sent-attachment-only"
		);
		await expect(mount.getByTestId("attachment-stage")).toHaveText("empty");
		await expect(mount.getByTestId("voice-mode-started")).toHaveText("idle");
	});

	test("the shared menu searches apps from the textarea and inserts a tag", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const mount = page.getByTestId("minimal");
		await plusIn(page, "minimal").click();
		await expect(page.getByRole("option", { name: /Calendar/ })).toBeVisible();

		await mount.locator("textarea").fill("cal");
		await expect(page.getByRole("option", { name: /Calendar/ })).toBeVisible();
		await expect(page.getByRole("option", { name: /Proof/ })).toHaveCount(0);
		await page.getByRole("option", { name: /Calendar/ }).click();

		await expect(mount.locator("textarea")).toHaveValue("@Calendar ");
	});

	test("pins apps and skills into a persistent Pinned section", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.evaluate(() => localStorage.removeItem("ryu:composer-pins"));
		const mount = page.getByTestId("minimal");

		await plusIn(page, "minimal").click();
		await page.getByRole("button", { name: "Pin Calendar" }).click();
		await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("option", { name: "Calendar", exact: true })
		).toHaveCount(1);
		await expect(
			page.getByRole("button", { name: "Unpin Calendar" })
		).toBeVisible();

		// A row from another directory group uses the same affordance and joins the
		// same section, proving the pin surface is not app-specific.
		await page.getByRole("button", { name: "Pin Review checklist" }).click();
		await expect(
			page.getByRole("option", { name: "Review checklist", exact: true })
		).toHaveCount(1);

		await page.reload();
		await plusIn(page, "minimal").click();
		await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Unpin Calendar" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Unpin Review checklist" })
		).toBeVisible();
		await page.screenshot({
			path: "test-results/composer-pinned-section-proof.png",
			fullPage: true,
		});
	});

	test("the richer surface opens the SAME menu, with its extra rows", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await plusIn(page, "full").click();

		// Same attach row as the minimal surface — one affordance, not two designs.
		await expect(
			page.getByRole("option", { name: "Files and images" })
		).toBeVisible();
		// Plus what this host wired on top.
		await expect(
			page.getByRole("option", { name: "Temporary chat" })
		).toBeVisible();
		await expect(
			page.getByRole("option", { name: "Double-check" })
		).toBeVisible();
	});

	test("the expanded-composer plugin expands the composer in place", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const mount = page.getByTestId("expanded");
		const textarea = mount.locator("textarea");
		await textarea.fill("Draft a launch plan with clear milestones");

		const inlineSurface = mount.locator(".composer-container");
		const inlineBox = await inlineSurface.boundingBox();
		if (!inlineBox) {
			throw new Error("expanded composer surface did not lay out");
		}

		await mount.getByRole("button", { name: "Expand composer" }).click();
		await expect(
			mount.getByRole("button", { name: "Collapse composer" })
		).toBeVisible();
		await expect(
			mount.getByRole("button", { name: "Expand composer" })
		).toHaveCount(0);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(mount.locator("textarea")).toHaveValue(
			"Draft a launch plan with clear milestones"
		);

		const expandedBox = await inlineSurface.boundingBox();
		if (!expandedBox) {
			throw new Error("expanded composer did not lay out");
		}
		// The same surface is intentionally wider and taller in its expanded state.
		expect(expandedBox.width).toBeGreaterThan(inlineBox.width);
		expect(expandedBox.height).toBeGreaterThan(inlineBox.height);

		await page.screenshot({
			path: "test-results/expanded-composer-proof.png",
		});
		await page.keyboard.press("Escape");
		await expect(
			mount.getByRole("button", { name: "Collapse composer" })
		).toHaveCount(0);
		await expect(
			mount.getByRole("button", { name: "Expand composer" })
		).toBeVisible();
		await expect(mount.locator("textarea")).toHaveValue(
			"Draft a launch plan with clear milestones"
		);
	});

	// Compact is a responsive topology, not just tighter padding. A one-line draft
	// shares the row with the controls; once the textarea soft-wraps, the composer
	// must switch to the full stacked layout instead of squeezing a taller editor
	// between those controls. Both spellings compile, so only a laid-out browser can
	// pin this transition.
	test("compact switches to the full stacked layout when the textarea wraps", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const mount = page.getByTestId("compact");
		const plus = plusIn(page, "compact");
		const agent = mount.getByTestId("agent-trigger");
		const textarea = mount.locator("textarea");
		const compactEditor = textarea.locator("xpath=../..");
		const toolbar = mount.locator("[data-composer-layout]");

		await expect(plus).toBeVisible();
		await expect(agent).toBeVisible();
		await expect(toolbar).toHaveAttribute("data-composer-layout", "compact");

		const [plusBox, agentBox, compactEditorBox] = await Promise.all([
			plus.boundingBox(),
			agent.boundingBox(),
			compactEditor.boundingBox(),
		]);
		if (!(plusBox && agentBox && compactEditorBox)) {
			throw new Error("composer controls did not lay out");
		}

		// The empty textarea and controls begin on the same compact row.
		const plusCentre = plusBox.y + plusBox.height / 2;
		const agentCentre = agentBox.y + agentBox.height / 2;
		const textareaCentre = compactEditorBox.y + compactEditorBox.height / 2;
		expect(Math.abs(plusCentre - agentCentre)).toBeLessThan(4);
		expect(Math.abs(plusCentre - textareaCentre)).toBeLessThan(6);
		expect(agentBox.x).toBeGreaterThan(plusBox.x);

		// No explicit newline: this is the auto-wrap regression the product uses.
		await textarea.fill(
			"Explain how this compact composer should grow naturally without squeezing its controls when a longer prompt wraps onto another visible line. ".repeat(
				4
			)
		);
		await expect(toolbar).toHaveAttribute("data-composer-layout", "full");

		const [stackedPlusBox, stackedTextareaBox] = await Promise.all([
			plus.boundingBox(),
			textarea.boundingBox(),
		]);
		if (!(stackedPlusBox && stackedTextareaBox)) {
			throw new Error("expanded composer controls did not lay out");
		}
		expect(stackedPlusBox.y).toBeGreaterThanOrEqual(
			stackedTextareaBox.y + stackedTextareaBox.height
		);

		// An intentional line break takes the same path as a visual soft wrap.
		await textarea.fill("First line\nSecond line");
		await expect(toolbar).toHaveAttribute("data-composer-layout", "full");

		// Deleting back to one visual line restores the space-saving topology.
		await textarea.fill("Short follow-up");
		await expect(toolbar).toHaveAttribute("data-composer-layout", "compact");
	});

	test("shows current-turn progress as separate side-by-side chips", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const stepsButton = page.getByRole("button", { name: "Step 2 of 3" });
		await expect(stepsButton).toBeVisible();
		const filesButton = page.getByRole("button", { name: /2 files changed/ });
		await expect(filesButton).toBeVisible();
		await expect(filesButton).toContainText("+18");
		await expect(filesButton).toContainText("-3");
		const [stepsBox, filesBox] = await Promise.all([
			stepsButton.boundingBox(),
			filesButton.boundingBox(),
		]);
		if (!(stepsBox && filesBox)) {
			throw new Error("turn progress chips did not lay out");
		}
		expect(Math.abs(stepsBox.y - filesBox.y)).toBeLessThan(4);
		expect(filesBox.x).toBeGreaterThan(stepsBox.x);
		await page.screenshot({
			path: "test-results/composer-turn-progress-chips-proof.png",
			fullPage: true,
		});

		await page.getByRole("button", { name: "Step 2 of 3" }).click();
		await expect(page.getByText("Verify", { exact: true })).toBeVisible();
		await page.screenshot({
			path: "test-results/composer-todo-list-proof.png",
			fullPage: true,
		});
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: /2 files changed/ }).click();
		await expect(page.getByText("src/composer.tsx")).toBeVisible();
	});

	// The roomy textarea block's vertical rhythm. It used to pin its content with
	// `pt-3` against a 56px floor, which put a 22px line 12px from the top and left
	// twice that below it — the caret sat visibly high in an apparently empty box.
	// A padding value is a number a build cannot judge; the laid-out gap is.
	test("the roomy textarea sits centred in its block, not pinned to the top", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const textarea = page.getByTestId("minimal").locator("textarea");
		await expect(textarea).toBeVisible();
		// The textarea sits inside a relative overlay layer; measure that content
		// layer against the padded block so its line-box remainder is not counted as
		// visible vertical imbalance.
		const content = textarea.locator("xpath=..");
		const block = content.locator("xpath=..");

		const [contentBox, blockBox] = await Promise.all([
			content.boundingBox(),
			block.boundingBox(),
		]);
		if (!(contentBox && blockBox)) {
			throw new Error("composer textarea did not lay out");
		}

		const above = contentBox.y - blockBox.y;
		const below =
			blockBox.y + blockBox.height - (contentBox.y + contentBox.height);
		// Symmetric within a pixel of rounding; the old fixed pad was ~10px out.
		expect(Math.abs(above - below)).toBeLessThanOrEqual(2);
		// And the block still keeps its roomy floor.
		expect(blockBox.height).toBeGreaterThanOrEqual(55);
	});

	test("a menu row drives its host toggle", async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("ghost-state")).toHaveText("off");

		await plusIn(page, "full").click();
		await page.getByRole("option", { name: "Temporary chat" }).click();

		await expect(page.getByTestId("ghost-state")).toHaveText("on");
	});

	test("temporary chats can opt into memory and be saved later", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const mount = page.getByTestId("full");

		await mount.getByRole("button", { name: "Add", exact: true }).click();
		const temporaryOption = page.getByRole("option", {
			name: "Temporary chat",
		});
		await expect(temporaryOption).toBeVisible();
		await temporaryOption.click();
		await expect(page.getByTestId("temporary-memory-state")).toHaveText("off");

		await mount.getByRole("button", { name: "Add", exact: true }).click();
		await page
			.getByRole("option", { name: "Use memory in temporary chat" })
			.click();
		await expect(page.getByTestId("temporary-memory-state")).toHaveText("on");
		await expect(
			mount.getByRole("button", { name: "Save temporary chat" })
		).toBeVisible();
		await mount.getByRole("button", { name: "Add", exact: true }).click();
		await expect(
			page.getByRole("option", { name: "Use memory in temporary chat" })
		).toBeVisible();
		await page.screenshot({
			path: "test-results/temporary-chat-memory-save-proof.png",
			fullPage: true,
		});

		await page.keyboard.press("Escape");
		await page.screenshot({
			path: "test-results/temporary-chat-save-bar-proof.png",
			fullPage: true,
		});
		await mount.getByRole("button", { name: "Save temporary chat" }).click();
		await expect(page.getByTestId("temporary-chat-saved")).toHaveText("saved");
	});
});
