import { expect, test } from "@playwright/test";

// Commit-time validation of a declared `number` field in the real
// PluginSettingsFields, in Chromium (the DOM's own `badInput` and
// `stepMismatch` only exist in a real engine). The field under test is the
// harness's "Max attempts": min 1, max 9, step 2, saved value 3.

const STORY_URL = "/plugin-settings-fields-proof.html?reset=true";
const PREF_PATH = "/api/preferences/proof.retry-count";

interface ProofSnapshot {
	preferences: Record<string, string>;
	requests: { body: unknown; method: string; path: string }[];
}

async function snapshot(
	page: import("@playwright/test").Page
): Promise<ProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: plugin-settings-fields-proof.tsx installs __pluginSettingsFieldsProof before this proof page is evaluated. */ (
			window as Window & {
				__pluginSettingsFieldsProof: { snapshot: () => ProofSnapshot };
			}
		).__pluginSettingsFieldsProof.snapshot()
	);
}

async function open(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL, { waitUntil: "commit", timeout: 120_000 });
	await page.waitForFunction(
		() => document.body.dataset.harnessReady === "1",
		null,
		{ timeout: 30_000 }
	);
}

function writes(state: ProofSnapshot) {
	return state.requests.filter(
		(request) => request.method === "PUT" && request.path === PREF_PATH
	);
}

test("a number field refuses unparseable, off-step and out-of-range entries on commit, restores the saved value, and saves only a valid entry", async ({
	page,
}) => {
	await open(page);
	const attempts = page.getByRole("spinbutton", {
		name: "Max attempts",
		exact: true,
	});
	await expect(attempts).toHaveValue("3");
	const park = page.getByRole("heading", { name: "Fixture settings" });

	// Unparseable text never reaches React as a value; the DOM flags it.
	await attempts.click();
	await attempts.press("ControlOrMeta+a");
	await page.keyboard.type("1e");
	await page.keyboard.press("Tab");
	await expect(
		page.getByText("Max attempts — Enter a number.", { exact: true })
	).toBeVisible();
	await expect(attempts).toHaveValue("3");

	// Off the declared step grid (1, 3, 5, 7, 9).
	await attempts.fill("4");
	await attempts.blur();
	await expect(
		page.getByText("Max attempts — Must be a multiple of 2.", { exact: true })
	).toBeVisible();
	await expect(attempts).toHaveValue("3");

	// On the grid but above the maximum.
	await attempts.fill("11");
	await attempts.blur();
	await expect(
		page.getByText("Max attempts — Must be 9 or less.", { exact: true })
	).toBeVisible();
	await expect(attempts).toHaveValue("3");
	expect(writes(await snapshot(page))).toEqual([]);
	expect((await snapshot(page)).preferences["proof.retry-count"]).toBe("3");

	await attempts.fill("7");
	await park.click();
	await expect
		.poll(async () => writes(await snapshot(page)))
		.toEqual([{ body: { value: "7" }, method: "PUT", path: PREF_PATH }]);
	await page.reload({ waitUntil: "commit" });
	await page.waitForFunction(
		() => document.body.dataset.harnessReady === "1",
		null,
		{ timeout: 30_000 }
	);
	await expect(
		page.getByRole("spinbutton", { name: "Max attempts", exact: true })
	).toHaveValue("7");
});
