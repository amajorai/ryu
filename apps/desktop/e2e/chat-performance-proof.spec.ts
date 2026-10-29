import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("long transcripts defer offscreen layout while the newest turn stays live", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/chat-scroll-story.html");
	await expect(page.getByTestId("story-state")).toHaveAttribute(
		"data-message-count",
		"80",
		{ timeout: 60_000 }
	);
	const rows = page.locator("[data-slot=message-scroller-item]");
	await expect(rows).toHaveCount(40);
	expect(
		await rows
			.first()
			.evaluate((element) => getComputedStyle(element).contentVisibility)
	).toBe("auto");
	expect(
		await rows
			.last()
			.evaluate((element) => getComputedStyle(element).contentVisibility)
	).toBe("visible");
	await expect
		.poll(
			async () =>
				await rows.evaluateAll(
					(elements) =>
						elements.slice(0, -1).filter((element) => {
							const child = element.querySelector("p");
							return (
								child && !child.checkVisibility({ contentVisibilityAuto: true })
							);
						}).length
				)
		)
		.toBeGreaterThan(0);
	await rows.first().scrollIntoViewIfNeeded();
	await expect(
		page.getByText("Question 0 about the codebase", { exact: true })
	).toBeVisible();
	await rows.last().scrollIntoViewIfNeeded();
	await expect(
		page.getByText("Question 39 about the codebase", { exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);
	const directory = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-hunt-2026-09-22"
	);
	await mkdir(directory, { recursive: true });
	await page.screenshot({
		path: path.join(directory, "chat-layout-completed.png"),
		fullPage: true,
	});
});

test("real chat renders streaming chunks without recreating settled decorations", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await page.goto("/chat-scroll-story.html");
	const state = page.getByTestId("story-state");
	await expect(state).toHaveAttribute("data-message-count", "80", {
		timeout: 60_000,
	});
	await page.getByTestId("stream-reply").click();
	// Product intentionally shows the typing row until the whole turn settles.
	await expect(
		page.getByRole("status", { name: "Assistant is typing" })
	).toBeVisible();
	await expect(state).toHaveAttribute(
		"data-source-last-text",
		/^Streaming reply:/
	);
	await expect(state).toHaveAttribute(
		"data-decorated-last-text",
		/^Streaming reply:/
	);
	await expect(state).toHaveAttribute("data-settled-count", "79");
	await expect(state).toHaveAttribute("data-settled-preserved", "true");
	for (let chunk = 2; chunk <= 20; chunk += 1) {
		await page.getByTestId("next-chunk").click();
		await expect(state).toHaveAttribute("data-streamed-chunks", String(chunk));
		await expect(state).toHaveAttribute("data-settled-preserved", "true");
		await expect(state).toHaveAttribute(
			"data-decorated-last-text",
			(await state.getAttribute("data-source-last-text")) ?? ""
		);
	}
	await expect(state).toHaveAttribute("data-streamed-chunks", "20");
	await expect(state).toHaveAttribute("data-settled-preserved", "true");
	await expect(
		page.getByText(
			"Streaming complete. All earlier replies stayed stable while this answer arrived."
		)
	).toBeVisible();
	await expect(page.getByTestId("stream-reply")).toBeEnabled();
	expect(errors).toEqual([]);
	const directory = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-hunt-2026-09-22"
	);
	await mkdir(directory, { recursive: true });
	await page.screenshot({
		path: path.join(directory, "chat-streaming-completed.png"),
		fullPage: true,
	});
	await writeFile(
		path.join(directory, "chat-streaming-metrics.json"),
		JSON.stringify(
			{
				streamedChunks: 20,
				preservedSettledMessages: 79,
				browserErrors: errors,
				mockedBoundary:
					"Network/SDK chunk delivery; actual decorator, AgentChat and MessageList",
				completedTextVisible: true,
			},
			null,
			2
		)
	);
});
