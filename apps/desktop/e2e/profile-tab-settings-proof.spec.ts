import { expect, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { type ProofJsonValue, parseProofJson } from "./fixture-json.ts";

const STORY_URL = "/profile-tab-settings-proof.html";
const PROFILE_NAME_PATH = "/api/profile/name";
const SESSION_PATH = "/api/auth/get-session";
const PERSONALIZATION_PATH = "/api/preferences/user-personalization";
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const PERSONALIZATION_SCREENSHOT = process.env.RYU_PROOF_EVIDENCE_DIR
	? `${process.env.RYU_PROOF_EVIDENCE_DIR}/desktop-profile-tab-personalization.png`
	: new URL(
			"../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-profile-tab-personalization.png",
			import.meta.url
		).pathname;

interface Personalization {
	aboutOrganization: string;
	aboutYou: string;
	nickname: string;
	occupation: string;
}

interface ApiCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface Failure {
	message: string;
	status: number;
}

interface ProfileFixture {
	calls: ApiCall[];
	failNext: (method: string, path: string, failure?: Failure) => void;
	personalization: () => Personalization | null;
	profileName: () => string;
}

const INITIAL_PERSONALIZATION: Personalization = {
	aboutOrganization: "Northstar Studio",
	aboutYou: "I design workflows for small teams.",
	nickname: "Morgan",
	occupation: "Product designer",
};

async function openProfile(
	page: import("@playwright/test").Page,
	options: {
		initialFailure?: { failure: Failure; method: string; path: string };
	} = {}
): Promise<ProfileFixture> {
	let profileName = "Morgan Example";
	let personalization: Personalization | null = {
		...INITIAL_PERSONALIZATION,
	};
	const calls: ApiCall[] = [];
	const failures = new Map<string, Failure[]>();
	if (options.initialFailure) {
		const { failure, method, path } = options.initialFailure;
		failures.set(`${method} ${path}`, [failure]);
	}

	await page.route(
		/\/api\/(?:auth\/get-session|profile\/name|preferences\/user-personalization)$/u,
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const method = request.method();
			let requestBody: ProofJsonValue = null;
			const postData = request.postData();
			if (postData) {
				try {
					requestBody = parseProofJson(postData);
				} catch {
					requestBody = postData;
				}
			}

			const failureKey = `${method} ${url.pathname}`;
			const queuedFailures = failures.get(failureKey);
			const failure = queuedFailures?.shift();
			let status = failure?.status ?? 200;
			let responseBody: ProofJsonValue = failure
				? { error: failure.message }
				: { ok: true };

			if (!failure && method === "GET" && url.pathname === SESSION_PATH) {
				responseBody = {
					user: {
						email: "morgan@example.test",
						id: "profile-proof-user",
						image: null,
						name: profileName,
					},
				};
			} else if (
				!failure &&
				method === "GET" &&
				url.pathname === PERSONALIZATION_PATH
			) {
				if (personalization === null) {
					status = 404;
					responseBody = { error: "Preference not found" };
				} else {
					responseBody = {
						key: "user-personalization",
						value: JSON.stringify(personalization),
					};
				}
			} else if (
				!failure &&
				method === "PUT" &&
				url.pathname === PERSONALIZATION_PATH
			) {
				const decoded = z.object({ value: z.string() }).safeParse(requestBody);
				const value = decoded.success ? decoded.data.value : undefined;
				if (isNativeText(value)) {
					personalization = z
						.object({
							aboutOrganization: z.string(),
							aboutYou: z.string(),
							nickname: z.string(),
							occupation: z.string(),
						})
						.parse(JSON.parse(value));
				}
			} else if (
				!failure &&
				method === "PUT" &&
				url.pathname === PROFILE_NAME_PATH
			) {
				const decoded = z.object({ name: z.string() }).safeParse(requestBody);
				const name = decoded.success ? decoded.data.name : undefined;
				if (isNativeText(name)) {
					profileName = name;
				}
			} else if (!failure && responseBody && url.pathname !== SESSION_PATH) {
				status = 404;
				responseBody = {
					error: `Unexpected proof API: ${method} ${url.pathname}`,
				};
			}

			calls.push({ body: requestBody, method, path: url.pathname, status });
			if (queuedFailures?.length === 0) {
				failures.delete(failureKey);
			}
			await route.fulfill({
				body: JSON.stringify(responseBody),
				contentType: "application/json",
				status,
			});
		}
	);

	const browserErrors: string[] = [];
	const failedResponses: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("response", (response) => {
		if (response.status() >= 400) {
			failedResponses.push(`${response.status()} ${response.url()}`);
		}
	});
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	await page.goto(STORY_URL);
	try {
		await expect(page.getByTestId("profile-tab-settings-proof")).toBeVisible();
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nBrowser errors: ${browserErrors.join(" | ") || "none"}\nFailed responses: ${failedResponses.join(" | ") || "none"}`
		);
	}
	if (!options.initialFailure) {
		await expect(page.getByPlaceholder("Nickname")).toBeEnabled();
	}
	return {
		calls,
		failNext: (
			method,
			apiPath,
			failure = { message: "Fixture unavailable", status: 503 }
		) => {
			const key = `${method} ${apiPath}`;
			failures.set(key, [...(failures.get(key) ?? []), failure]);
		},
		personalization: () => personalization,
		profileName: () => profileName,
	};
}

function writesTo(fixture: ProfileFixture, path: string): ApiCall[] {
	return fixture.calls.filter(
		(call) => call.method === "PUT" && call.path === path
	);
}

test("display name rejects blank input and persists a trimmed session name", async ({
	page,
}) => {
	const fixture = await openProfile(page);
	const name = page.getByPlaceholder("Your name");
	const save = page.getByRole("button", { exact: true, name: "Save" });
	await expect(name).toHaveValue("Morgan Example");
	await expect(page.getByLabel("Email")).toBeDisabled();

	await name.fill("   ");
	await expect(save).toBeDisabled();
	await name.press("Enter");
	expect(writesTo(fixture, PROFILE_NAME_PATH)).toEqual([]);

	await name.fill("  Riley Example  ");
	await name.press("Enter");
	await expect(name).toHaveValue("Riley Example");
	await expect.poll(fixture.profileName).toBe("Riley Example");
	expect(writesTo(fixture, PROFILE_NAME_PATH)).toEqual([
		{
			body: { name: "Riley Example" },
			method: "PUT",
			path: PROFILE_NAME_PATH,
			status: 200,
		},
	]);

	await page.reload();
	await expect(page.getByPlaceholder("Your name")).toHaveValue("Riley Example");
});

test("display-name failure keeps the draft and retries the same exact write", async ({
	page,
}) => {
	const fixture = await openProfile(page);
	const name = page.getByPlaceholder("Your name");
	const save = page.getByRole("button", { exact: true, name: "Save" });
	fixture.failNext("PUT", PROFILE_NAME_PATH, {
		message: "Profile service unavailable",
		status: 503,
	});
	await name.fill("Riley Retry");
	await save.click();
	await expect(
		page.getByText("Couldn't update your name", { exact: true })
	).toBeVisible();
	await expect(name).toHaveValue("Riley Retry");
	await expect.poll(fixture.profileName).toBe("Morgan Example");
	await expect(save).toBeEnabled();

	await save.click();
	await expect.poll(fixture.profileName).toBe("Riley Retry");
	await expect(name).toHaveValue("Riley Retry");
	expect(writesTo(fixture, PROFILE_NAME_PATH)).toEqual([
		{
			body: { name: "Riley Retry" },
			method: "PUT",
			path: PROFILE_NAME_PATH,
			status: 503,
		},
		{
			body: { name: "Riley Retry" },
			method: "PUT",
			path: PROFILE_NAME_PATH,
			status: 200,
		},
	]);
});

test("node-local personalization saves all fields and reads them back after reload", async ({
	page,
}) => {
	const fixture = await openProfile(page);
	const expected: Personalization = {
		aboutOrganization: "Cedar Research Group",
		aboutYou: "I build accessibility tools for public libraries.",
		nickname: "Rae",
		occupation: "Accessibility engineer",
	};

	await page.getByLabel("Nickname").fill(expected.nickname);
	await page.getByLabel("Occupation").fill(expected.occupation);
	await page.getByLabel("More about you").fill(expected.aboutYou);
	await page
		.getByLabel("About your organization")
		.fill(expected.aboutOrganization);
	await page
		.getByTestId("profile-tab-settings-proof")
		.getByRole("button", { name: "Save personalization" })
		.click();
	// About you reaches every thread's system prompt, so a change asks first.
	await page.getByRole("button", { name: "Apply now" }).click();
	await expect(
		page.getByText("Personalization saved", { exact: true })
	).toBeVisible();
	await expect.poll(fixture.personalization).toEqual(expected);
	expect(writesTo(fixture, PERSONALIZATION_PATH)).toEqual([
		{
			body: { value: JSON.stringify(expected) },
			method: "PUT",
			path: PERSONALIZATION_PATH,
			status: 200,
		},
	]);

	await page.reload();
	await expect(page.getByLabel("Nickname")).toHaveValue(expected.nickname);
	await expect(page.getByLabel("Occupation")).toHaveValue(expected.occupation);
	await expect(page.getByLabel("More about you")).toHaveValue(
		expected.aboutYou
	);
	await expect(page.getByLabel("About your organization")).toHaveValue(
		expected.aboutOrganization
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: PERSONALIZATION_SCREENSHOT,
	});
});

test("personalization save failure preserves the draft for an exact retry", async ({
	page,
}) => {
	const fixture = await openProfile(page);
	const expected: Personalization = {
		...INITIAL_PERSONALIZATION,
		aboutYou: "Draft retained after a network failure.",
	};
	fixture.failNext("PUT", PERSONALIZATION_PATH, {
		message: "Core is temporarily unavailable",
		status: 503,
	});
	await page.getByLabel("More about you").fill(expected.aboutYou);
	const save = page
		.getByTestId("profile-tab-settings-proof")
		.getByRole("button", { name: "Save personalization" });
	await save.click();
	await page.getByRole("button", { name: "Apply now" }).click();
	await expect(
		page.getByText("Couldn't save personalization", { exact: true })
	).toBeVisible();
	await expect(page.getByLabel("More about you")).toHaveValue(
		expected.aboutYou
	);
	await expect.poll(fixture.personalization).toEqual(INITIAL_PERSONALIZATION);
	await expect(save).toBeEnabled();

	await save.click();
	// The failed write left the node unchanged, so the retry asks again.
	await page.getByRole("button", { name: "Apply now" }).click();
	await expect.poll(fixture.personalization).toEqual(expected);
	expect(writesTo(fixture, PERSONALIZATION_PATH)).toEqual([
		{
			body: { value: JSON.stringify(expected) },
			method: "PUT",
			path: PERSONALIZATION_PATH,
			status: 503,
		},
		{
			body: { value: JSON.stringify(expected) },
			method: "PUT",
			path: PERSONALIZATION_PATH,
			status: 200,
		},
	]);
});

test("failed personalization read blocks edits until Retry recovers saved values", async ({
	page,
}) => {
	const fixture = await openProfile(page, {
		initialFailure: {
			failure: {
				message: "Core read is temporarily unavailable",
				status: 503,
			},
			method: "GET",
			path: PERSONALIZATION_PATH,
		},
	});
	await expect(
		page.getByText(
			"Couldn’t load your saved profile details. Retry before editing so you don’t overwrite them."
		)
	).toBeVisible();
	await expect(page.getByLabel("Nickname")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Save personalization" })
	).toHaveCount(0);
	expect(writesTo(fixture, PERSONALIZATION_PATH)).toEqual([]);

	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByLabel("Nickname")).toHaveValue(
		INITIAL_PERSONALIZATION.nickname
	);
	await expect(page.getByLabel("Occupation")).toHaveValue(
		INITIAL_PERSONALIZATION.occupation
	);
	expect(
		fixture.calls.filter(
			(call) => call.method === "GET" && call.path === PERSONALIZATION_PATH
		)
	).toHaveLength(2);
	expect(writesTo(fixture, PERSONALIZATION_PATH)).toEqual([]);
});
