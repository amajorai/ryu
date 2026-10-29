import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { AgentIntegrationProofState } from "./harness/agent-integrations-proof.tsx";

declare global {
	interface Window {
		__integrationBootErrors: string[];
		__agentIntegrationProof: AgentIntegrationProofState;
		__clipboardAttempts: { text: string; outcome: string }[];
		__refuseClipboardOnce: boolean;
	}
}
test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.addInitScript(() => {
		window.__integrationBootErrors = [];
		window.addEventListener("error", (event) =>
			window.__integrationBootErrors.push(event.message)
		);
		window.addEventListener("unhandledrejection", (event) =>
			window.__integrationBootErrors.push(String(event.reason))
		);
		const actualWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
		window.__clipboardAttempts = [];
		window.__refuseClipboardOnce = false;
		navigator.clipboard.writeText = async (text: string) => {
			const entry = { text, outcome: "pending" };
			window.__clipboardAttempts.push(entry);
			if (window.__refuseClipboardOnce) {
				window.__refuseClipboardOnce = false;
				entry.outcome = "refused";
				throw new DOMException(
					"Clipboard permission refused",
					"NotAllowedError"
				);
			}
			try {
				await actualWrite(text);
				entry.outcome = "accepted";
			} catch (error) {
				entry.outcome = "refused";
				throw error;
			}
		};
	});
	await page.goto("/agent-integrations-proof.html");
	await page.waitForFunction(
		() =>
			window.__agentIntegrationProof !== undefined ||
			window.__integrationBootErrors.length > 0,
		undefined,
		{ timeout: 90_000 }
	);
	expect(await page.evaluate(() => window.__integrationBootErrors)).toEqual([]);
	await expect(
		page.getByRole("heading", { name: "Call your agent from code" })
	).toBeVisible();
});
test.afterEach(async ({ page }) => {
	const diagnostic = await page.evaluate(() => ({
		bootErrors: window.__integrationBootErrors,
		state: window.__agentIntegrationProof,
		clipboardAttempts: window.__clipboardAttempts,
	}));
	const evidencePath = test
		.info()
		.outputPath("integration-boot-native-http-ledger.json");
	await writeFile(evidencePath, JSON.stringify(diagnostic, null, 2));
	await test.info().attach("integration-boot-native-http-ledger.json", {
		path: evidencePath,
		contentType: "application/json",
	});
	expect(diagnostic.bootErrors).toEqual([]);
	expect(diagnostic.state).toBeDefined();
	expect(
		await page.evaluate(() => window.__agentIntegrationProof.unexpected)
	).toEqual([]);
	const requests = await page.evaluate(
		() => window.__agentIntegrationProof.requests
	);
	expect(requests).toEqual([
		{
			url: `${new URL(page.url()).origin}/api/gateway/config`,
			method: "GET",
			authorization: "Bearer integration-proof-token",
		},
	]);
});

test("every language copies the exact rendered call through the real Clipboard API", async ({
	page,
}) => {
	for (const [language, contract] of [
		["TypeScript SDK", 'client.agents.stream("review-agent"'],
		["Python", "requests.post("],
		["Go", 'http.NewRequest("POST"'],
		["cURL", "curl -N"],
	] as const) {
		await page.getByRole("button", { name: language, exact: true }).click();
		await expect(
			page.getByRole("button", { name: language, exact: true })
		).toHaveAttribute("aria-pressed", "true");
		const snippet = await page.locator("pre code").first().innerText();
		expect(snippet).toContain(contract);
		expect(snippet).toContain('"review-agent"');
		expect(snippet).toContain(new URL(page.url()).origin);
		expect(snippet).toContain("RYU_TOKEN");
		if (language !== "TypeScript SDK")
			expect(snippet).toContain(
				`${new URL(page.url()).origin}/api/chat/stream`
			);
		const copy = page.getByRole("button", {
			name: /^(Copy code sample|Code sample copied)$/,
		});
		await copy.click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(snippet);
		await expect(
			page.getByRole("button", { name: "Code sample copied", exact: true })
		).toBeVisible();
		expect(
			await page.evaluate(() => window.__clipboardAttempts.at(-1))
		).toEqual({ text: snippet, outcome: "accepted" });
	}
	expect(await page.evaluate(() => window.__clipboardAttempts.length)).toBe(4);
});

test("a refused copy preserves prior clipboard bytes and an explicit retry writes the identical sample", async ({
	page,
}) => {
	await page.evaluate(async () => {
		await navigator.clipboard.writeText("previous clipboard bytes\n");
		window.__clipboardAttempts = [];
		window.__refuseClipboardOnce = true;
	});
	await page.getByRole("button", { name: "Python", exact: true }).click();
	const snippet = await page.locator("pre code").first().innerText();
	await page
		.getByRole("button", { name: "Copy code sample", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => window.__clipboardAttempts.at(-1)?.outcome))
		.toBe("refused");
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"previous clipboard bytes\n"
	);
	await expect(
		page.getByRole("button", { name: "Code sample copied", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Copy code sample", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(snippet);
	await expect(
		page.getByRole("button", { name: "Code sample copied", exact: true })
	).toBeVisible();
	expect(await page.evaluate(() => window.__clipboardAttempts)).toEqual([
		{ text: snippet, outcome: "refused" },
		{ text: snippet, outcome: "accepted" },
	]);
});

test("documentation uses the exact production external URL and stays retryable after native refusal", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.evaluate(() => {
		window.__agentIntegrationProof.refuseDocsOnce = true;
	});
	const docs = page.getByRole("button", {
		name: "Read integration docs",
		exact: true,
	});
	await docs.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.__agentIntegrationProof.calls.filter(
						(c) => c.command === "open_external"
					).length
			)
		)
		.toBe(1);
	await expect(docs).toBeEnabled();
	await docs.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.__agentIntegrationProof.calls.filter(
						(c) => c.command === "open_external"
					).length
			)
		)
		.toBe(2);
	expect(
		await page.evaluate(() =>
			window.__agentIntegrationProof.calls.filter(
				(c) => c.command === "open_external"
			)
		)
	).toEqual([
		{
			command: "open_external",
			args: {
				url: "https://app.ryuhq.com/docs/extend/develop/agent-integration-guide",
			},
			outcome: "refused",
		},
		{
			command: "open_external",
			args: {
				url: "https://app.ryuhq.com/docs/extend/develop/agent-integration-guide",
			},
			outcome: "accepted",
		},
	]);
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	);
	expect(pageErrors).toEqual([]);
});
