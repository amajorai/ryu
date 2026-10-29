import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const RECOVER_ON_RELOAD_KEY = "crash-boundary-proof-recover-on-reload";

interface CrashBoundaryProofWindow extends Window {
	__crashBoundaryCopiedText?: string;
	__crashBoundaryProof: {
		allowRecovery: boolean;
		mountCount: number;
	};
}

function evidencePath(name: string): string {
	return resolve(
		root,
		`docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function openTerminal(
	page: import("@playwright/test").Page,
	options: { developerMode?: boolean; theme?: "dark" | "light" } = {}
): Promise<void> {
	await page.addInitScript((developerModeKey) => {
		if (developerModeKey) {
			localStorage.setItem("ryu_developer_mode", "true");
		}
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					/* SAFETY: crash-boundary-proof.spec.ts installs __crashBoundaryCopiedText before this proof page is evaluated. */ (
						window as Window & { __crashBoundaryCopiedText?: string }
					).__crashBoundaryCopiedText = text;
				},
			},
		});
	}, options.developerMode === true);
	await page.goto(
		`/crash-boundary-proof.html?theme=${options.theme ?? "light"}`
	);
	await page.waitForSelector('body[data-harness-ready="1"]');
	await expect(
		page.getByText("Something broke", { exact: true })
	).toBeVisible();
}

for (const [theme, width] of [
	["light", 1280],
	["dark", 390],
] as const) {
	test(`renders the compact dead-logo crash fallback in ${theme}`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width, height: 780 });
		await page.goto(`/crash-boundary-proof.html?theme=${theme}`);
		await page.waitForSelector('body[data-harness-ready="1"]');

		await expect(
			page.getByText("Something broke", { exact: true })
		).toBeVisible();
		await expect(
			page.getByText("Try again or reload.", { exact: true })
		).toBeVisible();
		await expect(
			page.locator('[data-expressive-expression="dead"]')
		).toBeVisible();
		await expect(page.locator('[data-expressive-eye-shape="x"]')).toHaveCount(
			2
		);
		await expect(
			page.getByRole("button", { name: "Try again", exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Reload", exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Copy console", exact: true })
		).toHaveCount(0);

		const evidence = await page.evaluate(() => ({
			bodyText: document.body.innerText,
			height: innerHeight,
			horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
			width: innerWidth,
		}));
		await testInfo.attach("render-evidence", {
			body: JSON.stringify({ theme, ...evidence }, null, 2),
			contentType: "application/json",
		});
		await page.screenshot({
			path: resolve(
				root,
				`artifacts/ui-design-audit/screenshots/crash-boundary-${theme}.png`
			),
		});
		await page.screenshot({
			path: evidencePath(`crash-boundary-terminal-${theme}`),
		});

		expect(evidence.horizontalOverflow).toBe(false);
	});
}

test("Try again remounts the failed child and recovers when its state is repaired", async ({
	page,
}) => {
	await openTerminal(page);
	const mountCountBefore = await page.evaluate(
		() =>
			/* SAFETY: crash-boundary-proof.tsx installs __crashBoundaryProof before this proof page is evaluated. */ (
				window as CrashBoundaryProofWindow
			).__crashBoundaryProof.mountCount
	);
	await page.evaluate(() => {
		/* SAFETY: crash-boundary-proof.tsx installs __crashBoundaryProof before this proof page is evaluated. */ (
			window as CrashBoundaryProofWindow
		).__crashBoundaryProof.allowRecovery = true;
	});
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(page.getByTestId("recovered-child")).toBeVisible();
	await expect(page.getByText("Something broke", { exact: true })).toHaveCount(
		0
	);
	const recoveredMountCount = await page.evaluate(
		() =>
			/* SAFETY: crash-boundary-proof.tsx installs __crashBoundaryProof before this proof page is evaluated. */ (
				window as CrashBoundaryProofWindow
			).__crashBoundaryProof.mountCount
	);
	expect(recoveredMountCount).toBe(mountCountBefore + 1);
	await page.screenshot({
		path: evidencePath("crash-boundary-try-again-recovered"),
	});
});

test("Reload performs a document reload and mounts the recovered child", async ({
	page,
}) => {
	await openTerminal(page);
	await page.evaluate(
		(key) => sessionStorage.setItem(key, "true"),
		RECOVER_ON_RELOAD_KEY
	);
	const navigation = page.waitForEvent("framenavigated");
	await page.getByRole("button", { name: "Reload", exact: true }).click();
	await navigation;
	await page.waitForLoadState("load");
	await page.waitForSelector('body[data-harness-ready="1"]');
	const recovered = page.getByTestId("recovered-child");
	await expect(recovered).toBeVisible();
	await expect(recovered).toContainText("The app recovered after remount.");
	await expect(page.getByText("Something broke", { exact: true })).toHaveCount(
		0
	);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			})
	);
	const recoveredVisual = await recovered.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return {
			height: rect.height,
			text: element.textContent,
			visibility: style.visibility,
			width: rect.width,
		};
	});
	expect(recoveredVisual).toMatchObject({
		text: "The app recovered after remount.",
		visibility: "visible",
	});
	expect(recoveredVisual.height).toBeGreaterThan(0);
	expect(recoveredVisual.width).toBeGreaterThan(0);
	const navigationType = await page.evaluate(() =>
		performance.getEntriesByType("navigation").map(
			(entry) =>
				// SAFETY: the native Performance API returns only navigation timing entries for the "navigation" entry type.
				(entry as PerformanceNavigationTiming).type
		)
	);
	expect(navigationType).toContain("reload");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("crash-boundary-reload-recovered"),
	});
});

test("Copy console writes the crash and component stacks plus captured console output", async ({
	page,
}) => {
	await openTerminal(page, { developerMode: true });
	await expect(
		page.getByRole("button", { name: "Copy console", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Copy console", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Copied", exact: true })
	).toBeVisible();
	const copiedText = await page.evaluate(
		() =>
			/* SAFETY: crash-boundary-proof.spec.ts installs __crashBoundaryCopiedText before this proof page is evaluated. */ (
				window as CrashBoundaryProofWindow
			).__crashBoundaryCopiedText ?? ""
	);
	expect(copiedText).toContain("Crash boundary visual proof");
	expect(copiedText).toContain("Component stack:");
	expect(copiedText).toMatch(/Component stack:\n\s*at\s+\S+/);
	expect(copiedText).toContain("Crash boundary proof console breadcrumb");
	await page.screenshot({
		path: evidencePath("crash-boundary-console-copied"),
	});
});

declare global {
	interface Window {
		__crashBoundaryCopiedText?: string;
		__crashBoundaryProof: {
			allowRecovery: boolean;
			mountCount: number;
		};
	}
}
