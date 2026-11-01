import { spawn } from "node:child_process";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

export function uniqueTitle(prefix: string) {
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	return `${prefix} ${timestamp} ${crypto.randomUUID().slice(0, 8)}`;
}

export async function projectTitleField(page: Page) {
	return page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
}

export async function openOverflowTab(
	page: Page,
	label: string,
	value: string
) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

export async function coverageImage(page: Page): Promise<Buffer> {
	const bytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Canvas rendering is unavailable in this browser.");
		}

		const gradient = context.createLinearGradient(0, 0, 640, 360);
		gradient.addColorStop(0, "#101d35");
		gradient.addColorStop(1, "#075985");
		context.fillStyle = gradient;
		context.fillRect(0, 0, 640, 360);
		context.fillStyle = "#f59e0b";
		context.beginPath();
		context.arc(510, 174, 66, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = "#f8fafc";
		context.font = "600 34px sans-serif";
		context.fillText("RYU VIDEO STUDIO", 36, 150);
		context.font = "20px sans-serif";
		context.fillText("Real sidecar export regression", 38, 190);

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => {
				if (result) {
					resolve(result);
				} else {
					reject(new Error("Canvas could not create the PNG fixture."));
				}
			}, "image/png");
		});
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	return Buffer.from(bytes);
}

export async function extractRgbFrame(videoPath: string): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", [
			"-v",
			"error",
			"-ss",
			"1",
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"pipe:1",
		]);
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-2000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(new Error(stderr || `Frame extraction exited with ${code}.`));
			}
		});
	});
}

export async function downloadArtifact(page: Page, buttonName: string) {
	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: buttonName }).click();
	const download = await downloadPromise;
	const outputPath = await download.path();
	if (!outputPath) {
		throw new Error(
			`The ${buttonName} download was not preserved by Playwright.`
		);
	}
	return { download, outputPath };
}

export async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	await expect(page.locator(".studio-workspace")).not.toHaveAttribute(
		"inert",
		""
	);
	await expect(
		page.getByRole("button", { name: "Export video" })
	).toBeDisabled();
	const titleField = await projectTitleField(page);
	await expect(titleField).toBeVisible();
	await titleField.fill(title);
	await expect(titleField).toHaveValue(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	return titleField;
}
