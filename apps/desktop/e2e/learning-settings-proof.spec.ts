import { expect, type Page, test } from "@playwright/test";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
	token: string | null;
	userJwt: string | null;
}

interface LearningSettingsSnapshot {
	preferences: Record<string, string>;
	requests: CapturedRequest[];
}

interface LearningSettingsProofWindow extends Window {
	__learningSettingsProof: {
		armFailure: (method: string, path: string, status?: number) => void;
		snapshot: () => LearningSettingsSnapshot;
	};
}

const evidence = (name: string) => test.info().outputPath(name);

async function readSnapshot(page: Page): Promise<LearningSettingsSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: learning-settings-proof.tsx installs __learningSettingsProof before this proof page is evaluated. */ (
			window as LearningSettingsProofWindow
		).__learningSettingsProof.snapshot()
	);
}

async function openLearningSettings(
	page: Page,
	path = "/learning-settings-proof.html"
): Promise<void> {
	await page.goto(path);
	const appEnabled =
		new URL(path, "http://learning-settings-proof.local").searchParams.get(
			"appEnabled"
		) !== "false";
	await expect(
		appEnabled
			? page.getByRole("heading", { name: "Learn from my conversations" })
			: page.getByText("Learning is turned off", { exact: true })
	).toBeVisible();
}

async function armFailure(
	page: Page,
	method: string,
	requestPath: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ method, requestPath, status }) =>
			/* SAFETY: learning-settings-proof.tsx installs __learningSettingsProof before this proof page is evaluated. */ (
				window as LearningSettingsProofWindow
			).__learningSettingsProof.armFailure(method, requestPath, status),
		{ method, requestPath, status }
	);
}

test.describe.configure({ timeout: 60_000 });

test("starts consent off when Core has no preferences and never writes on read", async ({
	page,
}) => {
	await openLearningSettings(page);
	const skills = page.getByRole("switch", {
		name: "Learn skills from my chats",
	});
	const training = page.getByRole("switch", { name: "Train my local model" });
	await expect(skills).not.toBeChecked();
	await expect(training).not.toBeChecked();

	const initial = await readSnapshot(page);
	expect(initial.requests).toEqual([
		{
			body: null,
			method: "GET",
			path: "/api/preferences/learning.enabled",
			status: 404,
			token: "Bearer learning-settings-proof-node-token",
			userJwt: "learning-settings-proof-user-jwt",
		},
		{
			body: null,
			method: "GET",
			path: "/api/preferences/learning.skills-enabled",
			status: 404,
			token: "Bearer learning-settings-proof-node-token",
			userJwt: "learning-settings-proof-user-jwt",
		},
		{
			body: null,
			method: "GET",
			path: "/api/plugins/contributions",
			status: 200,
			token: "Bearer learning-settings-proof-node-token",
			userJwt: "learning-settings-proof-user-jwt",
		},
	]);
	expect(initial.preferences).toEqual({});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-learning-settings-consent-off.png"),
	});
});

test("rolls consent back on Core write failures, retries exact scoped payloads, and reloads", async ({
	page,
}) => {
	await openLearningSettings(page);
	const skills = page.getByRole("switch", {
		name: "Learn skills from my chats",
	});
	const training = page.getByRole("switch", { name: "Train my local model" });
	await expect(skills).not.toBeChecked();
	await expect(training).not.toBeChecked();

	await armFailure(
		page,
		"PUT",
		"/api/preferences/learning.skills-enabled",
		503
	);
	await skills.click();
	await expect(
		page.getByText("Couldn't save your skill-learning choice")
	).toBeVisible();
	await expect(skills).not.toBeChecked();
	await skills.click();
	await expect(skills).toBeChecked();

	await armFailure(page, "PUT", "/api/preferences/learning.enabled", 403);
	await training.click();
	await expect(
		page.getByText("Couldn't save your learning choice")
	).toBeVisible();
	await expect(training).not.toBeChecked();
	await training.click();
	await expect(training).toBeChecked();

	const beforeReload = await readSnapshot(page);
	expect(beforeReload.preferences).toEqual({
		"learning.enabled": "true",
		"learning.skills-enabled": "true",
	});
	expect(
		beforeReload.requests
			.filter((request) => request.method === "PUT")
			.map((request) => ({
				body: request.body,
				path: request.path,
				status: request.status,
				token: request.token,
				userJwt: request.userJwt,
			}))
	).toEqual([
		{
			body: { value: "true" },
			path: "/api/preferences/learning.skills-enabled",
			status: 503,
			token: "Bearer learning-settings-proof-node-token",
			userJwt: "learning-settings-proof-user-jwt",
		},
		{
			body: { value: "true" },
			path: "/api/preferences/learning.skills-enabled",
			status: 200,
			token: "Bearer learning-settings-proof-node-token",
			userJwt: "learning-settings-proof-user-jwt",
		},
		{
			body: { value: "true" },
			path: "/api/preferences/learning.enabled",
			status: 403,
			token: "Bearer learning-settings-proof-node-token",
			userJwt: "learning-settings-proof-user-jwt",
		},
		{
			body: { value: "true" },
			path: "/api/preferences/learning.enabled",
			status: 200,
			token: "Bearer learning-settings-proof-node-token",
			userJwt: "learning-settings-proof-user-jwt",
		},
	]);

	await page.reload();
	await expect(skills).toBeChecked();
	await expect(training).toBeChecked();
	const reload = await readSnapshot(page);
	expect(reload.preferences).toEqual(beforeReload.preferences);
	expect(
		reload.requests.filter((request) => request.method === "PUT")
	).toHaveLength(0);
	expect(
		reload.requests.map(({ method, path, status }) => ({
			method,
			path,
			status,
		}))
	).toEqual([
		{ method: "GET", path: "/api/preferences/learning.enabled", status: 200 },
		{
			method: "GET",
			path: "/api/preferences/learning.skills-enabled",
			status: 200,
		},
		{ method: "GET", path: "/api/plugins/contributions", status: 200 },
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-learning-settings-consent-saved.png"),
	});
});

test("failed preference reads keep both opt-ins safely off while leaving controls available", async ({
	page,
}) => {
	await page.goto("/learning-settings-proof.html?failLearningReads=true");
	const skills = page.getByRole("switch", {
		name: "Learn skills from my chats",
	});
	const training = page.getByRole("switch", { name: "Train my local model" });
	await expect(skills).toBeVisible();
	await expect(training).toBeVisible();
	await expect(skills).not.toBeChecked();
	await expect(training).not.toBeChecked();
	const snapshot = await readSnapshot(page);
	expect(
		snapshot.requests.map(({ method, path, status }) => ({
			method,
			path,
			status,
		}))
	).toEqual([
		{ method: "GET", path: "/api/preferences/learning.enabled", status: 503 },
		{
			method: "GET",
			path: "/api/preferences/learning.skills-enabled",
			status: 503,
		},
		{ method: "GET", path: "/api/plugins/contributions", status: 200 },
	]);
	expect(snapshot.preferences).toEqual({});
});

test("keeps consent controls usable and persistent while the Learning app is off", async ({
	page,
}) => {
	await openLearningSettings(
		page,
		"/learning-settings-proof.html?appEnabled=false"
	);
	await expect(page.getByText("Learning is turned off")).toBeVisible();
	await expect(
		page.getByText(
			"The consent switches below are saved separately. You can change them whether the Learning app is on or off."
		)
	).toBeVisible();
	const skills = page.getByRole("switch", {
		name: "Learn skills from my chats",
	});
	const training = page.getByRole("switch", { name: "Train my local model" });
	await expect(skills).not.toBeChecked();
	await expect(training).not.toBeChecked();
	await expect(skills).toBeEnabled();
	await expect(training).toBeEnabled();
	await skills.click();
	await expect(skills).toBeChecked();
	await training.click();
	await expect(training).toBeChecked();
	const snapshot = await readSnapshot(page);
	expect(snapshot.preferences).toEqual({
		"learning.enabled": "true",
		"learning.skills-enabled": "true",
	});
	expect(
		snapshot.requests
			.filter((request) => request.method === "PUT")
			.map((request) => ({
				body: request.body,
				path: request.path,
				status: request.status,
			}))
	).toEqual([
		{
			body: { value: "true" },
			path: "/api/preferences/learning.skills-enabled",
			status: 200,
		},
		{
			body: { value: "true" },
			path: "/api/preferences/learning.enabled",
			status: 200,
		},
	]);
	await page.reload();
	await expect(page.getByText("Learning is turned off")).toBeVisible();
	await expect(skills).toBeChecked();
	await expect(training).toBeChecked();
	const reload = await readSnapshot(page);
	expect(reload.preferences).toEqual(snapshot.preferences);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-learning-settings-disabled-app-consent.png"),
	});
});
