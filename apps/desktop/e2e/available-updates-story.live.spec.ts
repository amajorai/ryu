// Real-browser spec for the "Available updates" section (`e2e/harness/
// available-updates-story.{html,tsx}`), run against a LIVE Core.
//
// This is the regression guard for a bug that every static check passed: the
// download center listed an engine update forever, and pressing Update returned
// HTTP 200 having done nothing, because the catalog advertised the upstream
// release while the installer could only ever deliver its compile-time pin — and
// the install it called was idempotent, so it hit an already-installed fast path.
// Nothing was reported either way, so the button looked dead.
//
// It therefore asserts the ROUND TRIP, not the rendering:
//   • a row exists exactly when the NODE says an update is deliverable;
//   • pressing it sends `force=true`, which is what makes Core re-download
//     instead of skipping;
//   • the outcome is reported to the user.
//
// OPT-IN: not part of the default run (`testIgnore` in playwright.config.ts).
//   RYU_CORS_ORIGINS=http://localhost:5177 <start Core>   # allow this origin
//   bun run test:e2e:live
// A Core IS required — running this without one is an error, not a skip. Which
// Core it targets comes from VITE_CORE_URL (default the dev profile's :8980).
//
// To exercise the apply branch, stage an engine behind its pin on the running
// Core (edit its entry in the profile's `versions.json`); otherwise the node
// reports nothing updatable and the spec asserts the no-phantom-row case
// instead. Both branches assert — neither is a silent pass.

import { expect, test } from "@playwright/test";

// The story pulls the whole download-center + react-query module graph, which
// vite compiles on first navigation.
test.describe.configure({ timeout: 120_000 });

const STORY_URL = "/available-updates-story.html";
const CORE_URL = process.env.VITE_CORE_URL ?? "http://127.0.0.1:8980";

/** The fields of a catalog entry this spec reasons about. */
interface CatalogEntry {
	install_state: string;
	name: string;
	update_available?: boolean;
}

/**
 * The node's own verdict. Fails loudly when Core is unreachable: this suite is
 * opt-in and exists to test a live round trip, so "no Core" is a broken run
 * rather than a condition to quietly tolerate.
 */
async function catalogEntries(): Promise<CatalogEntry[]> {
	let resp: Response;
	try {
		resp = await fetch(`${CORE_URL}/api/catalog`);
	} catch (err) {
		throw new Error(
			`no Core reachable at ${CORE_URL} — start one with RYU_CORS_ORIGINS=http://localhost:5177 (${
				err instanceof Error ? err.message : String(err)
			})`
		);
	}
	const json = await resp.json();
	return json.sidecars ?? [];
}

test("the section matches the node's verdict, and applying forces a reinstall", async ({
	page,
}) => {
	const entries = await catalogEntries();
	const updatable = entries.filter((s) => s.update_available === true);

	// Capture what a press actually sends. `force=true` is the entire difference
	// between an update and a no-op, so asserting the click merely "fired a
	// request" would re-admit the original bug.
	const installRequests: string[] = [];
	page.on("request", (req) => {
		if (req.method() === "POST" && req.url().includes("/api/setup/")) {
			installRequests.push(req.url());
		}
	});

	await page.goto(STORY_URL);
	await expect(page.getByTestId("story-title")).toBeVisible();

	const heading = page.getByText("Available updates");

	if (updatable.length === 0) {
		// Nothing is deliverable, so the section must not render at all. This is
		// the state a pinned engine sitting at its pin produces — and the state
		// that used to show a permanent, un-pressable row.
		await expect(heading).toHaveCount(0);
		return;
	}

	// The heading only renders when the hook produced at least one update, so its
	// presence already proves the node's verdict reached the UI.
	await expect(heading).toBeVisible({ timeout: 60_000 });

	const updateButton = page.getByRole("button", { name: "Update" }).first();
	await expect(updateButton).toBeVisible();
	await updateButton.click();

	// Every outcome is now reported — silence was the complaint.
	await expect(page.getByText(/Updating|Couldn't update/).first()).toBeVisible({
		timeout: 30_000,
	});

	expect(installRequests.length).toBeGreaterThan(0);
	expect(installRequests.some((url) => url.includes("force=true"))).toBe(true);
});
