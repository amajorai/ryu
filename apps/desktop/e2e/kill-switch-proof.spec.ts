import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
	killSwitchHostCallSchema,
	killSwitchManifestSchema,
} from "./kill-switch-proof.contracts.ts";

const manifest = killSwitchManifestSchema.parse(
	JSON.parse(
		readFileSync(
			new URL(
				"../../../plugins-store/plugins/kill-switch/manifest.json",
				import.meta.url
			),
			"utf8"
		)
	)
);
const liveCore = process.env.RYU_KILL_SWITCH_PROOF_URL;
const liveToken = process.env.RYU_KILL_SWITCH_PROOF_TOKEN;

test("shipped menu dispatches stop and resume through the plugin host", async ({
	page,
}, testInfo) => {
	if (liveCore) {
		const target = new URL(liveCore);
		if (
			!liveToken ||
			target.protocol !== "http:" ||
			target.hostname !== "127.0.0.1"
		) {
			throw new Error(
				"The live proof requires an authenticated loopback Core."
			);
		}
	}
	const methods: string[] = [];
	await page.route("**/api/plugins/contributions", async (route) => {
		if (liveCore) {
			await route.fulfill({
				response: await route.fetch({
					url: `${liveCore}/api/plugins/contributions`,
					headers: { authorization: `Bearer ${liveToken}` },
				}),
			});
			return;
		}
		await route.fulfill({
			json: {
				context_menu_items: manifest.contributes.context_menu_items.map(
					(item) => ({ ...item, plugin: manifest.id })
				),
			},
		});
	});
	await page.route("**/api/plugins/**/host", async (route) => {
		const body = killSwitchHostCallSchema.parse(route.request().postDataJSON());
		methods.push(body.method);
		if (liveCore) {
			await route.fulfill({
				response: await route.fetch({
					url: `${liveCore}/api/plugins/${encodeURIComponent(manifest.id)}/host`,
					headers: {
						authorization: `Bearer ${liveToken}`,
						"content-type": "application/json",
					},
				}),
			});
			return;
		}
		await route.fulfill({
			json: { result: { paused: body.method === "execution.pause" } },
		});
	});
	await page.goto("/kill-switch-proof.html", { waitUntil: "domcontentloaded" });
	await page
		.getByText("Project research", { exact: true })
		.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Stop all chats and bots", exact: true })
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("kill-switch-light.png"),
		animations: "disabled",
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await page
		.getByText("Project research", { exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Stop all chats and bots", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await expect.poll(() => methods).toEqual(["execution.pause"]);
	await expect(
		page.getByText("Chats and bots paused on this node", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Stopping chats and bots…", { exact: true })
	).toBeHidden();
	await page.screenshot({
		path: testInfo.outputPath("kill-switch-paused.png"),
		animations: "disabled",
		fullPage: true,
	});
	await page
		.getByText("Project research", { exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Resume chats and bots", exact: true })
		.click();
	await expect
		.poll(() => methods)
		.toEqual(["execution.pause", "execution.resume"]);
	await expect(
		page.getByText("This node can accept new chats and bot turns", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByText("This node can accept new chats and bot turns", {
			exact: true,
		})
	).toBeHidden({ timeout: 15_000 });
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.setViewportSize({ width: 390, height: 844 });
	await page
		.getByText("Project research", { exact: true })
		.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Stop all chats and bots", exact: true })
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("kill-switch-dark-narrow.png"),
		animations: "disabled",
		fullPage: true,
	});
	await page
		.getByRole("menuitem", { name: "Stop all chats and bots", exact: true })
		.click();
	await expect
		.poll(() => methods)
		.toEqual(["execution.pause", "execution.resume", "execution.pause"]);
	await expect(
		page.getByText("Chats and bots paused on this node", { exact: true })
	).toBeVisible();
});

test("denied stop shows an error instead of a success confirmation", async ({
	page,
}) => {
	await page.route("**/api/plugins/contributions", (route) =>
		route.fulfill({
			json: {
				context_menu_items: manifest.contributes.context_menu_items.map(
					(item) => ({ ...item, plugin: manifest.id })
				),
			},
		})
	);
	await page.route("**/api/plugins/**/host", (route) =>
		route.fulfill({
			status: 403,
			json: {
				error: { code: "denied", message: "execution:control is not granted" },
			},
		})
	);
	await page.goto("/kill-switch-proof.html", { waitUntil: "domcontentloaded" });
	await page
		.getByText("Project research", { exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Stop all chats and bots", exact: true })
		.click();
	await expect(
		page.getByText("Could not stop chats and bots", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Chats and bots paused on this node", { exact: true })
	).toBeHidden();
});
