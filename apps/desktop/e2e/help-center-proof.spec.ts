import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "../../..");
const FIXTURE_PATH = path.resolve(
	HERE,
	"../../core/src/plugin_manifest/fixtures/help-center.ui.html"
);
const HOST_PROOF_ARTIFACT = path.resolve(
	REPO_ROOT,
	"docs/proof/help-center-host-proof.png"
);

declare global {
	interface Window {
		__ryuCompanion?: { mount: (options: unknown) => void };
		__ryuHelpCenterCompanion?: {
			connected: () => boolean;
			mount: (
				appHtml: string,
				view?:
					| "overview"
					| "inbox"
					| "tickets"
					| "knowledge"
					| "agent"
					| "insights"
			) => void;
		};
	}
}

test("Help Center companion completes the support workflow in Chromium", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(`console.error: ${message.text()}`);
		}
	});
	page.on("pageerror", (error) => {
		browserErrors.push(`pageerror: ${error.message}`);
	});

	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto("/companion-host-story.html");
	await page.waitForLoadState("networkidle");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(async () => {
		await import("/help-center-host-story.tsx");
	});
	await page.waitForFunction(() =>
		Boolean(window.__ryuHelpCenterCompanion?.mount)
	);

	const fixture = readFileSync(FIXTURE_PATH, "utf8");
	const mountView = async (
		view: "overview" | "inbox" | "tickets" | "knowledge" | "agent" | "insights"
	) => {
		await page.evaluate(
			({ appHtml, nextView }) =>
				window.__ryuHelpCenterCompanion?.mount(appHtml, nextView),
			{ appHtml: fixture, nextView: view }
		);
		await expect
			.poll(
				() => page.evaluate(() => window.__ryuHelpCenterCompanion?.connected()),
				{ timeout: 15_000 }
			)
			.toBe(true);
		const mountedApp = page.frameLocator("#host-root iframe");
		await expect(mountedApp.getByTestId("help-center-app")).toBeVisible({
			timeout: 15_000,
		});
		return mountedApp;
	};

	await page.evaluate(
		({ appHtml }) => window.__ryuHelpCenterCompanion?.mount(appHtml, "inbox"),
		{ appHtml: fixture }
	);
	await expect
		.poll(
			() => page.evaluate(() => window.__ryuHelpCenterCompanion?.connected()),
			{
				timeout: 15_000,
			}
		)
		.toBe(true);

	let app = page.frameLocator("#host-root iframe");
	await expect(app.getByTestId("help-center-app")).toBeVisible({
		timeout: 15_000,
	});
	await expect(app.getByTestId("help-center-queue")).toBeVisible();

	const ticketRows = app.getByTestId("help-center-ticket-row");
	await expect
		.poll(() => ticketRows.count(), { timeout: 10_000 })
		.toBeGreaterThanOrEqual(2);
	app = await mountView("tickets");
	await expect(app.getByRole("heading", { name: "Tickets" })).toBeVisible();
	await expect
		.poll(() => app.getByTestId("help-center-ticket-row").count(), {
			timeout: 10_000,
		})
		.toBeGreaterThanOrEqual(3);

	const selectedRow = app.locator(
		'[data-testid="help-center-ticket-row"][data-ticket-id="demo-ticket-export"]'
	);
	await expect(selectedRow).toBeVisible();
	await expect(selectedRow).toHaveAttribute("data-selected", "true");
	await expect(
		app.getByRole("heading", { name: "Cannot export a report" })
	).toBeVisible();
	await expect(app.getByTestId("help-center-resolution-ribbon")).toBeVisible();
	await expect(app.getByTestId("help-center-conversation")).toBeVisible();
	await expect(app.getByTestId("help-center-customer-context")).toBeVisible();

	await app.getByRole("button", { name: "Draft with AI", exact: true }).click();
	const replyComposer = app.getByRole("textbox", { name: "Local reply" });
	await expect(replyComposer).toHaveValue(/report export/);

	const localReply =
		"I checked the local report export record and will follow up once the download is ready.";
	await replyComposer.fill(localReply);
	await expect(replyComposer).toHaveValue(localReply);
	const addReply = app.getByRole("button", { name: "Add reply", exact: true });
	await expect(addReply).toBeEnabled();
	await addReply.click();
	await expect(
		app.getByTestId("help-center-conversation").getByText(localReply, {
			exact: true,
		})
	).toBeVisible();

	const resolutionRibbon = app.getByTestId("help-center-resolution-ribbon");
	await expect(
		resolutionRibbon.getByRole("button", { name: "Resolve ticket" })
	).toBeVisible();
	await resolutionRibbon
		.getByRole("button", { name: "Resolve ticket" })
		.dispatchEvent("click");
	await expect(resolutionRibbon).toContainText("Resolved");
	await expect(
		resolutionRibbon.getByRole("button", { name: "Reopen ticket" })
	).toBeVisible();
	await expect(resolutionRibbon).toContainText("Resolved");

	await resolutionRibbon
		.getByRole("button", { name: "Reopen ticket" })
		.dispatchEvent("click");
	await expect(resolutionRibbon).toContainText("Human working");
	await expect(
		resolutionRibbon.getByRole("button", { name: "Resolve ticket" })
	).toBeVisible();

	app = await mountView("knowledge");
	const knowledge = app.getByTestId("help-center-knowledge");
	await expect(knowledge).toBeVisible();
	await knowledge
		.getByRole("textbox", { name: "Search Help Center knowledge" })
		.fill("export");
	await expect(
		knowledge.getByText("Exporting a report from Ryu", { exact: true })
	).toBeVisible();

	app = await mountView("agent");
	const agent = app.getByTestId("help-center-agent");
	await expect(agent).toBeVisible();
	await agent
		.getByRole("textbox", { name: "Customer preview question" })
		.fill("How do I export a report?");
	await agent.getByRole("button", { name: "Ask", exact: true }).click();
	await expect(agent).toContainText("Exporting a report from Ryu");

	app = await mountView("insights");
	const insights = app.getByTestId("help-center-insights");
	await expect(insights).toBeVisible();
	await expect(
		insights.getByText("Open tickets", { exact: true })
	).toBeVisible();
	const openTicketsCard = insights
		.getByText("Tickets needing attention", { exact: true })
		.locator("..");
	await expect(openTicketsCard.getByText("3", { exact: true })).toBeVisible();

	app = await mountView("inbox");
	await expect(app.getByTestId("help-center-queue")).toBeVisible();
	await expect(selectedRow).toBeVisible();
	await expect(selectedRow).toHaveAttribute("data-selected", "true");
	await expect(app.getByTestId("help-center-conversation")).toBeVisible();
	await expect(app.getByTestId("help-center-customer-context")).toBeVisible();

	expect(
		browserErrors,
		`Unexpected browser errors:\n${browserErrors.join("\n")}`
	).toEqual([]);

	const screenshotPath = testInfo.outputPath("help-center-host-proof.png");
	await page.screenshot({ fullPage: true, path: screenshotPath });
	copyFileSync(screenshotPath, HOST_PROOF_ARTIFACT);
});
