// Real-browser proof for ChatGPT-compatible mention Markdown in both composer modes.

import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/composer-markdown-proof.html";
const SKILL_PATH = String.raw`C:\Users\jiawei\.agents\skills\thermos\SKILL.md`;
const CHATGPT_MENTION_LINKS = [
	"[Ryu Pricing Economics](sites-project://appgprj_6a958026d5a48191a90d4e33b8fade56)",
	"[Captcha answer check](chatgpt-conversation://6abb6d31-7c0c-83ec-90ab-77871630cc64)",
	"[files.ts](apps/desktop/src/lib/files.ts)",
	"[$hotline](app://connector_openai_hotline)",
	"[@GitHub](plugin://github@openai-curated-remote)",
	`[$thermos](${SKILL_PATH})`,
].join(" ");
const COMPOSER_MENTIONS =
	"@Ryu Pricing Economics @Captcha answer check @<apps/desktop/src/lib/files.ts> @Hotline @GitHub @thermos";
const COPIED_MENTION_LINKS =
	"[Ryu Pricing Economics](sites-project://project-1) [Captcha answer check](chatgpt-conversation://conversation-1) [files.ts](apps/desktop/src/lib/files.ts) [$Hotline](app://connector_hotline) [@GitHub](plugin://github) [$thermos](skill://thermos)";

async function dispatchClipboardEvent(
	locator: import("@playwright/test").Locator,
	type: "copy" | "paste",
	text: string
) {
	return locator.evaluate(
		(element, { eventType, plainText }) => {
			const clipboardData = new DataTransfer();
			if (plainText) {
				clipboardData.setData("text/plain", plainText);
			}
			const event = new ClipboardEvent(eventType, {
				bubbles: true,
				cancelable: true,
				clipboardData,
			});
			element.dispatchEvent(event);
			return {
				defaultPrevented: event.defaultPrevented,
				text: clipboardData.getData("text/plain"),
			};
		},
		{ eventType: type, plainText: text }
	);
}

test("Markdown paste creates an editable link in rich mode", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByRole("textbox").first()).toBeVisible();

	await page.getByRole("checkbox", { name: "Rich Markdown composer" }).check();
	const editor = page.getByRole("textbox").first();
	await editor.click();
	await page.evaluate(() => {
		const target = document.activeElement;
		if (!(target instanceof HTMLElement)) {
			throw new Error("Composer editor did not receive focus");
		}
		const data = new DataTransfer();
		data.setData("text/plain", "[Project plan](https://example.com/plan)");
		target.dispatchEvent(
			new ClipboardEvent("paste", { bubbles: true, clipboardData: data })
		);
	});

	const link = page.getByRole("link", { name: "Project plan" });
	await expect(link).toHaveAttribute("href", "https://example.com/plan");
	await page.getByRole("button", { name: "Edit link" }).click();
	await expect(page.getByPlaceholder("Paste link")).toHaveValue(
		"https://example.com/plan"
	);
	await expect(page.getByPlaceholder("Text to display")).toHaveValue(
		"Project plan"
	);

	await page.getByPlaceholder("Paste link").fill("https://example.com/updated");
	await page.getByPlaceholder("Text to display").fill("Project roadmap");
	await page.getByPlaceholder("Text to display").press("Enter");
	await expect(
		page.getByRole("link", { name: "Project roadmap" })
	).toHaveAttribute("href", "https://example.com/updated");
});

test("ChatGPT mention links round-trip in the lightweight composer", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const composer = page.getByRole("textbox").first();
	await expect(composer).toBeVisible();

	await composer.evaluate((element, text) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData("text/plain", text);
		element.dispatchEvent(
			new ClipboardEvent("paste", {
				bubbles: true,
				cancelable: true,
				clipboardData,
			})
		);
	}, CHATGPT_MENTION_LINKS);
	await expect(composer).toHaveValue(COMPOSER_MENTIONS);

	const copied = await composer.evaluate((element) => {
		if (!(element instanceof HTMLTextAreaElement)) {
			throw new Error("Lightweight composer is not a textarea");
		}
		element.setSelectionRange(0, element.value.length);
		const clipboardData = new DataTransfer();
		const event = new ClipboardEvent("copy", {
			bubbles: true,
			cancelable: true,
			clipboardData,
		});
		element.dispatchEvent(event);
		return clipboardData.getData("text/plain");
	});

	expect(copied).toBe(COPIED_MENTION_LINKS);
});

test("ChatGPT mention links round-trip in the rich composer", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByRole("checkbox", { name: "Rich Markdown composer" }).check();
	const editor = page.getByRole("textbox").first();
	await editor.click();

	await editor.evaluate((element, text) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData("text/plain", text);
		element.dispatchEvent(
			new ClipboardEvent("paste", {
				bubbles: true,
				cancelable: true,
				clipboardData,
			})
		);
	}, CHATGPT_MENTION_LINKS);
	await expect(page.getByTestId("serialized-markdown")).toContainText(
		"@Ryu Pricing Economics"
	);
	await expect(page.getByTestId("serialized-markdown")).toContainText(
		"@Captcha answer check"
	);
	await expect(page.getByTestId("serialized-markdown")).toContainText(
		"@<apps/desktop/src/lib/files.ts>"
	);
	await expect(page.getByTestId("serialized-markdown")).toContainText(
		"@Hotline"
	);
	await expect(page.getByTestId("serialized-markdown")).toContainText(
		"@GitHub"
	);
	await expect(page.getByTestId("serialized-markdown")).toContainText(
		"@thermos"
	);

	const copied = await dispatchClipboardEvent(
		editor,
		"copy",
		COMPOSER_MENTIONS
	);
	expect(copied.defaultPrevented).toBe(true);
	expect(copied.text).toBe(COPIED_MENTION_LINKS);

	await editor.press("Control+A");
	await editor.evaluate((element, text) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData("text/plain", text);
		element.dispatchEvent(
			new ClipboardEvent("paste", {
				bubbles: true,
				cancelable: true,
				clipboardData,
			})
		);
	}, copied.text);
	await expect(page.getByTestId("serialized-markdown")).toContainText(
		"@Ryu Pricing Economics"
	);
});
