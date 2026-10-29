import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/assistant"
);
const coreProofPath = `${proofDir}/core-generated-history.fixture.json`;
const literal =
	"The user is working in Ryu and currently has this open. Use it as context for their request.\n\n<page-context>\nThis is literal user text.\n</page-context>\n\nKeep this complete text.";

test("real history provider reloads Core-produced files and literal display metadata", async ({
	page,
}) => {
	// This file must come from the durable Core route/API test. There is no fallback seed.
	const coreHistory = JSON.parse(await readFile(coreProofPath, "utf8"));
	expect(coreHistory.messages[0].metadata.ryuUserText).toBe(literal);
	expect(coreHistory.messages[0].parts[1].filename).toBe("proof-note.txt");
	const errors: string[] = [];
	const consoleErrors: string[] = [];
	const reads: string[] = [];
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async (text: string) => {
					/* SAFETY: assistant-history-real-proof.spec.ts installs __historyCopiedText before this proof page is evaluated. */ (
						window as Window & { __historyCopiedText?: string }
					).__historyCopiedText = text;
				},
			},
			configurable: true,
		});
	});
	page.on("pageerror", (error) => {
		errors.push(error.message);
		process.stderr.write(`${error.message}\n`);
	});
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
			process.stderr.write(`Browser console: ${message.text()}\n`);
		}
	});
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}
		let body: NonNullable<Parameters<typeof route.fulfill>[0]>["json"] = {};
		if (url.pathname === "/api/conversations") {
			body = {
				conversations: [
					{
						...coreHistory,
						messages: undefined,
						title: "Saved history proof",
						message_count: coreHistory.messages.length,
					},
				],
			};
		} else if (url.pathname === "/api/conversations/render-history-fixture") {
			reads.push(url.search);
			body = coreHistory;
		} else if (url.pathname.endsWith("/capabilities")) {
			body = { reasoning: false, tools: true, vision: false };
		} else if (url.pathname === "/api/models/installed") {
			body = { models: [] };
		} else if (url.pathname.endsWith("/acp-config")) {
			body = { modes: null, models: null, configOptions: null };
		} else if (url.pathname === "/api/pi-config") {
			body = {
				config: {
					provider: "gateway",
					model: "gemma-4-e2b-it",
					thinkingLevel: "low",
				},
			};
		} else if (url.pathname === "/api/pi-config/catalog") {
			body = { providers: [], thinkingLevels: ["low", "high"] };
		}
		await route.fulfill({ json: body });
	});
	await page.goto(
		"/assistant-history-real-proof.html?conversation=render-history-fixture"
	);
	await expect(
		page.getByRole("heading", { name: "Workspace", exact: true })
	).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByText("proof-note.txt", { exact: true })).toBeVisible();
	await expect(
		page.getByText("History restored.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("log")).toContainText(
		"This is literal user text."
	);
	await page.getByTestId("user-message-bubble").hover();
	await page
		.getByRole("button", { name: "Copy message", exact: true })
		.first()
		.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: assistant-history-real-proof.spec.ts installs __historyCopiedText before this proof page is evaluated. */ (
						window as Window & { __historyCopiedText?: string }
					).__historyCopiedText
			)
		)
		.toBe(literal);
	await expect(
		page.getByText("Fixture workspace context", { exact: false })
	).not.toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByText("proof-note.txt", { exact: true })).toBeVisible();
	await expect(page.getByRole("log")).toContainText(
		"This is literal user text."
	);
	await expect(
		page.getByText("History restored.", { exact: true })
	).toBeVisible();
	await page.getByTestId("user-message-bubble").hover();
	await page
		.getByRole("button", { name: "Copy message", exact: true })
		.first()
		.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: assistant-history-real-proof.spec.ts installs __historyCopiedText before this proof page is evaluated. */ (
						window as Window & { __historyCopiedText?: string }
					).__historyCopiedText
			)
		)
		.toBe(literal);
	expect(reads.length).toBeGreaterThanOrEqual(2);
	expect(errors).toEqual([]);
	expect(consoleErrors).toEqual([]);
	await expect(page.locator("[data-chat-empty-intro]")).toHaveCount(0);
	await page.screenshot({
		path: test.info().outputPath("core-history-reloaded-completed.png"),
	});
	await writeFile(
		test.info().outputPath("core-history-browser-readback.json"),
		JSON.stringify(
			{
				reads,
				errors,
				source:
					"Core chat route, sealed SQLite reopen and production history HTTP projection",
			},
			null,
			2
		)
	);
});
