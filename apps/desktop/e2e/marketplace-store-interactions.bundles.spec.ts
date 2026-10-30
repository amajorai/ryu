import { expect, test } from "@playwright/test";
import {
	installLocalFixture,
	STORY_URL,
} from "./marketplace-store-interactions.fixture.ts";

test.describe.configure({ timeout: 90_000 });

test("agent templates disclose stripped access, fail safely, and retry the same install intent", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=agents`);
	await expect(
		page.getByText("Agent Templates", { exact: true })
	).toBeVisible();
	const communityCard = page.getByRole("button", {
		name: /Research Agent.*Local Fixture Publisher/,
	});
	const communityBuy = communityCard.getByRole("button", { name: /\$12\.00/ });
	await communityCard.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: testInfo.outputPath("agent-template-card-before-buy.png"),
	});
	await communityBuy.click();
	await expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/purchase")
			.map((call) => call.body)
	).toEqual([{ id: "fixture/research-agent", kind: "agent" }]);
	await expect(page.getByTestId("harness-effects")).toContainText(
		"https://checkout.example.test/session/fixture"
	);
	await communityCard.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Get", exact: true })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Get", exact: true }).click();
	await expect(
		page.getByText("Couldn't install this agent", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Add", exact: true }).first().click();
	await expect(
		page.getByText("Couldn't install this agent", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("dialog", { name: "Research Agent" })
	).toHaveCount(0);
	await communityCard.click();
	const detail = page.getByRole("dialog", { name: "Research Agent" });
	await expect(detail).toContainText(
		"It gets none of your credentials, Spaces or Composio actions."
	);
	await expect(detail).toContainText(
		"You can limit which of your accounts it may use under Account access after adding it."
	);
	await detail.getByRole("button", { name: /\$12\.00/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__marketplaceStoreEffects?.externalUrls.length ?? 0
			)
		)
		.toBe(2);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/purchase")
			.map((call) => call.body)
	).toEqual([
		{ id: "fixture/research-agent", kind: "agent" },
		{ id: "fixture/research-agent", kind: "agent" },
	]);
	await detail.getByRole("button", { name: "Add" }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/published/install"
				).length
		)
		.toBe(3);
	await expect(
		detail.getByText("Set this up yourself", { exact: true })
	).toBeVisible();
	await expect(detail).toContainText("com.ryu.web-search");
	await expect(detail).toContainText("GMAIL_LIST_MESSAGES");
	await expect(detail).toContainText("It asked for 2 Spaces");
	await detail.screenshot({
		path: testInfo.outputPath("agent-template-installed-disclosure.png"),
	});
	await page.getByRole("button", { name: "Close" }).click();
	await expect(detail).toHaveCount(0);
	expect(fixture.publishedAgents).toEqual(["fixture/research-agent"]);
	const installWrites = fixture.calls.filter(
		(call) => call.path === "/api/agents/published/install"
	);
	expect(installWrites).toHaveLength(3);
	// SAFETY: These records are filtered to the mounted published-agent install route; installPublishedAgent serializes fixture string IDs and its string idempotency key into each captured body.
	const payloads = installWrites.map(
		(call) => call.body as { id: string; idempotency_key: string }
	);
	expect(payloads.map((payload) => payload.id)).toEqual([
		"fixture/research-agent",
		"fixture/research-agent",
		"fixture/research-agent",
	]);
	expect(new Set(payloads.map((payload) => payload.idempotency_key)).size).toBe(
		1
	);
	expect(
		JSON.parse(
			payloads[0]?.idempotency_key.slice("community-agent-v1:".length) ?? "{}"
		)
	).toEqual({
		accountId: "marketplace-store-fixture-user",
		id: "fixture/research-agent",
		node: "http://127.0.0.1:5189",
	});
	expect(
		fixture.calls.some((call) => call.path === "/api/plugins/catalog/install")
	).toBe(false);
});

test("bundle cards like and open trusted detail with source and member state", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=bundles`);
	const bundlesTab = page.getByRole("tab", { name: "Bundles" });
	await expect(bundlesTab).toHaveAttribute("aria-selected", "true");
	const bundleCard = page
		.locator("section")
		.filter({
			has: page.getByRole("heading", { name: "From the Marketplace" }),
		})
		.filter({ hasText: "Agent Setup Bundle" });
	await expect(bundleCard).toBeVisible();
	await expect(bundleCard).toContainText("2 items · one-click install");
	await expect(
		bundleCard.getByRole("button", { name: "Buy", exact: true })
	).toHaveCount(0);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.method === "GET" &&
					call.path === "/api/marketplace/catalog" &&
					call.search === "?kind=bundle"
			)
		)
		.toBe(true);

	const like = bundleCard.getByRole("button", { name: "Like (2)" });
	await expect(like).toHaveAttribute("aria-pressed", "false");
	await like.click();
	const liked = bundleCard.getByRole("button", { name: "Unlike (3)" });
	await expect(liked).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(() => fixture.likes["fixture/agent-setup-bundle"]?.count)
		.toBe(3);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.method === "POST" && call.path === "/api/marketplace/likes"
				).length
		)
		.toBe(1);
	await liked.click();
	await expect(
		bundleCard.getByRole("button", { name: "Like (2)" })
	).toHaveAttribute("aria-pressed", "false");
	await expect
		.poll(() => fixture.likes["fixture/agent-setup-bundle"]?.count)
		.toBe(2);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/likes")
			.map((call) => ({ method: call.method, body: call.body }))
	).toEqual([
		{ method: "POST", body: { namespace: "fixture/agent-setup-bundle" } },
		{ method: "DELETE", body: { namespace: "fixture/agent-setup-bundle" } },
	]);

	await bundleCard
		.getByRole("button", {
			name: /Agent Setup Bundle.*Local Fixture Publisher/,
		})
		.click();
	const detail = page.getByRole("dialog", { name: "Agent Setup Bundle" });
	await expect(detail).toContainText(
		"Install the safe agent setup in one reviewable action."
	);
	await expect(detail).toContainText("Research Agent");
	await expect(detail).toContainText("agent · fixture/research-agent");
	await expect(detail).toContainText("Required");
	await expect(detail).toContainText("Weekly Review Workflow");
	await expect(detail).toContainText("workflow · fixture/weekly-review");
	await expect(detail).toContainText("Optional");
	const source = detail.getByRole("link", { name: "View topic source" });
	await expect(source).toHaveAttribute(
		"href",
		"https://example.test/topic/source"
	);
	await expect(source).toHaveAttribute("target", "_blank");
	await expect(source).toHaveAttribute("rel", "noopener noreferrer");
	await detail.screenshot({
		path: testInfo.outputPath("bundle-detail-members-and-safe-source.png"),
	});
});

test("bundle card and detail install use kind-specific members, expose retry, and read back installed state", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	fixture.communityAgentInstallFailures = 1;
	fixture.communityAgentInstallGate = new Promise<void>((resolve) => {
		fixture.releaseCommunityAgentInstall = resolve;
	});
	await page.goto(`${STORY_URL}?section=bundles`);
	const bundleCard = page
		.locator("section")
		.filter({
			has: page.getByRole("heading", { name: "From the Marketplace" }),
		})
		.filter({ hasText: "Agent Setup Bundle" });
	const cardInstall = bundleCard.getByRole("button", {
		name: "Install bundle",
	});
	await cardInstall.click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/published/install"
				).length
		)
		.toBe(1);
	await expect(page.getByText("Installing 0/2", { exact: true })).toBeVisible();
	await expect(cardInstall).toBeDisabled();
	fixture.releaseCommunityAgentInstall?.();
	await expect(
		page.getByText("Bundle installed with required items missing", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByText(/1 installed, 0 already present, 1 required failed/)
	).toBeVisible();
	await expect.poll(() => fixture.workflows).toEqual(["fixture/weekly-review"]);
	await expect.poll(() => fixture.publishedAgents).toEqual([]);
	await expect
		.poll(
			() =>
				fixture.calls.filter((call) => call.path === "/api/marketplace/usage")
					.length
		)
		.toBe(1);

	await cardInstall.click();
	await expect(
		page.getByText("Bundle installed", { exact: true })
	).toBeVisible();
	// The detailed installed/skipped summary is a short-lived toast. Assert it
	// while it is still onscreen, before the readback polls below.
	await expect(
		page.getByText("1 installed, 1 already present", { exact: false })
	).toBeVisible();
	await expect
		.poll(() => fixture.publishedAgents)
		.toEqual(["fixture/research-agent"]);
	await expect.poll(() => fixture.workflows).toEqual(["fixture/weekly-review"]);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/published/install"
				).length
		)
		.toBe(2);
	const dialogOpener = bundleCard.getByRole("button", {
		name: /Agent Setup Bundle.*Local Fixture Publisher/,
	});
	await dialogOpener.click();
	const detail = page.getByRole("dialog", { name: "Agent Setup Bundle" });
	await expect(detail).toBeVisible();
	const detailInstall = detail.getByRole("button", { name: "Install bundle" });
	await detailInstall.click();
	await expect(
		page.getByText("Bundle installed", { exact: true })
	).toBeVisible();
	await expect
		.poll(() => fixture.publishedAgents)
		.toEqual(["fixture/research-agent"]);
	await expect.poll(() => fixture.workflows).toEqual(["fixture/weekly-review"]);
	await expect(detail).toContainText("Bundle contents");
	await detail.screenshot({
		path: testInfo.outputPath("bundle-detail-installed-readback.png"),
	});

	const installRequests = fixture.calls.filter((call) =>
		[
			"/api/agents/published/install",
			"/api/workflows/catalog/install",
		].includes(call.path)
	);
	expect(installRequests.map((call) => call.path)).toEqual([
		"/api/agents/published/install",
		"/api/workflows/catalog/install",
		"/api/agents/published/install",
		"/api/workflows/catalog/install",
		"/api/agents/published/install",
		"/api/workflows/catalog/install",
	]);
	const agentRequests = installRequests.filter(
		(call) => call.path === "/api/agents/published/install"
	);
	for (const call of agentRequests) {
		// SAFETY: This record is filtered to the mounted published-agent install route; the bundle installer supplies its member string ID and generated string key to installPublishedAgent, which serializes both fields.
		const body = call.body as { id: string; idempotency_key: string };
		expect(body.id).toBe("fixture/research-agent");
		expect(body.idempotency_key).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
	}
	expect(
		installRequests
			.filter((call) => call.path === "/api/workflows/catalog/install")
			.map((call) => call.body)
	).toEqual([
		{ template_id: "fixture/weekly-review" },
		{ template_id: "fixture/weekly-review" },
		{ template_id: "fixture/weekly-review" },
	]);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/usage")
			.map((call) => call.body)
	).toEqual([
		{ event: "download", id: "fixture/agent-setup-bundle", kind: "bundle" },
		{ event: "download", id: "fixture/agent-setup-bundle", kind: "bundle" },
		{ event: "download", id: "fixture/agent-setup-bundle", kind: "bundle" },
	]);
});

test("workflow catalog prices, purchases, and records checkout handoff without leaving the Store", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=workflows`);
	const workflowTab = page.getByRole("tab", { name: "Workflow Templates" });
	await expect(workflowTab).toHaveAttribute("aria-selected", "true");
	const workflowStrip = page
		.locator("section")
		.filter({
			has: page.getByRole("heading", { name: "From the Marketplace" }),
		})
		.filter({ hasText: "Weekly Review Workflow" });
	await expect(workflowStrip).toBeVisible();
	await expect(workflowStrip).toContainText("$12.00");
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.method === "GET" &&
					call.path === "/api/marketplace/catalog" &&
					call.search === "?kind=workflow"
			)
		)
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("workflow-catalog-priced-card.png"),
	});

	const originalUrl = page.url();
	await workflowStrip.getByRole("button", { name: "Buy", exact: true }).click();
	await expect
		.poll(() =>
			fixture.calls.filter((call) => call.path === "/api/marketplace/purchase")
		)
		.toHaveLength(1);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/purchase")
			.map((call) => call.body)
	).toEqual([{ id: "fixture/weekly-review", kind: "workflow" }]);
	await expect(page.getByTestId("harness-effects")).toContainText(
		"https://checkout.example.test/session/fixture"
	);
	await expect(page).toHaveURL(originalUrl);
	await expect(workflowTab).toHaveAttribute("aria-selected", "true");
	await expect(workflowStrip).toBeVisible();
	await expect(
		page.getByText("Opening checkout…", { exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("workflow-checkout-handoff-recorded.png"),
	});
});
