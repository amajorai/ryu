import { expect, type Page, test } from "@playwright/test";
import {
	PROOF_AGENT,
	PROOF_EMAIL_FIELD,
	PROOF_PAGE,
	PROOF_REASON,
} from "./harness/browser-takeover-proof-sidecar.ts";

const STORY_URL = "/browser-takeover-proof.html";
const SHOTS_DIR =
	process.env.RYU_TAKEOVER_SHOTS_DIR ?? "/tmp/ryu-browser-takeover-proof";
const EMAIL = "ada@example.com";
const PASSWORD = "correct horse";
const LIVE_PICTURE = /Live view of/;

const VIEWS = [
	{ name: "desktop", viewport: { height: 800, width: 1280 } },
	{ name: "narrow", viewport: { height: 800, width: 560 } },
] as const;
const THEMES = ["light", "dark"] as const;

interface ProofState {
	email: string;
	frames: number;
	inputRequests: number;
	outcome: "declined" | "done" | null;
	passwordLength: number;
	request: "active" | "none" | "pending";
	signedIn: boolean;
}

async function proofState(page: Page): Promise<ProofState> {
	const text = await page.getByTestId("takeover-proof-state").textContent();
	return JSON.parse(text ?? "{}");
}

/** Wait until the view shows a frame drawn after the latest change. */
async function freshFrame(page: Page): Promise<void> {
	const drawn = (await proofState(page)).frames;
	await expect
		.poll(async () => (await proofState(page)).frames)
		.toBeGreaterThanOrEqual(drawn + 2);
}

/** Where a point of the agent's page is on screen, inside the letterboxed picture. */
async function onScreen(page: Page, x: number, y: number) {
	const box = await page.getByTestId("bot-takeover-surface").boundingBox();
	if (!box) {
		throw new Error("the takeover surface is not shown");
	}
	const scale = Math.min(
		box.width / PROOF_PAGE.width,
		box.height / PROOF_PAGE.height
	);
	return {
		x: box.x + (box.width - PROOF_PAGE.width * scale) / 2 + x * scale,
		y: box.y + (box.height - PROOF_PAGE.height * scale) / 2 + y * scale,
	};
}

function requestCard(page: Page) {
	return page.getByRole("region", {
		name: `Takeover request from ${PROOF_AGENT}`,
	});
}

for (const view of VIEWS) {
	for (const theme of THEMES) {
		test(`the owner signs in for the agent and hands the page back (${view.name}, ${theme})`, async ({
			page,
		}) => {
			await page.setViewportSize(view.viewport);
			const shot = (step: string) =>
				page.screenshot({
					path: `${SHOTS_DIR}/${step}-${view.name}-${theme}.png`,
				});
			const surface = page.getByTestId("bot-takeover-surface");
			const card = requestCard(page);

			await page.goto(`${STORY_URL}?theme=${theme}`);
			await expect(page.getByRole("img", { name: LIVE_PICTURE })).toBeVisible();
			await expect(page.getByText("read-only")).toBeVisible();
			await expect(card).toHaveCount(0);
			await expect(surface).toHaveCount(0);
			await shot("1-read-only");

			await page
				.getByRole("button", { name: "Agent asks for a takeover" })
				.click();
			await expect(card).toBeVisible();
			// The agent's reason is plain text: its markup is shown, never rendered.
			await expect(card.getByText(PROOF_REASON)).toBeVisible();
			await expect(card.locator("b")).toHaveCount(0);
			await expect(page.getByText("Needs you")).toBeVisible();
			await expect(surface).toHaveCount(0);
			await shot("2-request");

			// Nothing reaches the agent's page before the owner takes control.
			await page.keyboard.type("x");
			expect((await proofState(page)).inputRequests).toBe(0);

			await card.getByRole("button", { name: "Take control" }).click();
			await expect(surface).toBeVisible();
			await expect(
				page.getByText("You have control of this tab")
			).toBeVisible();
			const field = await onScreen(
				page,
				PROOF_EMAIL_FIELD.x + PROOF_EMAIL_FIELD.width / 2,
				PROOF_EMAIL_FIELD.y + PROOF_EMAIL_FIELD.height / 2
			);
			await page.mouse.click(field.x, field.y);
			await page.keyboard.type(EMAIL);
			await page.keyboard.press("Tab");
			await page.keyboard.type(PASSWORD);
			await expect
				.poll(async () => (await proofState(page)).passwordLength)
				.toBe(PASSWORD.length);
			expect((await proofState(page)).email).toBe(EMAIL);
			await freshFrame(page);
			await shot("3-in-control");

			await page.keyboard.press("Enter");
			await expect
				.poll(async () => (await proofState(page)).signedIn)
				.toBe(true);
			await freshFrame(page);
			await shot("4-signed-in");

			await card.getByRole("button", { name: "Done" }).click();
			await expect(card).toHaveCount(0);
			await expect(surface).toHaveCount(0);
			await expect(page.getByText("read-only")).toBeVisible();
			const handedBack = await proofState(page);
			expect(handedBack.outcome).toBe("done");
			expect(handedBack.request).toBe("none");

			// Read-only again: typing no longer reaches the agent's page.
			await page.keyboard.type("more");
			await freshFrame(page);
			expect((await proofState(page)).inputRequests).toBe(
				handedBack.inputRequests
			);
			await shot("5-handed-back");
		});
	}
}

test("declining ends the request and forwards nothing", async ({ page }) => {
	await page.goto(`${STORY_URL}?request=pending`);
	const card = requestCard(page);
	await expect(card).toBeVisible();
	await card.getByRole("button", { name: "Decline" }).click();
	await expect(card).toHaveCount(0);
	await expect(page.getByTestId("bot-takeover-surface")).toHaveCount(0);
	const state = await proofState(page);
	expect(state.outcome).toBe("declined");
	expect(state.inputRequests).toBe(0);
});

test("Tab stays in the page and F6 moves the keyboard to Done", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?request=active`);
	const surface = page.getByTestId("bot-takeover-surface");
	await expect(surface).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(surface).toBeFocused();
	await page.keyboard.press("F6");
	await expect(page.getByRole("button", { name: "Done" })).toBeFocused();
});
