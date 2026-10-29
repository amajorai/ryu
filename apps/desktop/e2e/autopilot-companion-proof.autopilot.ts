import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { normalizeState } from "../../../apps-store/autopilot/ui/src/model.ts";
import type { AutopilotState } from "../../../apps-store/autopilot/ui/src/types.ts";
import { parseProofJson } from "./fixture-json.ts";
import type {
	AutopilotProofApi,
	AutopilotProofCall,
} from "./harness/autopilot-companion-proof.types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appHtmlPath = process.env.RYU_AUTOPILOT_BUILD_HTML;
if (!appHtmlPath) {
	throw new Error(
		"Run this proof with autopilot-companion-proof.playwright.config.ts so the production satellite is built first."
	);
}
const evidenceDirectory = path.resolve(
	here,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const APP_HTML = await readFile(appHtmlPath, "utf8");

declare global {
	interface Window {
		__autopilotProof: AutopilotProofApi;
	}
}

test.use({
	viewport: { height: 1050, width: 1500 },
	contextOptions: { reducedMotion: "reduce" },
});

async function mount(
	page: Page,
	options: { fresh?: boolean; section?: string } = {}
): Promise<FrameLocator> {
	if (!page.url().endsWith("/autopilot-companion-proof.html")) {
		await page.goto("/autopilot-companion-proof.html", {
			waitUntil: "domcontentloaded",
		});
	}
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
	await expect
		.poll(() => page.evaluate(() => Boolean(window.__autopilotProof)))
		.toBe(true);
	if (options.fresh) {
		await page.evaluate(() => window.__autopilotProof.reset());
	}
	await page.evaluate(
		({ appHtml, section }) =>
			window.__autopilotProof.mount({
				appHtml,
				...(section ? { section } : undefined),
			}),
		{ appHtml: APP_HTML, section: options.section }
	);
	await expect
		.poll(() => page.evaluate(() => window.__autopilotProof.connected()))
		.toBe(true);
	const companion = page.frameLocator('iframe[title="Autopilot proof"]');
	await expect(companion.locator(".autopilot-root")).toBeVisible();
	return companion;
}

async function remount(page: Page, section?: string): Promise<FrameLocator> {
	return await mount(page, { section });
}

async function storedState(page: Page): Promise<AutopilotState | null> {
	const value = await page.evaluate(() =>
		window.__autopilotProof.storedState()
	);
	return value ? normalizeState(parseProofJson(value)) : null;
}

async function calls(page: Page): Promise<AutopilotProofCall[]> {
	return await page.evaluate(() => window.__autopilotProof.calls());
}

async function waitForStoredState(
	page: Page,
	predicate: (state: AutopilotState | null) => boolean
): Promise<AutopilotState> {
	await expect.poll(async () => predicate(await storedState(page))).toBe(true);
	const state = await storedState(page);
	if (!state) {
		throw new Error("Autopilot did not persist its state to the local host.");
	}
	return state;
}

async function waitForCall(
	page: Page,
	method: AutopilotProofCall["method"],
	count: number
): Promise<AutopilotProofCall[]> {
	await expect
		.poll(
			async () =>
				(await calls(page)).filter((call) => call.method === method).length
		)
		.toBeGreaterThanOrEqual(count);
	return await calls(page);
}

async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(evidenceDirectory, { recursive: true });
	await companion.locator("body").screenshot({
		path: path.join(evidenceDirectory, filename),
	});
}

async function scrollToTop(companion: FrameLocator): Promise<void> {
	await companion.locator(".autopilot-main").evaluate((element) => {
		if (element instanceof HTMLElement) {
			element.scrollTo(0, 0);
		}
	});
}

function lastCall(
	allCalls: AutopilotProofCall[],
	method: AutopilotProofCall["method"]
): AutopilotProofCall {
	const call = allCalls.filter((item) => item.method === method).at(-1);
	if (!call) {
		throw new Error(`No Autopilot ${method} call was recorded.`);
	}
	return call;
}

test("the overview saves a real brief, runs through the host, and routes every strategy shortcut", async ({
	page,
}) => {
	let companion = await mount(page, { fresh: true });
	await expect(
		companion.getByText("Node-owned", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Run strategy pass" })
	).toBeDisabled();

	await companion.getByLabel("Product name").fill("Ledger Lens");
	await companion
		.getByLabel("What does it do today?")
		.fill(
			"Turns bank exports into a weekly, reviewable close for small firms."
		);
	await companion.getByRole("button", { name: "Save brief" }).click();
	let state = await waitForStoredState(
		page,
		(value) =>
			value?.strategy.productName === "Ledger Lens" &&
			value.strategy.productDescription ===
				"Turns bank exports into a weekly, reviewable close for small firms."
	);
	expect(state.log[0]?.title).toBe("Strategy draft saved");
	const firstStorageWrite = lastCall(await calls(page), "storage.set");
	expect(firstStorageWrite.args).toMatchObject({
		key: "state.v1",
		namespace: "autopilot",
	});

	await companion.getByRole("button", { name: "Run strategy pass" }).click();
	await expect(
		companion.getByRole("button", { name: /Strategy pass completed/ }).first()
	).toBeVisible();
	state = await waitForStoredState(
		page,
		(value) => value?.runs[0]?.status === "completed"
	);
	expect(state.log[0]?.detail).toContain("One-job hypothesis");
	const runCall = lastCall(
		await waitForCall(page, "agent.run", 1),
		"agent.run"
	);
	expect(runCall.args).toMatchObject({
		agent_id: "agent-research",
		max_tokens: 1800,
		preset: "code_write",
		wall_time_secs: 180,
	});
	expect(z.object({ task: z.string() }).parse(runCall.args).task).toContain(
		"Product: Ledger Lens"
	);
	expect(z.object({ task: z.string() }).parse(runCall.args).task).toContain(
		"What it does today: Turns bank exports into a weekly, reviewable close for small firms."
	);
	await scrollToTop(companion);
	await capture(companion, "autopilot-overview-strategy-run-persisted.png");
	const savedLog = companion.getByRole("button", {
		name: /Strategy pass completed/,
	});
	await savedLog.first().click();
	await expect(savedLog.first()).toHaveAttribute("data-selected", "true");
	await companion.getByRole("button", { name: "Prepare pack" }).click();
	state = await waitForStoredState(
		page,
		(value) => value?.strategy.activation.prepared === true
	);
	expect(state.log[0]?.title).toBe("Activation pack prepared");
	await companion.getByRole("button", { name: "Review pack" }).click();
	await expect(
		companion.getByRole("heading", { name: "Outreach + copy" })
	).toBeVisible();
	companion = await remount(page, "overview");

	const navigation = companion.getByRole("region", {
		name: "Launch strategy chain",
	});
	await navigation.getByRole("button", { name: /One job/ }).click();
	await expect(
		companion.getByRole("heading", { name: "Make the first thing obvious." })
	).toBeVisible();
	await navigation.getByRole("button", { name: /Position/ }).click();
	await expect(
		companion.getByRole("heading", { name: "Positioning" })
	).toBeVisible();
	companion = await remount(page, "overview");
	const chain = companion.getByRole("region", {
		name: "Launch strategy chain",
	});
	await chain.getByRole("button", { name: /ICP/ }).click();
	await expect(
		companion.getByRole("heading", { name: "First ICP" })
	).toBeVisible();
	companion = await remount(page, "overview");
	await companion
		.getByRole("region", { name: "Launch strategy chain" })
		.getByRole("button", { name: /Activate/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Outreach + copy" })
	).toBeVisible();
	companion = await remount(page, "overview");
	await companion
		.getByRole("heading", { name: "Market position" })
		.locator("..")
		.getByRole("button", { name: "Open" })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Positioning" })
	).toBeVisible();
	companion = await remount(page, "overview");
	await companion
		.getByRole("heading", { name: "First ICP" })
		.locator("..")
		.getByRole("button", { name: "Open" })
		.click();
	await expect(
		companion.getByRole("heading", { name: "First ICP" })
	).toBeVisible();
	companion = await remount(page, "overview");
	await companion.getByRole("button", { name: "Edit the wedge" }).click();
	await expect(
		companion.getByRole("heading", { name: "Positioning" })
	).toBeVisible();
	companion = await remount(page, "overview");
	await companion
		.getByRole("heading", { name: "Outreach + copy" })
		.locator("..")
		.getByRole("button", { name: "Open" })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Outreach + copy" })
	).toBeVisible();
	companion = await remount(page, "overview");
	await companion
		.getByRole("heading", { name: "Activity" })
		.locator("..")
		.getByRole("button", { name: "Open activation" })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Outreach + copy" })
	).toBeVisible();
});

test("positioning fields save exactly, an agent failure is visible, and retry survives reload", async ({
	page,
}) => {
	let companion = await mount(page, { fresh: true });
	await companion.getByLabel("Product name").fill("Signal Ledger");
	await companion
		.getByLabel("What does it do today?")
		.fill("Reconciles recurring SaaS spend for lean finance teams.");
	await companion.getByRole("button", { name: "Save brief" }).click();
	await waitForStoredState(
		page,
		(value) => value?.strategy.productName === "Signal Ledger"
	);
	await companion
		.getByRole("region", { name: "Launch strategy chain" })
		.getByRole("button", { name: /Position/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Positioning" })
	).toBeVisible();

	const positioning = {
		job: "Close SaaS renewals before the invoice surprises the team.",
		boundary: "No vendor onboarding or procurement workflow yet.",
		category: "Renewal visibility for small finance teams",
		differentiation: "Shows renewal risk from existing receipts and emails.",
		value: "Know the next renewal before it becomes an urgent ticket.",
		statement:
			"For lean finance teams, Signal Ledger exposes renewal risk early.",
	};
	await companion.getByLabel("The one job").fill(positioning.job);
	await companion
		.getByLabel("What it will not do yet")
		.fill(positioning.boundary);
	await companion.getByLabel("Category").fill(positioning.category);
	await companion
		.getByLabel("Why choose this over the alternative?")
		.fill(positioning.differentiation);
	await companion.getByLabel("Value proposition").fill(positioning.value);
	await companion
		.getByLabel("Positioning statement")
		.fill(positioning.statement);
	await companion.getByRole("button", { name: "Save positioning" }).click();
	let state = await waitForStoredState(
		page,
		(value) =>
			value?.strategy.oneJob === positioning.job &&
			value.strategy.positioningStatement === positioning.statement
	);
	expect(state.strategy).toMatchObject({
		category: positioning.category,
		differentiation: positioning.differentiation,
		jobBoundary: positioning.boundary,
		oneJob: positioning.job,
		positioningStatement: positioning.statement,
		valueProp: positioning.value,
	});

	await page.evaluate(() =>
		window.__autopilotProof.failNextAgent(
			"Fixture agent runtime is temporarily unavailable."
		)
	);
	await companion.getByRole("button", { name: "Run strategy pass" }).click();
	const alert = companion.getByRole("alert");
	await expect(alert).toContainText(
		"Fixture agent runtime is temporarily unavailable."
	);
	await capture(companion, "autopilot-strategy-pass-agent-failure.png");
	state = await waitForStoredState(
		page,
		(value) => value?.runs[0]?.status === "failed"
	);
	expect(state.runs[0]?.summary).toContain("Fixture agent runtime");
	await alert.getByRole("button", { name: "Dismiss" }).click();
	await expect(alert).toHaveCount(0);
	await companion.getByRole("button", { name: "Run strategy pass" }).click();
	state = await waitForStoredState(
		page,
		(value) => value?.runs[0]?.status === "completed"
	);
	expect(state.strategy.status).toBe("ready");
	const agentCalls = (await waitForCall(page, "agent.run", 2)).filter(
		(call) => call.method === "agent.run"
	);
	expect(agentCalls).toHaveLength(2);
	for (const call of agentCalls) {
		const input = z
			.object({
				task: z.string(),
				agent_id: z.string().optional(),
				max_tokens: z.number().optional(),
				preset: z.string().optional(),
				wall_time_secs: z.number().optional(),
			})
			.parse(call.args);
		expect(input).toMatchObject({
			agent_id: "agent-research",
			max_tokens: 1800,
			preset: "code_write",
			wall_time_secs: 180,
		});
		expect(input.task).toContain(
			`Current one-job hypothesis: ${positioning.job}`
		);
		expect(input.task).toContain("external sends require approval=true");
	}
	await capture(companion, "autopilot-positioning-run-retried-success.png");

	await page.reload();
	companion = await mount(page, { section: "positioning" });
	await expect(companion.getByLabel("The one job")).toHaveValue(
		positioning.job
	);
	await expect(companion.getByLabel("Positioning statement")).toHaveValue(
		positioning.statement
	);
	const reloaded = await storedState(page);
	if (!reloaded) {
		throw new Error("Autopilot state was not persisted");
	}
	state = reloaded;
	expect(state.runs[0]?.status).toBe("completed");
	await capture(companion, "autopilot-positioning-reloaded.png");
});

test("ICP and activation edits persist, review preparation is local, and copy preview stays separate", async ({
	page,
}) => {
	let companion = await mount(page, { fresh: true, section: "icp" });
	const icp = {
		audience: "Independent bookkeepers managing fewer than 30 clients.",
		trigger: "A month-end close takes more than one business day.",
		buyer: "The owner-bookkeeper",
		exclude: "Firms with an internal accounting department.",
		proof: "Three firms reconcile a month in under two hours for two cycles.",
	};
	await companion.getByLabel("First ICP").fill(icp.audience);
	await companion.getByLabel("Buying trigger").fill(icp.trigger);
	await companion.getByLabel("Likely buyer").fill(icp.buyer);
	await companion.getByLabel("Out of scope for now").fill(icp.exclude);
	await companion.getByLabel("Proof to collect").fill(icp.proof);
	await companion.getByRole("button", { name: "Save ICP" }).click();
	let state = await waitForStoredState(
		page,
		(value) => value?.strategy.icp.audience === icp.audience
	);
	expect(state.strategy.icp).toMatchObject({
		audience: icp.audience,
		buyer: icp.buyer,
		exclude: icp.exclude,
		trigger: icp.trigger,
	});
	expect(state.strategy.proofTest).toBe(icp.proof);
	await capture(companion, "autopilot-icp-fields-saved.png");

	await page.reload();
	companion = await mount(page, { section: "activation" });
	await expect(companion.getByLabel("First ICP")).toHaveCount(0);
	await expect(
		companion.locator(".autopilot-activation-context")
	).toContainText(icp.audience);
	const activation = {
		outreach:
			"Interview five bookkeepers about the last painful month-end close.",
		proof:
			"Ask each participant to reconcile one real month of anonymized expenses.",
		headline: "Close client books before the month-end rush.",
		subhead: "A focused close workflow for independent bookkeepers.",
		cta: "Request a guided trial",
	};
	await companion.getByLabel("First outreach").fill(activation.outreach);
	await companion.getByLabel("Proof checkpoint").fill(activation.proof);
	await companion.getByLabel("Landing page headline").fill(activation.headline);
	await companion.getByLabel("Subhead").fill(activation.subhead);
	await companion.getByLabel("Call to action").fill(activation.cta);
	await expect(
		companion.getByRole("heading", { name: activation.headline })
	).toBeVisible();
	await companion.getByRole("button", { name: "Save activation" }).click();
	state = await waitForStoredState(
		page,
		(value) => value?.strategy.activation.cta === activation.cta
	);
	expect(state.strategy).toMatchObject({ proofTest: activation.proof });
	expect(state.strategy.activation).toMatchObject({
		cta: activation.cta,
		headline: activation.headline,
		outreach: activation.outreach,
		prepared: false,
		subhead: activation.subhead,
	});
	await companion.getByRole("button", { name: "Prepare review pack" }).click();
	state = await waitForStoredState(
		page,
		(value) => value?.strategy.activation.prepared === true
	);
	expect(state.log[0]?.title).toBe("Activation pack prepared");
	await expect(companion.getByText("Ready for review").first()).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Refresh review pack" })
	).toBeVisible();
	await capture(companion, "autopilot-activation-review-pack-prepared.png");
	const writesBeforeRefresh = (await calls(page)).filter(
		(call) => call.method === "storage.set"
	).length;
	await companion.getByRole("button", { name: "Refresh review pack" }).click();
	await expect
		.poll(
			async () =>
				(await calls(page)).filter((call) => call.method === "storage.set")
					.length
		)
		.toBeGreaterThan(writesBeforeRefresh);
	state = await waitForStoredState(
		page,
		(value) => value?.strategy.activation.prepared === true
	);
	expect(state.log[0]?.title).toBe("Activation pack prepared");
	const beforePreviewClick = await storedState(page);
	const writesBeforePreview = (await calls(page)).filter(
		(call) => call.method === "storage.set"
	).length;
	await expect(
		companion.getByText(activation.cta, { exact: true })
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: activation.cta })
	).toHaveCount(0);
	expect(await storedState(page)).toEqual(beforePreviewClick);
	expect(
		(await calls(page)).filter((call) => call.method === "storage.set")
	).toHaveLength(writesBeforePreview);
	await expect(
		companion.getByRole("heading", { name: "Outreach + copy" })
	).toBeVisible();

	const agentCalls = (await calls(page)).filter(
		(call) => call.method === "agent.run"
	);
	expect(agentCalls).toHaveLength(0);
	const writes = (await calls(page)).filter(
		(call) => call.method === "storage.set"
	);
	expect(writes.length).toBeGreaterThanOrEqual(2);
});

test("guardrails and both agent selectors persist across reopen; pause blocks and resume restores runs", async ({
	page,
}) => {
	let companion = await mount(page, { fresh: true, section: "guardrails" });
	const externalApproval = companion.getByRole("checkbox", {
		name: /External sends require approval/,
	});
	const scopedWrites = companion.getByRole("checkbox", {
		name: /Writes stay scoped to enabled apps/,
	});
	await expect(externalApproval).toBeChecked();
	await expect(scopedWrites).toBeChecked();
	await expect(
		companion.getByRole("option", { name: "Disabled Agent" })
	).toHaveCount(0);
	await expect(
		companion.getByRole("option", { name: "Uninstalled Agent" })
	).toHaveCount(0);
	await externalApproval.click();
	await scopedWrites.click();
	await companion
		.getByLabel("Autopilot agent lane")
		.selectOption("agent-writer");
	let state = await waitForStoredState(
		page,
		(value) =>
			value?.agentId === "agent-writer" &&
			!value.guardrails.externalApproval &&
			!value.guardrails.scopedWrites
	);
	expect(state.guardrails).toEqual({
		externalApproval: false,
		scopedWrites: false,
	});
	await capture(companion, "autopilot-guardrails-and-agent-lane-saved.png");

	await page.reload();
	companion = await mount(page, { section: "guardrails" });
	await expect(
		companion.getByRole("checkbox", { name: /External sends require approval/ })
	).not.toBeChecked();
	await expect(
		companion.getByRole("checkbox", {
			name: /Writes stay scoped to enabled apps/,
		})
	).not.toBeChecked();
	await expect(companion.getByLabel("Autopilot agent lane")).toHaveValue(
		"agent-writer"
	);
	await companion
		.getByRole("checkbox", { name: /External sends require approval/ })
		.click();
	await companion
		.getByRole("checkbox", { name: /Writes stay scoped to enabled apps/ })
		.click();
	state = await waitForStoredState(
		page,
		(value) =>
			value?.guardrails.externalApproval === true &&
			value.guardrails.scopedWrites === true
	);
	expect(state.agentId).toBe("agent-writer");

	companion = await remount(page, "overview");
	await expect(companion.locator("#autopilot-agent-lane")).toHaveValue(
		"agent-writer"
	);
	await companion
		.locator("#autopilot-agent-lane")
		.selectOption("agent-research");
	state = await waitForStoredState(
		page,
		(value) => value?.agentId === "agent-research"
	);
	expect(state.agentId).toBe("agent-research");
	await companion.locator("#autopilot-agent-lane").selectOption("agent-writer");
	state = await waitForStoredState(
		page,
		(value) => value?.agentId === "agent-writer"
	);
	await companion.getByLabel("Product name").fill("Bounded Ledger");
	await companion
		.getByLabel("What does it do today?")
		.fill("Categorizes business spend while keeping finance writes scoped.");
	await companion.getByRole("button", { name: "Save brief" }).click();
	await waitForStoredState(
		page,
		(value) => value?.strategy.productName === "Bounded Ledger"
	);
	await companion.getByRole("button", { name: "Pause" }).click();
	await expect(companion.getByText("Strategy desk paused")).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Run strategy pass" })
	).toBeDisabled();
	state = await waitForStoredState(page, (value) => value?.active === false);
	expect(state.active).toBe(false);
	await companion.getByRole("button", { name: "Resume" }).click();
	await expect(companion.getByText("Strategy desk active")).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Run strategy pass" })
	).toBeEnabled();
	state = await waitForStoredState(page, (value) => value?.active === true);
	expect(state.agentId).toBe("agent-writer");
	await capture(companion, "autopilot-resumed-run-enabled.png");
});

test("a failed KV save remains visible and can be retried without losing the edited brief", async ({
	page,
}) => {
	const companion = await mount(page, { fresh: true });
	await companion.getByLabel("Product name").fill("Retryable Brief");
	await companion
		.getByLabel("What does it do today?")
		.fill("A local workflow that survives a temporary host storage failure.");
	await page.evaluate(() =>
		window.__autopilotProof.failNextStorageSet("Fixture KV write failed once.")
	);
	await companion.getByRole("button", { name: "Save brief" }).click();
	const alert = companion.getByRole("alert");
	await expect(alert).toContainText("Fixture KV write failed once.");
	expect(await storedState(page)).toBeNull();
	await capture(companion, "autopilot-storage-write-failure-retains-draft.png");
	await alert.getByRole("button", { name: "Dismiss" }).click();
	await companion.getByRole("button", { name: "Save brief" }).click();
	const state = await waitForStoredState(
		page,
		(value) =>
			value?.strategy.productName === "Retryable Brief" &&
			value.strategy.productDescription ===
				"A local workflow that survives a temporary host storage failure."
	);
	expect(state.log[0]?.title).toBe("Strategy draft saved");
	await expect(alert).toHaveCount(0);
	await capture(companion, "autopilot-storage-write-retried.png");
});
