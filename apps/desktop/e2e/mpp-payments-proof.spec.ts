import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const walletAddress = "0x1234567890abcdef1234567890abcdef12345678";
const payeeAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const challengeHash =
	"sha256:91a75a13df08c63c5d58c3368320e520b79de900905b8f26b53e633f8e9c2a9e";
const proofDirectory = path.resolve(import.meta.dirname, "../../../docs/proof");

async function installMppBridge(
	page: Page,
	options: { initialReceipt?: boolean } = {}
): Promise<void> {
	await page.addInitScript(({ initialReceipt }) => {
		const settledReceipt = {
			amountAtomic: "250000",
			chainId: 42_431,
			challengeId: "challenge-proof-001",
			currency: "0x20c0000000000000000000000000000000000000",
			id: "receipt-proof-001",
			method: "tempo",
			origin: "https://mpp.dev",
			payee: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
			reference: "tempo:testnet:0x985d2ca9187719d7",
			status: "success",
			timestamp: "2026-08-23T08:30:00.000Z",
		};
		const calls: Array<{ body?: unknown; method: string; path: string }> = [];
		const receipts = initialReceipt ? [settledReceipt] : [];
		const status = {
			budget: {
				availableAtomic: initialReceipt ? "4750000" : "5000000",
				dailyCapAtomic: "5000000",
				pendingAtomic: "0",
				spentAtomic: initialReceipt ? "250000" : "0",
			},
			policy: {
				allowedOrigins: ["https://mpp.dev"],
				approvalThresholdAtomic: "0",
				autoPay: false,
				dailySpendCapAtomic: "5000000",
				enabledMethods: ["tempo"],
				maxPerRequestAtomic: "1000000",
				testnetOnly: true,
				version: 1,
			},
			wallet: {
				address: "0x1234567890abcdef1234567890abcdef12345678",
				balanceAtomic: "10000000",
				configured: true,
				currency: "pathUSD",
				decimals: 6,
				network: "Tempo testnet",
			},
		};

		const makePayment = (transport: "http" | "mcp") => ({
			kind: "payment_required",
			payment: {
				approvalToken: `approval-${transport}-proof`,
				budget: { ...status.budget },
				challenge: {
					amountAtomic: "250000",
					chainId: 42_431,
					challengeHash:
						"sha256:91a75a13df08c63c5d58c3368320e520b79de900905b8f26b53e633f8e9c2a9e",
					challengeId: "challenge-proof-001",
					currency: "0x20c0000000000000000000000000000000000000",
					decimals: 6,
					digest: "0x7f5daea22a8ce98a",
					expiresAt: "2030-08-23T08:35:00.000Z",
					intent: "charge",
					method: "tempo",
					origin: "https://mpp.dev",
					payee: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
					realm: "mpp.dev proof",
				},
				expiresAt: "2030-08-23T08:35:00.000Z",
				request:
					transport === "mcp"
						? { tool: "premium_tool", transport, url: "https://mpp.dev/mcp" }
						: {
								method: "GET",
								transport,
								url: "https://mpp.dev/api/ping/paid",
							},
				requiresApproval: true,
			},
		});

		const appRequest = async (input: {
			body?: unknown;
			method?: string;
			path: string;
		}) => {
			const method = input.method ?? "GET";
			calls.push({
				...(input.body === undefined ? undefined : { body: input.body }),
				method,
				path: input.path,
			});
			if (method === "GET" && input.path === "/status") {
				return status;
			}
			if (method === "GET" && input.path === "/services") {
				return {
					services: [
						{
							categories: ["payments", "developer tools"],
							description: "Official MPP challenge and settlement service.",
							endpoints: [
								{
									method: "GET",
									path: "/api/ping/paid",
									price: "0.25 pathUSD",
								},
							],
							id: "mpp-proof-service",
							name: "MPP Protocol",
							status: "available",
							url: "https://mpp.dev",
						},
					],
				};
			}
			if (method === "GET" && input.path === "/receipts") {
				return { receipts };
			}
			if (method === "POST" && input.path === "/payments/prepare") {
				return makePayment("http");
			}
			if (method === "POST" && input.path === "/payments/prepare-mcp") {
				return makePayment("mcp");
			}
			if (method === "POST" && input.path === "/payments/pay") {
				status.budget.availableAtomic = "4750000";
				status.budget.spentAtomic = "250000";
				if (receipts.length === 0) {
					receipts.push(settledReceipt);
				}
				return {
					receipt: settledReceipt,
					resource: {
						body: '{"ok":true}',
						contentType: "application/json",
						headers: {},
						status: 200,
					},
				};
			}
			throw new Error(`Unexpected MPP proof request: ${method} ${input.path}`);
		};

		const bridgeWindow =
			/* SAFETY: This private browser fixture replaces window.ryu with the exact app/context/shell provider assigned below; it does not implement the production RyuBridge. Other browser members retain the complete DOM Window contract. */ window as Omit<
				Window,
				"ryu"
			> & {
				__mppProofCalls?: typeof calls;
				ryu?: {
					app: {
						request: typeof appRequest;
					};
					context: null;
					shell: {
						subscribeTheme(options: {
							onChange(tokens: Record<string, string>): void;
						}): { dispose(): void };
					};
				};
			};
		bridgeWindow.__mppProofCalls = calls;
		bridgeWindow.ryu = {
			app: {
				request: appRequest,
			},
			context: null,
			shell: {
				subscribeTheme({ onChange }) {
					onChange({
						"--accent": "oklch(0.97 0 0)",
						"--accent-foreground": "oklch(0.205 0 0)",
						"--background": "oklch(1 0 0)",
						"--border": "oklch(0.922 0 0)",
						"--card": "oklch(1 0 0)",
						"--card-foreground": "oklch(0.145 0 0)",
						"--destructive": "oklch(0.577 0.245 27.325)",
						"--foreground": "oklch(0.145 0 0)",
						"--input": "oklch(0.922 0 0)",
						"--muted": "oklch(0.97 0 0)",
						"--muted-foreground": "oklch(0.556 0 0)",
						"--primary": "#0099ff",
						"--primary-foreground": "oklch(0.97 0.014 254.604)",
						"--radius": "0.625rem",
						"--ring": "oklch(0.708 0 0)",
						"--secondary": "oklch(0.97 0 0)",
						"--secondary-foreground": "oklch(0.205 0 0)",
						"--success": "oklch(0.62 0.17 145)",
					});
					return { dispose: () => undefined };
				},
			},
		};
	}, options);
}

async function proofCalls(
	page: Page
): Promise<Array<{ method: string; path: string }>> {
	return page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __mppProofCalls on its own browser window. */ window as Window &
				typeof window & {
					__mppProofCalls?: Array<{ method: string; path: string }>;
				};
		return proofWindow.__mppProofCalls ?? [];
	});
}

test("reviews an exact HTTP charge and settles to a safe receipt", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("requestfailed", (request) => {
		failedRequests.push(
			`${request.method()} ${new URL(request.url()).pathname}`
		);
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await installMppBridge(page);
	await page.goto("/");

	await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();
	await expect(page.getByLabel("Payment status")).toContainText("0 / 5");
	await page.getByRole("button", { name: /Review payment/ }).click();

	const dialog = page.getByRole("dialog", { name: "Approve 0.25 pathUSD?" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("https://mpp.dev");
	await expect(dialog).toContainText("Tempo testnet · 42431");
	await expect(dialog).toContainText("Available now5");
	await expect(dialog).toContainText("After payment4.75");
	await expect(dialog).toContainText(payeeAddress.slice(0, 10));
	await expect(dialog).toContainText(challengeHash.slice(0, 12));
	await page.screenshot({
		fullPage: true,
		path: path.join(proofDirectory, "mpp-payment-approval.png"),
	});

	await dialog.getByRole("button", { name: "Approve & pay" }).click();
	await expect(
		page.getByText("Payment verified and receipt saved.")
	).toBeVisible();
	await expect(page.getByLabel("Receipt detail")).toContainText(
		"Payment settled"
	);
	await expect(page.getByLabel("Receipt detail")).toContainText("0.25 pathUSD");
	await expect(page.getByLabel("Receipt detail")).toContainText(
		"receipt-proof-001"
	);
	await expect(page.getByLabel("Payment status")).toContainText("0.25 / 5");
	await expect(page.getByRole("tab", { name: "Services" })).toHaveAttribute(
		"aria-selected",
		"false"
	);
	await expect(page.getByRole("tab", { name: /Receipts/ })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await page.waitForTimeout(250);
	await page.screenshot({
		fullPage: true,
		path: path.join(proofDirectory, "mpp-payment-settled.png"),
	});

	const observedCalls = await proofCalls(page);
	const observedRequests = observedCalls.map(
		({ method, path }) => `${method} ${path}`
	);
	expect(observedRequests).toEqual(
		expect.arrayContaining([
			"GET /status",
			"GET /services",
			"GET /receipts",
			"POST /payments/prepare",
			"POST /payments/pay",
		])
	);
	expect(
		observedRequests.filter((request) => request === "POST /payments/prepare")
	).toHaveLength(1);
	expect(
		observedRequests.filter((request) => request === "POST /payments/pay")
	).toHaveLength(1);
	const safeCalls = observedCalls.map(({ method, path: requestPath }) => ({
		method,
		path: requestPath,
	}));
	await writeFile(
		path.join(proofDirectory, "mpp-payments-e2e.log.json"),
		`${JSON.stringify(
			{
				assertions: {
					approvalExactAmount: true,
					budgetDelta: "5 -> 4.75 pathUSD",
					receiptSaved: true,
					settledAmount: "0.25 pathUSD",
					walletAddress: `${walletAddress.slice(0, 8)}…${walletAddress.slice(-6)}`,
				},
				browser: {
					consoleErrors,
					failedRequests,
					pageErrors,
				},
				calls: safeCalls,
				result:
					consoleErrors.length === 0 &&
					pageErrors.length === 0 &&
					failedRequests.length === 0
						? "verified"
						: "failed",
			},
			null,
			2
		)}\n`
	);
	expect(consoleErrors).toEqual([]);
	expect(pageErrors).toEqual([]);
	expect(failedRequests).toEqual([]);
});

test("surfaces MCP purpose and rejects without spending", async ({ page }) => {
	await installMppBridge(page);
	await page.goto("/");

	await page.getByLabel("Payment protocol transport").selectOption("mcp");
	await page.getByLabel("MCP server URL").fill("https://mpp.dev/mcp");
	await page.getByLabel("MCP tool name").fill("premium_tool");
	await page.getByRole("button", { name: /Review payment/ }).click();

	const dialog = page.getByRole("dialog", { name: "Approve 0.25 pathUSD?" });
	await expect(dialog).toContainText("MCP · premium_tool");
	await dialog.getByRole("button", { name: "Reject" }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(async () =>
			(await proofCalls(page)).some(({ path }) => path === "/payments/pay")
		)
		.toBe(false);

	await page.getByRole("tab", { name: "Services" }).focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByRole("tab", { name: "Policy" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(page.getByRole("tab", { name: "Policy" })).toBeFocused();
});

test("keeps the settled ledger usable at a mobile viewport", async ({
	page,
}) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await installMppBridge(page, { initialReceipt: true });
	await page.goto("/");
	await page.getByRole("tab", { name: /Receipts/ }).click();

	await expect(page.getByRole("tab", { name: "Services" })).toHaveAttribute(
		"aria-selected",
		"false"
	);
	await expect(page.getByRole("tab", { name: /Receipts/ })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(page.getByLabel("Receipt detail")).toContainText(
		"Payment settled"
	);
	await expect(page.getByLabel("Receipt detail")).toContainText("0.25 pathUSD");
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth
			)
		)
		.toBe(true);
	await page.waitForTimeout(250);
	await page.screenshot({
		fullPage: true,
		path: path.join(proofDirectory, "mpp-payment-mobile-receipt.png"),
	});
});
