import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const PROOF_NODE_URL = "http://proof.local";
const proofDirectory = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface ProofRequest {
	body?: unknown;
	headers: Record<string, string>;
	method: string;
	url: string;
}

interface ProofTab {
	conversationId?: string;
	initialPrompt?: string;
	path: string;
	title: string;
}

interface ProofState {
	activeTabId: string;
	openedTabs: ProofTab[];
	requests: ProofRequest[];
}

function watchBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

async function openProof(page: Page, query = "reset=1") {
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto(`/bot-profile-card-proof.html?${query}`, {
		waitUntil: "domcontentloaded",
	});
	const card = page.getByTestId("bot-profile-card");
	await expect(card).toBeVisible();
	return card;
}

async function readProof(page: Page): Promise<ProofState> {
	return await page.evaluate(() => {
		const proof =
			/* SAFETY: bot-profile-card-proof.tsx installs __botProfileCardProof before this proof page is evaluated. */ (
				window as Window & { __botProfileCardProof?: ProofState }
			).__botProfileCardProof;
		if (!proof) {
			throw new Error("Bot profile proof state was not installed");
		}
		return {
			activeTabId: proof.activeTabId,
			openedTabs: proof.openedTabs,
			requests: proof.requests,
		};
	});
}

async function requestsTo(
	page: Page,
	pathSuffix: string
): Promise<ProofRequest[]> {
	const proof = await readProof(page);
	return proof.requests.filter((request) => request.url.endsWith(pathSuffix));
}

async function setFailure(page: Page, key: string, count: number) {
	await page.evaluate(
		({ key: failureKey, count: failureCount }) => {
			const proof =
				/* SAFETY: bot-profile-card-proof.tsx installs __botProfileCardProof before this proof page is evaluated. */ (
					window as Window & {
						__botProfileCardProof?: {
							failNext: Record<string, number>;
						};
					}
				).__botProfileCardProof;
			if (!proof) {
				throw new Error("Bot profile proof state was not installed");
			}
			proof.failNext[failureKey] = failureCount;
		},
		{ count, key }
	);
}

async function expectOpenedTab(page: Page, tab: ProofTab) {
	await expect
		.poll(async () => (await readProof(page)).openedTabs)
		.toEqual(expect.arrayContaining([expect.objectContaining(tab)]));
}

async function saveProofScreenshot(page: Page, name: string) {
	await mkdir(proofDirectory, { recursive: true });
	await page.screenshot({
		fullPage: true,
		path: path.join(proofDirectory, name),
	});
}

test("overview routes to the correct chat actions and remembers collapse state", async ({
	page,
}) => {
	const browserErrors = watchBrowserErrors(page);
	const card = await openProof(page);
	await expect(card.getByTitle("Preparing the launch checklist")).toBeVisible();
	await expect(card.getByTestId("bot-profile-summary")).toContainText(
		"1 working"
	);
	await expect(card.getByRole("tab", { name: "Overview" })).toHaveAttribute(
		"aria-selected",
		"true"
	);

	await expect
		.poll(async () => (await requestsTo(page, "/api/activity?limit=24")).length)
		.toBe(1);
	await expect
		.poll(async () => (await requestsTo(page, "/api/approvals")).length)
		.toBe(1);
	await expect
		.poll(
			async () =>
				(await requestsTo(page, "/api/conversations/chat-goal/goal")).length
		)
		.toBe(1);
	await expect
		.poll(
			async () =>
				(await requestsTo(page, "/api/conversations/chat-passive/goal")).length
		)
		.toBe(1);
	await expect(
		card.getByRole("button", { name: /Completed a planning pass/ })
	).toBeVisible();
	await saveProofScreenshot(page, "bot-profile-card-overview-proof.png");
	const allInitialRequests = (await readProof(page)).requests;
	const componentReads = allInitialRequests.filter((request) => {
		const url = new URL(request.url);
		return (
			url.pathname === "/api/activity" ||
			url.pathname === "/api/approvals" ||
			/^\/api\/conversations\/[^/]+\/goal$/.test(url.pathname)
		);
	});
	expect(
		componentReads
			.map(({ method, url }) => {
				const parsed = new URL(url);
				return `${method} ${parsed.pathname}${parsed.search}`;
			})
			.sort()
	).toEqual(
		[
			"GET /api/activity?limit=24",
			"GET /api/approvals",
			"GET /api/conversations/chat-goal/goal",
			"GET /api/conversations/chat-passive/goal",
		].sort()
	);
	expect(
		allInitialRequests.every((request) =>
			request.url.startsWith(`${PROOF_NODE_URL}/api/`)
		)
	).toBe(true);
	expect(
		allInitialRequests.every(
			(request) => request.headers.authorization === "Bearer node-token-proof"
		)
	).toBe(true);

	await card.getByRole("button", { name: /Completed a planning pass/ }).click();
	await expectOpenedTab(page, {
		conversationId: "chat-goal",
		path: "/chat",
		title: "Completed a planning pass",
	});
	await card
		.getByRole("button", { name: /Draft reply needs approval/ })
		.click();
	await expect(card.getByRole("tab", { name: "Feed" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		card.getByText("Completed a planning pass", { exact: true })
	).toBeVisible();
	await card.getByRole("tab", { name: "Overview" }).click();

	await card.getByRole("button", { name: /Working on launch plan/ }).click();
	await expectOpenedTab(page, {
		initialPrompt:
			"Continue the work currently shown as “Working on launch plan”.",
		path: "/chat",
		title: "Working on launch plan",
	});
	await card.getByRole("button", { name: "Ask Ryu", exact: true }).click();
	await expectOpenedTab(page, {
		initialPrompt: "Summarize my recent Ryu activity.",
		path: "/chat",
		title: "Recent work",
	});
	await card.getByRole("button", { name: "Open Mission Control" }).click();
	await expectOpenedTab(page, {
		initialPrompt: "Give me a Mission Control summary of my recent work.",
		path: "/chat",
		title: "Mission Control",
	});

	await card.getByRole("button", { name: "Collapse bot activity" }).click();
	await expect(
		card.getByRole("button", { name: "Expand bot activity" })
	).toHaveAttribute("aria-expanded", "false");
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu:bot-profile-card-collapsed:v1")
		)
	).toBe("true");
	await page.reload({ waitUntil: "domcontentloaded" });
	const reloadedCard = page.getByTestId("bot-profile-card");
	await expect(
		reloadedCard.getByRole("button", { name: "Expand bot activity" })
	).toBeVisible();
	await reloadedCard
		.getByRole("button", { name: "Expand bot activity" })
		.click();
	await expect(
		reloadedCard.getByRole("tab", { name: "Overview" })
	).toBeVisible();
	await expect(
		reloadedCard.getByRole("button", { name: "Collapse bot activity" })
	).toBeVisible();
	expect(browserErrors).toEqual([]);
});

test("approval decisions and goal controls preserve the server state across errors and retries", async ({
	page,
}) => {
	const browserErrors = watchBrowserErrors(page);
	const card = await openProof(page, "reset=1&failGoalReadsOnce=2");
	await card.getByRole("tab", { name: "Approvals" }).click();
	await expect(
		card.getByText("Send launch update", { exact: true })
	).toBeVisible();
	await expect(
		card.getByText("Post the reviewed project note", { exact: true })
	).toBeVisible();

	await setFailure(page, "approvalMutation", 1);
	await card.getByRole("button", { name: "Deny", exact: true }).first().click();
	await expect(
		page.getByRole("button", {
			name: /Approvals .*reject failed: 503/,
		})
	).toBeVisible();
	await expect(
		card.getByText("Send launch update", { exact: true })
	).toBeVisible();
	await card.getByRole("button", { name: "Deny", exact: true }).first().click();
	await expect(
		card.getByText("Send launch update", { exact: true })
	).toHaveCount(0);
	await card.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(
		card.getByText("Nothing needs your decision", { exact: true })
	).toBeVisible();

	const decisions = (await readProof(page)).requests.filter((request) =>
		/^http:\/\/proof\.local\/api\/approvals\/[^/]+\/(approve|reject)$/.test(
			request.url
		)
	);
	expect(
		decisions.map(({ body, method, url }) => ({
			body,
			method,
			url: url.replace(PROOF_NODE_URL, ""),
		}))
	).toEqual([
		{
			body: {},
			method: "POST",
			url: "/api/approvals/approval-send-message/reject",
		},
		{
			body: {},
			method: "POST",
			url: "/api/approvals/approval-send-message/reject",
		},
		{
			body: {},
			method: "POST",
			url: "/api/approvals/approval-review-project-note/approve",
		},
	]);
	expect(
		decisions.every(
			(request) => request.headers.authorization === "Bearer node-token-proof"
		)
	).toBe(true);

	await card.getByRole("tab", { name: "Goals" }).click();
	await expect(
		card.getByText("Goals are unavailable", { exact: true })
	).toBeVisible();
	await card.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(card.getByText("Active · 1", { exact: true })).toBeVisible();
	await expect(card.getByText("Passive · 1", { exact: true })).toBeVisible();
	await card
		.getByRole("button", {
			name: /Turn the launch notes into a shippable checklist/,
		})
		.click();
	await expectOpenedTab(page, {
		conversationId: "chat-goal",
		path: "/chat",
		title: "Launch plan",
	});

	await setFailure(page, "goalPause", 1);
	await card.getByRole("button", { name: "Pause goal" }).click();
	await expect(
		page.getByText(
			"This goal hasn’t changed. Check the connection and try again."
		)
	).toBeVisible();
	await expect(card.getByRole("button", { name: "Pause goal" })).toBeEnabled();
	await card.getByRole("button", { name: "Pause goal" }).click();
	await expect(card.getByText("Passive · 2", { exact: true })).toBeVisible();
	await expect(card.getByRole("button", { name: "Resume goal" })).toHaveCount(
		2
	);
	await card.getByRole("button", { name: "Resume goal" }).nth(1).click();
	await expect(card.getByText("Active · 1", { exact: true })).toBeVisible();
	await expect(card.getByText("Passive · 1", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Sileo Notification/ })
	).toHaveCount(0, { timeout: 10_000 });

	const goalMutations = (await readProof(page)).requests.filter((request) =>
		/\/api\/conversations\/[^/]+\/goal\/(pause|resume)$/.test(request.url)
	);
	expect(
		goalMutations.map(({ body, method, url }) => ({
			body,
			method,
			url: url.replace(PROOF_NODE_URL, ""),
		}))
	).toEqual([
		{
			body: undefined,
			method: "POST",
			url: "/api/conversations/chat-goal/goal/pause",
		},
		{
			body: undefined,
			method: "POST",
			url: "/api/conversations/chat-goal/goal/pause",
		},
		{
			body: undefined,
			method: "POST",
			url: "/api/conversations/chat-passive/goal/resume",
		},
	]);
	expect(
		goalMutations.every(
			(request) => request.headers.authorization === "Bearer node-token-proof"
		)
	).toBe(true);
	await saveProofScreenshot(page, "bot-profile-card-goals-proof.png");
	expect(browserErrors).toEqual([]);
});

test("feed filters and reactions stay local, survive reload, and offer a data retry", async ({
	page,
}) => {
	const browserErrors = watchBrowserErrors(page);
	const card = await openProof(page, "reset=1&failActivityOnce=1");
	await card.getByRole("tab", { name: "Feed" }).click();
	await expect(
		card.getByText("Activity is unavailable", { exact: true })
	).toBeVisible();
	await card.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		card.getByText("Completed a planning pass", { exact: true })
	).toBeVisible();
	await expect(
		card.getByText("Monitor caught a deployment retry", { exact: true })
	).toBeVisible();

	const summaryPost = card
		.locator("article")
		.filter({ hasText: "Completed a planning pass" });
	const requestsBeforeLocalChanges = (await readProof(page)).requests;
	await summaryPost.getByRole("button", { name: "Like", exact: true }).click();
	await expect(
		summaryPost.getByRole("button", { name: "Liked", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await summaryPost.getByRole("button", { name: /^Comment/ }).click();
	const commentInput = summaryPost.getByLabel("Comment on this activity");
	await commentInput.fill("  Keep this in the launch review.  ");
	await summaryPost.getByRole("button", { name: "Post", exact: true }).click();
	await expect(
		summaryPost.getByText("Keep this in the launch review.", { exact: true })
	).toBeVisible();
	await expect(commentInput).toHaveValue("");
	const engagement = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu:bot-feed-engagement:v1") ?? "{}")
	);
	expect(engagement).toEqual({
		comments: { "activity-summary": ["Keep this in the launch review."] },
		liked: ["activity-summary"],
	});

	await card.getByRole("button", { name: "Customize feed" }).first().click();
	await page.getByRole("checkbox", { name: "Show Watch" }).first().click();
	await page.keyboard.press("Escape");
	await expect(
		card.getByText("Monitor caught a deployment retry", { exact: true })
	).toHaveCount(0);
	await card.getByRole("button", { name: "Customize feed" }).last().click();
	await page.getByRole("checkbox", { name: "Show Watch" }).last().click();
	await page.getByRole("checkbox", { name: "Show Goals" }).last().click();
	await page.keyboard.press("Escape");
	await expect(
		card.getByText("Monitor caught a deployment retry", { exact: true })
	).toBeVisible();
	await expect(
		card.getByText("Kept two follow-ups in view", { exact: true })
	).toHaveCount(0);
	const preferences = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu:bot-feed-preferences:v1") ?? "{}")
	);
	expect(preferences).toEqual({
		sources: ["runs", "approvals", "notes", "watch"],
	});
	const afterLocalChanges = await readProof(page);
	expect(afterLocalChanges.requests).toEqual(requestsBeforeLocalChanges);
	expect(
		afterLocalChanges.requests.every((request) =>
			request.url.startsWith(`${PROOF_NODE_URL}/api/`)
		)
	).toBe(true);
	expect(
		afterLocalChanges.requests.filter(
			(request) =>
				request.method === "POST" &&
				(request.url.includes("/api/activity") ||
					request.url.includes("/api/approvals") ||
					request.url.includes("/api/conversations/"))
		)
	).toEqual([]);

	await summaryPost.getByRole("button", { name: "Reply as Ryu" }).click();
	await expectOpenedTab(page, {
		initialPrompt:
			"Reply to this Ryu activity update:\n\nCompleted a planning pass\nPulled the open work from three chats into one next-step summary.\n\nHelp me decide the next useful response. Keep external actions behind approval.",
		path: "/chat",
		title: "Reply to activity",
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	const reloadedCard = page.getByTestId("bot-profile-card");
	await expect(reloadedCard).toBeVisible();
	await reloadedCard.getByRole("tab", { name: "Feed" }).click();
	await expect(
		reloadedCard.getByRole("button", { name: "Liked", exact: true })
	).toBeVisible();
	await expect(
		reloadedCard.getByText("Keep this in the launch review.", { exact: true })
	).toBeVisible();
	await expect(
		reloadedCard.getByText("Monitor caught a deployment retry", { exact: true })
	).toBeVisible();
	await expect(
		reloadedCard.getByText("Kept two follow-ups in view", { exact: true })
	).toHaveCount(0);
	await saveProofScreenshot(page, "bot-profile-card-feed-proof.png");
	expect(browserErrors).toEqual([]);
});

test("empty goal state opens a chat with the guided goal prompt", async ({
	page,
}) => {
	const browserErrors = watchBrowserErrors(page);
	const card = await openProof(page, "reset=1&emptyGoals=1");
	await card.getByRole("tab", { name: "Goals" }).click();
	await expect(card.getByText("No goals yet", { exact: true })).toBeVisible();
	await card
		.getByRole("button", { name: "Set a goal in chat", exact: true })
		.click();
	await expectOpenedTab(page, {
		initialPrompt:
			"I want to set a goal. Help me turn what I want into a clear outcome and a next step.",
		path: "/chat",
		title: "Set a goal",
	});
	expect(browserErrors).toEqual([]);
});
