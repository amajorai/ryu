import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

interface Decision {
	category: string;
	createdAt: string;
	decision: string;
	id: string;
	optionsConsidered: string[];
	rationale: string;
	subject: string;
}

function uniqueTitle(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

function recordStudioRequests(page: Page) {
	const requests: StudioRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/__studio/")) {
			return;
		}
		const body = request.postData();
		let parsedBody: unknown;
		if (body) {
			try {
				parsedBody = JSON.parse(body);
			} catch {
				parsedBody = body;
			}
		}
		requests.push({
			...(parsedBody === undefined ? undefined : { body: parsedBody }),
			method: request.method(),
			path: url.pathname.slice("/__studio".length),
		});
	});
	return requests;
}

async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
	await titleField.fill(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

async function openPlanPanel(page: Page) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill("Plan");
	const tab = page.locator('[data-tabs-menu-key="string:storyboard"]');
	await expect(tab).toBeVisible();
	await tab.click();
	await expect(
		page.getByRole("heading", { name: "Decision log" })
	).toBeVisible();
}

async function projectDecisions(page: Page, projectId: string) {
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	// SAFETY: The successful local GET checked above is forwarded unchanged from store.project(), whose native projectSchema parser owns this Project and its declared fields before JSON serialization. Native decisions is its productionDecisionSchema array.
	const project = (await response.json()) as { decisions: Decision[] };
	return project.decisions;
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Decision log trims and appends choices, retains entries through save retry and reload", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage decision history");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openPlanPanel(page);

	const category = page.getByLabel("Decision category");
	const subject = page.getByLabel("Decision subject");
	const choice = page.getByLabel("Decision choice");
	const rationale = page.getByLabel("Decision rationale");
	const append = page.getByRole("button", {
		name: "Append decision",
		exact: true,
	});
	await expect(category).toHaveValue("render_runtime");
	await expect(append).toBeDisabled();
	await expect(
		page
			.locator(".studio-activity-item")
			.filter({ hasText: "Composition runtime" })
	).toHaveCount(0);
	await subject.fill("   ");
	await choice.fill("   ");
	await expect(append).toBeDisabled();

	// Each decision is appended to the saved project by its own server write;
	// a refused append keeps the draft so the user can retry it unchanged.
	const decisionAppends = () =>
		requests.filter(
			(request) =>
				request.path === `/projects/${projectId}/decisions` &&
				request.method === "POST"
		);
	const appendFailure = await page.request.post(
		"/__proof/fail-next-decision-append"
	);
	expect(appendFailure.ok()).toBe(true);
	await category.fill("  render_runtime  ");
	await subject.fill("  Composition runtime  ");
	await choice.fill("  Use FFmpeg for local delivery.  ");
	await rationale.fill("  Deterministic source-footage rendering.  ");
	await expect(append).toBeEnabled();
	await append.click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture decision append failed."
	);
	const decisionItem = page
		.locator(".studio-activity-item")
		.filter({ hasText: "Composition runtime" });
	await expect(decisionItem).toHaveCount(0);
	await expect(subject).toHaveValue("  Composition runtime  ");
	await expect(choice).toHaveValue("  Use FFmpeg for local delivery.  ");
	await expect(rationale).toHaveValue(
		"  Deterministic source-footage rendering.  "
	);
	expect(decisionAppends()).toEqual([]);
	expect(await projectDecisions(page, projectId)).toEqual([]);

	await append.click();
	await expect(page.getByRole("status")).toContainText("Decision appended.");
	await expect(decisionItem).toContainText(
		"render_runtime · Use FFmpeg for local delivery. · Deterministic source-footage rendering."
	);
	await expect(decisionItem).toContainText("logged");
	await expect(category).toHaveValue("  render_runtime  ");
	await expect(subject).toHaveValue("");
	await expect(choice).toHaveValue("");
	await expect(rationale).toHaveValue("");
	await expect(append).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Saved", exact: true })
	).toBeDisabled();
	const firstPersisted = await projectDecisions(page, projectId);
	expect(firstPersisted).toHaveLength(1);
	expect(firstPersisted[0]).toMatchObject({
		category: "render_runtime",
		decision: "Use FFmpeg for local delivery.",
		optionsConsidered: [],
		rationale: "Deterministic source-footage rendering.",
		subject: "Composition runtime",
	});
	expect(firstPersisted[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
	expect(firstPersisted[0]?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/u);
	expect(decisionAppends()).toHaveLength(1);
	expect(decisionAppends()[0]?.body).toMatchObject({
		category: "render_runtime",
		decision: "Use FFmpeg for local delivery.",
		rationale: "Deterministic source-footage rendering.",
		subject: "Composition runtime",
	});
	await saveScreenshot(page, "video-studio-decision-log-save-retry.png");

	await category.fill("creative");
	await subject.fill("Localization pass");
	await choice.fill("Keep source captions until timing review.");
	await rationale.fill("The translation team needs the final edit timing.");
	await append.click();
	await expect(page.getByRole("status")).toContainText("Decision appended.");
	const list = page
		.locator(".studio-activity-list")
		.filter({ has: page.getByText("Composition runtime", { exact: true }) });
	await expect(list.locator(".studio-activity-item")).toHaveCount(2);
	await expect(list.locator(".studio-activity-item").first()).toContainText(
		"Localization pass"
	);
	await expect(list.locator(".studio-activity-item").last()).toContainText(
		"Composition runtime"
	);
	await expect
		.poll(async () =>
			(await projectDecisions(page, projectId)).map((item) => item.subject)
		)
		.toEqual(["Composition runtime", "Localization pass"]);
	expect(decisionAppends()).toHaveLength(2);
	const bothDecisions = await projectDecisions(page, projectId);
	expect(bothDecisions.map((item) => item.subject)).toEqual([
		"Composition runtime",
		"Localization pass",
	]);
	expect(bothDecisions[1]).toMatchObject({
		category: "creative",
		decision: "Keep source captions until timing review.",
		rationale: "The translation team needs the final edit timing.",
	});

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	await openPlanPanel(page);
	const reloadedList = page
		.locator(".studio-activity-list")
		.filter({ has: page.getByText("Composition runtime", { exact: true }) });
	await expect(reloadedList.locator(".studio-activity-item")).toHaveCount(2);
	await expect(
		reloadedList.locator(".studio-activity-item").first()
	).toContainText("Localization pass");
	await expect(
		reloadedList.locator(".studio-activity-item").last()
	).toContainText("Composition runtime");
	await expect(reloadedList).toContainText(
		"Deterministic source-footage rendering."
	);
	await expect(reloadedList).toContainText(
		"The translation team needs the final edit timing."
	);
	await reloadedList.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-decision-log-after-reload.png");
});
