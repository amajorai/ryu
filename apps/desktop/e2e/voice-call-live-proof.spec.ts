import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

test.describe.configure({ timeout: 180_000 });

test("Core saves the ended voice call and the chat reloads it", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	const frames: unknown[] = [];
	const conversationId = `voice-proof-${randomUUID()}`;
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("websocket", (socket) => {
		socket.on("framereceived", (frame) => {
			if (isNativeText(frame.payload)) {
				frames.push(JSON.parse(frame.payload));
			}
		});
	});
	await page.goto(
		`/voice-call-history-proof.html?live&conversation=${conversationId}`
	);
	await page.getByRole("button", { name: "Start voice call" }).click();
	await expect(page.getByTestId("voice-call-screen")).toBeVisible();
	await expect(page.getByTestId("voice-call-screen")).not.toContainText(
		"Connecting…"
	);
	await page.getByRole("button", { name: "Mute microphone" }).click();
	await expect(page.getByTestId("voice-call-duration")).toHaveText("00:02");
	await page.getByRole("button", { name: "End call", exact: true }).click();
	await expect(page.getByText(/Call ended · \d{2}:\d{2}/)).toBeVisible();
	const persistedResponse = await page.request.get(
		`/api/conversations/${conversationId}`
	);
	expect(persistedResponse.ok()).toBe(true);
	const persisted = await persistedResponse.json();
	const summary = persisted.messages.find((message: { content: string }) =>
		message.content.startsWith("Call ended ·")
	);
	expect(summary.role).toBe("user");
	await page.reload();
	await expect(page.getByText(summary.content, { exact: true })).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("live-core-call-ended.png"),
		fullPage: true,
	});
	expect(errors).toEqual([]);
	await writeFile(
		testInfo.outputPath("live-core-voice-log.json"),
		`${JSON.stringify({ frames, persistedSummary: summary, errors }, null, 2)}\n`
	);
});
