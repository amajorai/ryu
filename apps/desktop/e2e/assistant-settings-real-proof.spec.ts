import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const errors: string[] = [];
const acpConfig = {
	modes: {
		currentModeId: "default",
		availableModes: [
			{ id: "default", name: "Ask permission" },
			{ id: "plan", name: "Plan" },
		],
	},
	models: {
		currentModelId: "review-small",
		availableModels: [
			{ modelId: "review-small", name: "Review Small" },
			{ modelId: "review-large", name: "Review Large" },
		],
	},
	configOptions: [
		{
			id: "effort",
			name: "Thinking",
			category: "thoughtLevel",
			type: "select",
			currentValue: "low",
			options: [
				{ value: "low", name: "Low" },
				{ value: "high", name: "High" },
			],
		},
	],
};
test.beforeEach(async ({ page }) => {
	errors.length = 0;
	page.on("console", (message) => {
		if (message.type() === "error") {
			process.stderr.write(`CONSOLE ${message.text()}\n`);
		}
	});
	page.on("requestfailed", (request) =>
		process.stderr.write(
			`FAILED ${request.url()} ${request.failure()?.errorText}\n`
		)
	);
	page.on("pageerror", (error) => {
		errors.push(error.message);
		process.stderr.write(`${error.message}\n`);
	});
	await page.addInitScript(() =>
		localStorage.setItem("ryu:interface-level", "expert")
	);
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (!path.startsWith("/api/")) {
			await route.continue();
			return;
		}
		let body: Parameters<typeof JSON.stringify>[0] = {};
		if (path.endsWith("/acp-config")) {
			body = path.includes("proof-agent")
				? acpConfig
				: { modes: null, models: null, configOptions: null };
		} else if (path.endsWith("/capabilities")) {
			body = { reasoning: true, tools: true, vision: false };
		} else if (path === "/api/pi-config/catalog") {
			body = { providers: [], thinkingLevels: ["low", "high"] };
		} else if (path === "/api/pi-config") {
			body = {
				config: {
					provider: "gateway",
					model: "gemma-4-e2b-it",
					thinkingLevel: "low",
				},
			};
		} else if (path === "/api/models/installed") {
			body = { models: [] };
		} else if (path === "/api/models/active") {
			body = { active: null };
		} else if (path === "/api/engines/models") {
			body = {
				models: {
					local: [{ id: "gemma-4-e2b-it", name: "Gemma" }],
					codex: [
						{ id: "review-small", name: "Review Small" },
						{ id: "review-large", name: "Review Large" },
					],
				},
			};
		} else if (path.includes("catalog")) {
			body = { agents: [] };
		} else if (path.endsWith("/accounts")) {
			body = { accounts: [] };
		} else if (path === "/api/chat/stream") {
			const parts = [
				{ type: "start", messageId: "settings-reply" },
				{ type: "text-start", id: "text" },
				{ type: "text-delta", id: "text", delta: "Review completed." },
				{ type: "text-end", id: "text" },
				{ type: "finish", finishReason: "stop" },
			];
			await route.fulfill({
				contentType: "text/event-stream",
				headers: { "x-vercel-ai-ui-message-stream": "v1" },
				body:
					parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
					"data: [DONE]\n\n",
			});
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
});
test.afterEach(async ({ page }, info) => {
	await writeFile(
		info.outputPath("real-settings-browser-errors.json"),
		JSON.stringify({ errors: [...errors], status: info.status }, null, 2)
	);
	if (info.status !== "passed") {
		await page.screenshot({
			path: info.outputPath("real-settings-failure.png"),
		});
	}
	expect(errors).toEqual([]);
});
async function openSettings(page: Page) {
	if (!(await page.getByRole("menu").first().isVisible())) {
		await page
			.getByRole("button", { name: "Assistant settings", exact: true })
			.click();
	}
	await expect(
		page.getByText("Review Agent", { exact: true }).last()
	).toBeVisible();
}
test("real assistant settings body opens and Escape restores header trigger focus", async ({
	page,
}, testInfo) => {
	await page.goto("/assistant-settings-real-proof.html");
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
	await page.waitForTimeout(700);
	await openSettings(page);
	await page.screenshot({
		path: testInfo.outputPath("real-settings-open.png"),
	});
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "Assistant settings", exact: true })
	).toBeFocused();
});
test("real settings agent and model selection persist and ride the next chat request", async ({
	page,
}, testInfo) => {
	await page.goto("/assistant-settings-real-proof.html");
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
	await page.waitForTimeout(700);
	await openSettings(page);
	await page.getByText("Review Agent", { exact: true }).last().hover();
	await page.getByText("Use Review Agent", { exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_default_agent")))
		.toBe("proof-agent");
	await openSettings(page);
	await page.getByText("Review Agent", { exact: true }).last().hover();
	await page.getByRole("menuitem", { name: /^Model/ }).hover();
	await page.getByText("Review Large", { exact: true }).click();
	await page.keyboard.press("Escape");
	await page.reload();
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
	await page.waitForTimeout(700);
	const request = page.waitForRequest("**/api/chat/stream");
	const input = page.getByRole("textbox").first();
	await input.fill("Review the selected workspace");
	await input.press("Enter");
	const sent = await request;
	const body = sent.postDataJSON();
	expect(sent.headers().authorization).toBe("Bearer fixture-node-token");
	expect(body).toMatchObject({
		agent_id: "proof-agent",
		acp_model: "review-large",
		response_mode: "developer",
	});
	expect(body.model).toBeUndefined();
	await expect(
		page.getByText("Review completed.", { exact: true })
	).toBeVisible();
	await writeFile(
		testInfo.outputPath("real-settings-request.json"),
		JSON.stringify(body, null, 2)
	);
	await page.screenshot({
		path: testInfo.outputPath("real-settings-completed.png"),
	});
});

test("advertised ACP approval and thinking picks persist and reach the builder runtime request", async ({
	page,
}, testInfo) => {
	await page.addInitScript(() =>
		localStorage.setItem("ryu_default_agent", "proof-agent")
	);
	await page.goto("/assistant-settings-real-proof.html");
	await page.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expect(page.getByTestId("floating-assistant-header")).toBeVisible();
	await openSettings(page);
	await page.getByText("Review Agent", { exact: true }).last().hover();
	await page.getByRole("menuitem", { name: /^Approval/ }).hover();
	await page.getByText("Plan", { exact: true }).click();
	await openSettings(page);
	await page.getByText("Review Agent", { exact: true }).last().hover();
	const thinking = page.getByRole("slider", { name: "Thinking", exact: true });
	await thinking.focus();
	await thinking.press("End");
	await page.keyboard.press("Escape");
	expect(
		await page.evaluate(
			() =>
				JSON.parse(localStorage.getItem("ryu_acp_mode") ?? "{}")["proof-agent"]
		)
	).toBe("plan");
	expect(
		await page.evaluate(
			() =>
				JSON.parse(localStorage.getItem("ryu_acp_config") ?? "{}")[
					"proof-agent"
				]
		)
	).toEqual({ effort: "high" });
	const request = page.waitForRequest("**/api/chat/stream");
	await page
		.getByRole("textbox")
		.first()
		.fill("Review with selected session settings");
	await page.getByRole("textbox").first().press("Enter");
	expect((await request).postDataJSON()).toMatchObject({
		agent_id: "proof-agent",
		acp_mode: "plan",
		acp_config: { effort: "high" },
	});
	await expect(
		page.getByText("Review completed.", { exact: true })
	).toBeVisible();
	const settings = page.getByRole("button", { name: "Assistant settings" });
	if ((await settings.getAttribute("aria-expanded")) === "true") {
		await settings.click();
	}
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(page.locator("[data-chat-empty-intro]")).toHaveCount(0);
	await page.screenshot({
		path: testInfo.outputPath("real-settings-session-controls-completed.png"),
	});
});
