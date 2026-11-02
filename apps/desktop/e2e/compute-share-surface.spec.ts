import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const proofDir = proofEvidencePath();
const artifactDir = resolve(
	import.meta.dirname,
	"../artifacts/ui-design-audit/screenshots"
);

const cases = [
	{ mode: "compute", theme: "light", width: 1280, height: 900 },
	{ mode: "share", theme: "dark", width: 390, height: 844 },
] as const;

test.setTimeout(120_000);

for (const scenario of cases) {
	test(`renders ${scenario.mode} in ${scenario.theme} without overflow`, async ({
		page,
	}) => {
		const pageErrors: string[] = [];
		const failedRequests: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("requestfailed", (request) => {
			failedRequests.push(
				`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`
			);
		});

		await page.setViewportSize({
			height: scenario.height,
			width: scenario.width,
		});
		await page.goto(
			`/compute-share-proof.html?mode=${scenario.mode}&theme=${scenario.theme}`
		);
		await page.waitForSelector('body[data-harness-ready="1"]');

		const surface = page.getByTestId(`${scenario.mode}-surface`);
		await expect(surface).toHaveAttribute("data-exchange-state", "preview");
		await expect(page.getByText("Early access", { exact: true })).toBeVisible();
		await expect(
			page.getByText("Exchange preview", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Publish listing|Find capacity/ })
		).toBeDisabled();

		if (scenario.mode === "compute") {
			await expect(
				page.getByText("Borrow a lane. Keep your node.", { exact: true })
			).toBeVisible();
			await page.getByRole("button", { name: "GPU" }).click();
			await expect(page.getByRole("button", { name: "GPU" })).toHaveAttribute(
				"aria-pressed",
				"true"
			);
			await page.getByRole("button", { name: "4 hours" }).click();
			await expect(
				page.getByRole("button", { name: "4 hours" })
			).toHaveAttribute("aria-pressed", "true");
		} else {
			await expect(
				page.getByText("Put an idle node to work.", { exact: true })
			).toBeVisible();
			await page.getByRole("button", { name: "Hosted agent" }).click();
			await expect(
				page.getByRole("button", { name: "Hosted agent" })
			).toHaveAttribute("aria-pressed", "true");
			await page.getByRole("button", { name: "On a schedule" }).click();
			await expect(
				page.getByRole("button", { name: "On a schedule" })
			).toHaveAttribute("aria-pressed", "true");
			await page
				.getByRole("switch", { name: "Only accept leases when idle" })
				.click();
			await expect(
				page.getByText("Accept leases whenever the provider schedule allows.", {
					exact: true,
				})
			).toBeVisible();
		}

		const evidence = await page.evaluate(() => ({
			bodyText: document.body.innerText,
			height: innerHeight,
			horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
			width: innerWidth,
		}));
		await mkdir(artifactDir, { recursive: true });
		await page.screenshot({
			fullPage: true,
			path: resolve(
				artifactDir,
				`compute-share-${scenario.mode}-${scenario.theme}.png`
			),
		});
		await mkdir(proofDir, { recursive: true });
		await writeFile(
			resolve(
				proofDir,
				`compute-share-${scenario.mode}-${scenario.theme}.log.json`
			),
			`${JSON.stringify(
				{ scenario, evidence, failedRequests, pageErrors },
				null,
				2
			)}\n`
		);

		expect(evidence.horizontalOverflow).toBe(false);
		expect(pageErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
	});
}
