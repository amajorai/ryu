// Real-browser proof for the workspace interfaces designed after the first
// layouts: Planets, Stream, Forum, Live, Posts, Community, Wiki, Dashboard,
// Mind Map, Gallery, Newspaper, Q&A, Cinema, Noticeboard, Mail, Status, Path,
// Glance, Hub and Quiz Show. Each is mounted by
// `e2e/harness/interfaces-story.{html,tsx}` from the REAL renderer in
// `packages/blocks/src/desktop/interfaces/`, over the same fixture snapshot
// the other interface proofs use.
//
// Contract asserted per interface: it renders from the snapshot without a
// page error, a thread the host has open shows the host's thread view (the
// story's labelled stub), and the renderer closes that thread through the
// port (its own close control, or Escape where that is its close key).
//
// Screenshots land in `docs/proof/interfaces/<key>-spec.png`; the unsuffixed
// PNGs beside them are the designers' curated shots and are never overwritten.

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the blocks and ui module graphs on first load.
test.describe.configure({ timeout: 120_000 });

const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/interfaces"
);

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => {
		errors.push(error.message);
	});
});

test.afterEach(({ page }) => {
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

function storyUrl(params: Record<string, string>): string {
	return `/interfaces-story.html?${new URLSearchParams(params).toString()}`;
}

/** Capture once finite CSS transitions and animations have run. */
async function shot(page: Page, name: string): Promise<void> {
	await page.evaluate(async () => {
		const settling = document
			.getAnimations()
			.filter((animation) =>
				Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
			);
		await Promise.all(
			settling.map((animation) => animation.finished.catch(() => undefined))
		);
	});
	await page.screenshot({ path: path.join(PROOF_DIR, `${name}-spec.png`) });
}

/**
 * Every designed interface, with how it closes an open thread: the accessible
 * name of its close control, or `Escape` where the key is the close action.
 */
const DESIGNED: readonly {
	close: "Escape" | RegExp;
	key: string;
	label: string;
}[] = [
	{ close: "Escape", key: "planets", label: "Planets" },
	{ close: /^Back$/, key: "stream", label: "Stream" },
	{ close: "Escape", key: "forum", label: "Forum" },
	{ close: "Escape", key: "live", label: "Live" },
	{ close: "Escape", key: "posts", label: "Posts" },
	{ close: "Escape", key: "community", label: "Community" },
	// The wiki shows the conversation as a page's Talk tab; its Article (or
	// Main Page) tab goes back to the page.
	{ close: /^(Article|Main Page)$/, key: "wiki", label: "Wiki" },
	{ close: "Escape", key: "dashboard", label: "Dashboard" },
	{ close: "Escape", key: "mindmap", label: "Mind Map" },
	{ close: "Escape", key: "gallery", label: "Gallery" },
	{ close: "Escape", key: "newspaper", label: "Newspaper" },
	{ close: "Escape", key: "qa", label: "Q&A" },
	{ close: "Escape", key: "cinema", label: "Cinema" },
	{ close: "Escape", key: "noticeboard", label: "Noticeboard" },
	{ close: /^Back to /, key: "mail", label: "Mail" },
	{ close: "Escape", key: "status", label: "Status" },
	{ close: "Escape", key: "path", label: "Path" },
	{ close: "Escape", key: "glance", label: "Glance" },
	{ close: "Escape", key: "hub", label: "Hub" },
	{ close: "Escape", key: "quiz", label: "Quiz Show" },
];

for (const { close, key, label } of DESIGNED) {
	test(`${label}: renders the snapshot and hosts the open thread`, async ({
		page,
	}) => {
		await page.goto(storyUrl({ interface: key, thread: "thread-hero" }));
		await expect(page.getByTestId(`interface-${key}`).first()).toBeVisible();
		const host = page.getByTestId("stub-thread-view");
		await expect(host).toBeVisible();
		await expect(host).toContainText("preloading it");
		await shot(page, key);

		if (close === "Escape") {
			await host.click({ position: { x: 4, y: 4 } });
			await page.keyboard.press("Escape");
		} else {
			await page.getByRole("button", { name: close }).first().click();
		}
		await expect(page.getByTestId("port-log")).toContainText("closeThread()");
	});
}
