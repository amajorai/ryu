interface ProgressStyleEvidence {
	fillClassName: string;
	fillColor: string;
	foregroundColor: string;
	height: number;
	trackClassName: string;
	trackColor: string;
}

interface IndeterminateProgressEvidence {
	ariaValueNow: string | null;
	marqueeVisible: boolean;
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-progress-proof.html";
const PROOF_DIR = "e2e/artifacts";
const PROOF_PATH = path.resolve(PROOF_DIR);

test("onboarding progress stays slim and contrasts in both themes", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	const evidence: Record<
		string,
		ProgressStyleEvidence | IndeterminateProgressEvidence
	> = {};
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await mkdir(PROOF_PATH, { recursive: true });

	for (const theme of ["light", "dark"]) {
		await page.goto(`${STORY_URL}?theme=${theme}`);
		const themeView = page.getByTestId(`theme-${theme}`);
		const progress = themeView.getByRole("progressbar", {
			name: "Setting up",
		});
		await expect(progress).toBeVisible();
		await expect(progress).toHaveAttribute("aria-valuemax", "100");
		await expect(progress).toHaveAttribute("aria-valuenow", "42");
		const reveal = progress.locator("xpath=../..");
		await expect(reveal).toHaveClass(/opacity-100/);
		await expect(reveal).toHaveCSS("opacity", "1");

		const styles = await progress.evaluate((track) => {
			const fill = track.firstElementChild;
			const themeRoot = track.closest('[data-testid^="theme-"]');
			if (!(fill instanceof HTMLElement && themeRoot instanceof HTMLElement)) {
				throw new Error("Progress track or theme root is missing");
			}

			return {
				fillColor: getComputedStyle(fill).backgroundColor,
				fillClassName: fill.className,
				foregroundColor: getComputedStyle(themeRoot).color,
				height: track.getBoundingClientRect().height,
				trackColor: getComputedStyle(track).backgroundColor,
				trackClassName: track.className,
			};
		});

		expect(styles.height).toBeGreaterThan(3);
		expect(styles.height).toBeLessThan(5);
		expect(styles.fillClassName.split(/\s+/)).toContain("bg-foreground");
		expect(styles.trackClassName.split(/\s+/)).toContain("bg-muted");
		expect(styles.fillColor).toBe(styles.foregroundColor);
		expect(styles.trackColor).not.toBe(styles.fillColor);
		evidence[theme] = styles;

		await page.screenshot({
			fullPage: true,
			path: path.join(PROOF_DIR, `onboarding-progress-${theme}.png`),
		});

		if (theme === "light") {
			await page.waitForTimeout(3600);
			await expect(progress).toHaveAttribute("aria-valuenow", "42");
		}
	}

	await page.goto(`${STORY_URL}?theme=dark&progress=unknown`);
	const indeterminate = page.getByRole("progressbar", { name: "Setting up" });
	await expect(indeterminate).toBeVisible();
	await expect(indeterminate).not.toHaveAttribute("aria-valuenow", /\d+/);
	await expect(indeterminate.locator(".t-progress-marquee")).toBeVisible();
	evidence.indeterminate = {
		ariaValueNow: await indeterminate.getAttribute("aria-valuenow"),
		marqueeVisible: await indeterminate
			.locator(".t-progress-marquee")
			.isVisible(),
	};

	await writeFile(
		path.join(PROOF_DIR, "onboarding-progress-proof.log.json"),
		JSON.stringify({ evidence, pageErrors }, null, 2)
	);
	expect(pageErrors).toEqual([]);
});
