import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		/** Installed by this spec's context init script before any page script runs. */
		refusedWasm: number;
	}
}

test("actual Markdown fallback completes independent colored blocks and copies exact source", async ({
	page,
	context,
}) => {
	const directory = process.env.RYU_APPS_STORE_PROOF_DIR;
	if (!(directory && path.isAbsolute(directory))) {
		throw new Error("fresh absolute proof directory required");
	}
	await mkdir(directory, { recursive: true });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.addInitScript(() => {
		window.refusedWasm = 0;
		const refuse = () => {
			window.refusedWasm += 1;
			throw new Error("proof host refuses WebAssembly");
		};
		WebAssembly.instantiate = refuse;
		WebAssembly.compile = refuse;
	});
	await page.goto("/highlighter-proof.html");
	const first =
		"<script>const answer = 42;</script><button>Hello</button>  \n\n";
	const second = `${first}<button>Independent second block</button>  \n\n`;
	// Standard Streamdown hides terminal LF-only lines in its visual body,
	// while preserving the full source for Copy. These independently written
	// display fixtures retain every trailing space and internal blank line.
	const firstDisplay =
		"<script>const answer = 42;</script><button>Hello</button>  ";
	const secondDisplay = `${firstDisplay}\n\n<button>Independent second block</button>  `;
	const source = async (id: string) =>
		page
			.getByTestId(id)
			.locator("code")
			.evaluate((code) =>
				Array.from(code.children)
					.map((line) =>
						line.textContent === "\n" ? "" : (line.textContent ?? "")
					)
					.join("\n")
			);
	for (const [id, expected] of [
		["first", firstDisplay],
		["second", secondDisplay],
	]) {
		await expect.poll(() => source(id)).toBe(expected);
		await expect
			.poll(() =>
				page
					.getByTestId(id)
					.locator("code span[style]")
					.evaluateAll(
						(tokens) =>
							new Set(tokens.map((token) => getComputedStyle(token).color)).size
					)
			)
			.toBeGreaterThan(1);
	}
	expect(await page.evaluate(() => window.refusedWasm)).toBeGreaterThan(0);
	await page.getByRole("button", { name: "Update first block" }).click();
	await expect.poll(() => source("first")).toBe(secondDisplay);
	await page
		.getByRole("button", { name: "Replace queued block with cached source" })
		.click();
	await expect.poll(() => source("first")).toBe(secondDisplay);
	await expect(page.getByTestId("queue-settled")).toHaveText("settled");
	await expect.poll(() => source("first")).toBe(secondDisplay);
	await page
		.getByTestId("first")
		.locator('[data-streamdown="code-block-copy-button"]')
		.click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		`${second}\n`
	);
	const colors = await page.locator("code span[style]").evaluateAll((tokens) =>
		tokens.map((token) => ({
			text: token.textContent,
			computedColor: getComputedStyle(token).color,
			tokenColor: token.style.getPropertyValue("--sdm-c"),
			lightColor: token.style.getPropertyValue("--shiki-light"),
		}))
	);
	await writeFile(
		path.join(directory, "token-colors.json"),
		JSON.stringify(colors, null, 2)
	);
	expect(
		new Set(colors.map((token) => token.computedColor)).size
	).toBeGreaterThan(1);
	const rawColor = await page
		.locator("main")
		.evaluate((element) => getComputedStyle(element).color);
	expect(colors.some((token) => token.computedColor !== rawColor)).toBe(true);
	expect(errors).toEqual([]);
	const lightBackground = await page
		.locator("#root")
		.evaluate((body) => getComputedStyle(body).backgroundColor);
	expect(lightBackground).not.toBe("rgba(0, 0, 0, 0)");
	await page.screenshot({
		path: path.join(directory, "code-highlighter-completed-light.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Toggle dark appearance" }).click();
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expect
		.poll(() =>
			page
				.locator("#root")
				.evaluate((body) => getComputedStyle(body).backgroundColor)
		)
		.not.toBe(lightBackground);
	const darkColors = await page
		.locator("code span[style]")
		.evaluateAll((tokens) =>
			tokens.map((token) => getComputedStyle(token).color)
		);
	expect(new Set(darkColors).size).toBeGreaterThan(1);
	expect(darkColors).not.toEqual(colors.map((token) => token.computedColor));
	await expect.poll(() => source("first")).toBe(secondDisplay);
	await page
		.getByTestId("first")
		.locator('[data-streamdown="code-block-copy-button"]')
		.click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		`${second}\n`
	);
	await writeFile(
		path.join(directory, "dark-token-colors.json"),
		JSON.stringify(darkColors, null, 2)
	);
	await page.screenshot({
		path: path.join(directory, "code-highlighter-completed-dark.png"),
		fullPage: true,
	});
});
