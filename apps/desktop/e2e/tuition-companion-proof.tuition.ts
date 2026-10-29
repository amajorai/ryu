import { tmpdir } from "node:os";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type {
	TuitionProofApi,
	TuitionProofCall,
	TuitionProofState,
} from "./harness/tuition-companion-proof.types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appHtmlPath = `${tmpdir()}/ryu-tuition-companion-ui-build/index.html`;
const evidenceDirectory = path.resolve(
	here,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

declare global {
	interface Window {
		__tuitionProof: TuitionProofApi;
	}
}

async function mountTab(
	page: Page,
	tab: string,
	options: {
		expectHeading?: boolean;
		grants?: string[];
		readOnly?: boolean;
	} = {}
): Promise<FrameLocator> {
	if (!page.url().includes("tuition-companion-proof.html")) {
		await page.goto("/tuition-companion-proof.html");
		await expect(page.locator("body")).toHaveAttribute(
			"data-harness-ready",
			"1"
		);
	}
	const appHtml = await readFile(appHtmlPath, "utf8");
	const { expectHeading = true, ...mountOptions } = options;
	await page.evaluate((input) => window.__tuitionProof.mount(input), {
		appHtml,
		tab,
		...mountOptions,
	});
	await expect
		.poll(() => page.evaluate(() => window.__tuitionProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	const companion = page.frameLocator('iframe[title="Tuition proof"]');
	if (expectHeading) {
		const heading =
			tab === "review"
				? "Review queue"
				: tab.charAt(0).toUpperCase() + tab.slice(1);
		await expect(
			companion.getByRole("heading", { name: heading, exact: true })
		).toBeVisible();
	}
	return companion;
}

async function calls(page: Page): Promise<TuitionProofCall[]> {
	return page.evaluate(() => window.__tuitionProof.calls());
}

async function state(page: Page): Promise<TuitionProofState> {
	return page.evaluate(() => window.__tuitionProof.state());
}

async function failNext(
	page: Page,
	method: string,
	requestPath: string,
	errorMessage: string
): Promise<void> {
	await page.evaluate(
		(input) =>
			window.__tuitionProof.failNext(input.method, input.path, input.message),
		{ method, path: requestPath, message: errorMessage }
	);
}

async function waitForCall(
	page: Page,
	method: string,
	requestPath: string,
	index = -1
): Promise<TuitionProofCall> {
	await expect
		.poll(
			async () =>
				(await calls(page))
					.filter((call) => call.method === method && call.path === requestPath)
					.at(index)?.status ?? 0
		)
		.toBeGreaterThan(0);
	const call = (await calls(page))
		.filter((entry) => entry.method === method && entry.path === requestPath)
		.at(index);
	if (!call) {
		throw new Error(`No Tuition fixture call for ${method} ${requestPath}.`);
	}
	return call;
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

test("Study plans with minutes, answers three item kinds, and persists the completed attempt trail", async ({
	page,
}) => {
	const companion = await mountTab(page, "study");
	const minutes = companion.getByRole("spinbutton", { name: "I have" });
	await minutes.fill("25");
	await failNext(
		page,
		"POST",
		"/sessions/plan",
		"Fixture planner is temporarily unavailable."
	);
	await companion.getByRole("button", { name: "Plan a session" }).click();
	await expect(
		companion.getByText("Fixture planner is temporarily unavailable.")
	).toBeVisible();
	await companion.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(
		companion.getByText("Fixture planner is temporarily unavailable.")
	).toHaveCount(0);
	await expect(minutes).toHaveValue("25");
	await companion.getByRole("button", { name: "Plan a session" }).click();
	await expect(
		companion.getByText("Where is the electron transport chain?")
	).toBeVisible();

	const planCalls = (await calls(page)).filter(
		(call) => call.method === "POST" && call.path === "/sessions/plan"
	);
	expect(planCalls.map((call) => call.status)).toEqual([503, 201]);
	expect(planCalls[1]?.body).toEqual({
		minutes: 25,
		subject_id: "subject-biology",
	});
	await companion
		.getByRole("radio", { name: "The inner mitochondrial membrane" })
		.click();
	await companion.getByRole("button", { name: "Check", exact: true }).click();
	await expect(companion.getByText("Correct", { exact: true })).toBeVisible();
	await expect(
		companion.getByText("graded by comparison — no model", { exact: true })
	).toBeVisible();
	const mcqAnswer = await waitForCall(
		page,
		"POST",
		"/sessions/session-1/answer"
	);
	expect(mcqAnswer.body).toEqual({
		item_id: "item-mcq",
		response: "choice-a",
	});

	await companion.getByRole("button", { name: "Next", exact: true }).click();
	const freeAnswer = companion.getByPlaceholder("Your answer", { exact: true });
	await freeAnswer.fill("The gradient drives ATP synthase rotation.");
	await companion.getByRole("button", { name: "Check", exact: true }).click();
	await expect(
		companion.getByText("graded against the rubric", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByText(
			"Credit the proton gradient driving rotational catalysis."
		)
	).toBeVisible();
	await capture(companion, "tuition-study-free-response-rubric.png");
	const freeAnswerCall = (await calls(page))
		.filter(
			(call) =>
				call.method === "POST" && call.path === "/sessions/session-1/answer"
		)
		.at(-1);
	expect(freeAnswerCall?.body).toEqual({
		item_id: "item-free",
		response: "The gradient drives ATP synthase rotation.",
	});

	await companion.getByRole("button", { name: "Next", exact: true }).click();
	const clozeAnswer = companion.getByPlaceholder("Separate the blanks with |", {
		exact: true,
	});
	await clozeAnswer.fill("mitochondria|protons");
	await companion.getByRole("button", { name: "Check", exact: true }).click();
	await expect(companion.getByText("Blanks: ✓ ✓")).toBeVisible();
	const clozeCall = (await calls(page))
		.filter(
			(call) =>
				call.method === "POST" && call.path === "/sessions/session-1/answer"
		)
		.at(-1);
	expect(clozeCall?.body).toEqual({
		item_id: "item-cloze",
		response: "mitochondria|protons",
	});
	await companion.getByRole("button", { name: "Next", exact: true }).click();
	await expect(
		companion.getByText("Session finished. 1 skill rescheduled.")
	).toBeVisible();
	const stateAfterFinish = await state(page);
	expect(stateAfterFinish.sessions[0]?.status).toBe("completed");
	expect(stateAfterFinish.attempts).toEqual([
		{
			item_id: "item-mcq",
			response: "choice-a",
			session_id: "session-1",
		},
		{
			item_id: "item-free",
			response: "The gradient drives ATP synthase rotation.",
			session_id: "session-1",
		},
		{
			item_id: "item-cloze",
			response: "mitochondria|protons",
			session_id: "session-1",
		},
	]);
});

test("Skills adds a named skill, refreshes mastery projections, and reloads stored state", async ({
	page,
}) => {
	const companion = await mountTab(page, "skills");
	await expect(
		companion.getByText("Cellular respiration", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByText("Not enough history to say yet")
	).toBeVisible();
	await expect(companion.getByText("0.62", { exact: true })).toBeVisible();

	const input = companion.getByPlaceholder("Add a skill", { exact: true });
	await input.fill("Oxidative phosphorylation");
	await companion.getByRole("button", { name: "Add", exact: true }).click();
	await expect(
		companion.getByText("Oxidative phosphorylation", { exact: true })
	).toBeVisible();
	await expect(companion.getByText("0.50", { exact: true })).toBeVisible();
	const createSkill = await waitForCall(page, "POST", "/skills");
	expect(createSkill.body).toEqual({
		name: "Oxidative phosphorylation",
		subject_id: "subject-biology",
	});
	expect(
		(await calls(page)).some(
			(call) =>
				call.method === "GET" &&
				call.path === "/mastery?subject_id=subject-biology"
		)
	).toBe(true);
	await capture(companion, "tuition-skills-add-persisted.png");

	const reloaded = await mountTab(page, "skills");
	await expect(
		reloaded.getByText("Oxidative phosphorylation", { exact: true })
	).toBeVisible();
	expect((await state(page)).skills.map((skill) => skill.name)).toContain(
		"Oxidative phosphorylation"
	);
});

test("Materials rejects empty content locally, retains a failed draft, retries, and reloads it", async ({
	page,
}) => {
	const companion = await mountTab(page, "materials");
	const title = companion.getByPlaceholder("Title", { exact: true });
	const notes = companion.getByPlaceholder(
		"Paste a syllabus, a chapter, or your notes.",
		{ exact: true }
	);
	await companion.getByRole("button", { name: "Add material" }).click();
	expect(
		(await calls(page)).some(
			(call) => call.method === "POST" && call.path === "/sources"
		)
	).toBe(false);

	await title.fill("Cellular energy lecture notes");
	await notes.fill("Mitochondria convert a proton gradient into ATP.");
	await failNext(
		page,
		"POST",
		"/sources",
		"Fixture source store is temporarily unavailable."
	);
	await companion.getByRole("button", { name: "Add material" }).click();
	await expect(
		companion.getByText("Fixture source store is temporarily unavailable.")
	).toBeVisible();
	await expect(title).toHaveValue("Cellular energy lecture notes");
	await expect(notes).toHaveValue(
		"Mitochondria convert a proton gradient into ATP."
	);
	await companion.getByRole("button", { name: "Add material" }).click();
	await expect(
		companion.getByText("Fixture source store is temporarily unavailable.")
	).toHaveCount(0);
	await expect(
		companion.getByText("Cellular energy lecture notes", { exact: true })
	).toBeVisible();
	const sourceCalls = (await calls(page)).filter(
		(call) => call.method === "POST" && call.path === "/sources"
	);
	expect(sourceCalls.map((call) => call.status)).toEqual([503, 201]);
	expect(sourceCalls[1]?.body).toEqual({
		subject_id: "subject-biology",
		text: "Mitochondria convert a proton gradient into ATP.",
		title: "Cellular energy lecture notes",
	});
	await capture(companion, "tuition-materials-persisted.png");

	const reloaded = await mountTab(page, "materials");
	await expect(
		reloaded.getByText("Cellular energy lecture notes", { exact: true })
	).toBeVisible();
	expect((await state(page)).sources).toHaveLength(1);
});

test("Review queue acceptance and discard update the pending list independently", async ({
	page,
}) => {
	const companion = await mountTab(page, "review");
	const acceptPrompt = companion.getByText(
		"What does ATP synthase use to make ATP?",
		{ exact: true }
	);
	await expect(acceptPrompt).toBeVisible();
	await acceptPrompt
		.locator("xpath=..")
		.getByRole("button", { name: "Add to deck", exact: true })
		.click();
	await expect(acceptPrompt).toHaveCount(0);
	await expect(
		companion.getByText("Where is the electron transport chain?", {
			exact: true,
		})
	).toBeVisible();
	const acceptCall = await waitForCall(
		page,
		"POST",
		"/candidates/candidate-gradient/accept"
	);
	expect(acceptCall.body).toBeUndefined();
	await capture(companion, "tuition-review-queue-after-accept.png");

	const discardPrompt = companion.getByText(
		"Where is the electron transport chain?",
		{ exact: true }
	);
	await discardPrompt
		.locator("xpath=..")
		.getByRole("button", { name: "Discard", exact: true })
		.click();
	await expect(companion.getByText("Nothing waiting.")).toBeVisible();
	const discardCall = await waitForCall(
		page,
		"POST",
		"/candidates/candidate-location/reject"
	);
	expect(discardCall.body).toBeUndefined();
	expect(
		(await state(page)).candidates.map((candidate) => candidate.status)
	).toEqual(["accepted", "rejected"]);
});

test("Subjects select the active subject and add an exam-dated subject with retry", async ({
	page,
}) => {
	const companion = await mountTab(page, "subjects");
	const selector = companion.getByRole("combobox", { name: "Subject" });
	await expect(selector).toHaveValue("subject-biology");
	await selector.selectOption("subject-chemistry");
	await expect(selector).toHaveValue("subject-chemistry");

	const name = companion.getByPlaceholder("Subject name", { exact: true });
	const examDate = companion.getByRole("textbox", { name: "Exam date" });
	await companion.getByRole("button", { name: "Add", exact: true }).click();
	expect(
		(await calls(page)).some(
			(call) => call.method === "POST" && call.path === "/subjects"
		)
	).toBe(false);
	await name.fill("Statistics");
	await examDate.fill("2026-12-30");
	await failNext(
		page,
		"POST",
		"/subjects",
		"Fixture subject store is read-only for this request."
	);
	await companion.getByRole("button", { name: "Add", exact: true }).click();
	await expect(
		companion.getByText("Fixture subject store is read-only for this request.")
	).toBeVisible();
	await expect(name).toHaveValue("Statistics");
	await expect(examDate).toHaveValue("2026-12-30");
	await companion.getByRole("button", { name: "Add", exact: true }).click();
	await expect(
		companion.getByText("Fixture subject store is read-only for this request.")
	).toHaveCount(0);
	await expect(
		companion.getByRole("main").getByText("Statistics", { exact: true })
	).toBeVisible();
	const subjectCalls = (await calls(page)).filter(
		(call) => call.method === "POST" && call.path === "/subjects"
	);
	expect(subjectCalls.map((call) => call.status)).toEqual([503, 201]);
	expect(subjectCalls[1]?.body).toEqual({
		exam_date: "2026-12-30",
		name: "Statistics",
		timezone: await page.evaluate(
			() => Intl.DateTimeFormat().resolvedOptions().timeZone
		),
	});
	await selector.selectOption("subject-3");
	await expect(selector).toHaveValue("subject-3");
	await capture(companion, "tuition-subjects-exam-date-saved.png");
	expect((await state(page)).subjects.map((subject) => subject.name)).toContain(
		"Statistics"
	);
});

test("Settings submits the complete current values, retries failure, and reloads persistence", async ({
	page,
}) => {
	const companion = await mountTab(page, "settings");
	const mastery = companion.getByRole("spinbutton", { name: "target mastery" });
	const sessionsPerDay = companion.getByRole("spinbutton", {
		name: "sessions per day",
	});
	await expect(mastery).toHaveValue("0.9");
	await mastery.fill("0.95");
	await sessionsPerDay.fill("2");
	await failNext(
		page,
		"PUT",
		"/settings",
		"Fixture settings write failed once."
	);
	await companion.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		companion.getByText("Fixture settings write failed once.")
	).toBeVisible();
	await expect(mastery).toHaveValue("0.95");
	await expect(sessionsPerDay).toHaveValue("2");
	await companion.getByRole("button", { name: "Dismiss", exact: true }).click();
	await companion.getByRole("button", { name: "Save", exact: true }).click();
	await waitForCall(page, "PUT", "/settings", 1);
	const settingsCalls = (await calls(page)).filter(
		(call) => call.method === "PUT" && call.path === "/settings"
	);
	expect(settingsCalls.map((call) => call.status)).toEqual([503, 200]);
	expect(settingsCalls[1]?.body).toEqual({
		ready_threshold: 0.8,
		target_mastery: 0.95,
		per_skill_item_cap: 5,
		default_item_seconds: 60,
		sessions_per_day: 2,
		at_risk_overrun: 1.15,
		trajectory_window: 10,
		trajectory_min_sessions: 3,
	});
	await mountTab(page, "settings");
	const reloadedMastery = page
		.frameLocator('iframe[title="Tuition proof"]')
		.getByRole("spinbutton", { name: "target mastery" });
	await expect(reloadedMastery).toHaveValue("0.95");
	expect((await state(page)).activeSettings).toMatchObject({
		target_mastery: 0.95,
		sessions_per_day: 2,
	});
	await capture(
		page.frameLocator('iframe[title="Tuition proof"]'),
		"tuition-settings-persisted.png"
	);
});

test("the ExtensionHost denies an ungranted bridge and a read-only fixture blocks writes", async ({
	page,
}) => {
	let companion = await mountTab(page, "study", {
		expectHeading: false,
		grants: [],
	});
	await expect
		.poll(() => companion.locator("body").innerText())
		.toContain("Capability not granted: tuition.crud");
	expect(await calls(page)).toEqual([]);

	companion = await mountTab(page, "subjects", {
		grants: ["tuition:crud"],
		readOnly: true,
	});
	await companion
		.getByPlaceholder("Subject name", { exact: true })
		.fill("Statistics");
	await companion.getByRole("button", { name: "Add", exact: true }).click();
	await expect(
		companion.getByText("Tuition edit permission is required for this action.")
	).toBeVisible();
	const deniedWrite = await waitForCall(page, "POST", "/subjects");
	expect(deniedWrite.status).toBe(403);
	expect((await state(page)).subjects).toHaveLength(2);
});
