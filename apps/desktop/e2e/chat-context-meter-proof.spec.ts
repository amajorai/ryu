import { expect, type Locator, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

async function expectSemanticColor(trigger: Locator, token: string) {
	const colors = await trigger.evaluate((element, role) => {
		const probe = document.createElement("span");
		probe.style.color = `var(--status-${role})`;
		element.append(probe);
		const expected = getComputedStyle(probe).color;
		probe.remove();
		const actual = getComputedStyle(element).color;
		const icon = element.querySelector("svg");
		if (!icon) throw new Error("Context meter icon missing");
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas color conversion unavailable");
		const rgba = (color: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data].map((v) => v / 255);
		};
		const ancestors: Element[] = [];
		for (
			let current: Element | null = element;
			current;
			current = current.parentElement
		)
			ancestors.unshift(current);
		let background = [1, 1, 1];
		for (const ancestor of ancestors) {
			const value = rgba(getComputedStyle(ancestor).backgroundColor);
			background = background.map(
				(channel, i) => value[i] * value[3] + channel * (1 - value[3])
			);
		}
		const luminance = (channels: number[]) =>
			channels
				.slice(0, 3)
				.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
				.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
		const values = [luminance(background), luminance(rgba(actual))].sort(
			(a, b) => a - b
		);
		return {
			actual,
			expected,
			icon: getComputedStyle(icon).color,
			contrast: (values[1] + 0.05) / (values[0] + 0.05),
		};
	}, token);
	expect(colors.actual, `${token} resolves to the themed status color`).toBe(
		colors.expected
	);
	expect(colors.icon, `${token} icon matches its readable label`).toBe(
		colors.actual
	);
	expect(
		colors.contrast,
		`${token} small text contrast`
	).toBeGreaterThanOrEqual(4.5);
	return colors.actual;
}

test("renders semantic warning and critical context colors", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));

	await page.goto("/chat-context-meter-proof.html");

	const warning = page.getByTestId("warning-meter");
	const critical = page.getByTestId("critical-meter");
	const warningTrigger = warning.getByLabel(/Context 73% used/);
	const criticalTrigger = critical.getByLabel(/Context 90% used/);

	await expect(warningTrigger).toHaveClass(/text-status-warning/);
	await expect(warningTrigger).not.toHaveClass(/text-amber-500/);
	await expect(warningTrigger.locator("svg")).toHaveClass(
		/text-status-warning/
	);
	await expect(criticalTrigger).toHaveClass(/text-status-destructive/);
	await expect(criticalTrigger).not.toHaveClass(/text-amber-500/);
	await expect(criticalTrigger.locator("svg")).toHaveClass(
		/text-status-destructive/
	);

	const lightWarningColor = await expectSemanticColor(
		warningTrigger,
		"warning"
	);
	await expectSemanticColor(criticalTrigger, "destructive");

	await page.getByTestId("theme-toggle").click();
	await expect(page.locator("html")).toHaveClass(/dark/);
	const darkWarningColor = await expectSemanticColor(warningTrigger, "warning");
	await expectSemanticColor(criticalTrigger, "destructive");
	expect(darkWarningColor).not.toBe(lightWarningColor);

	await expect(warningTrigger).toHaveClass(/text-status-warning/);
	await expect(criticalTrigger).toHaveClass(/text-status-destructive/);
	await expect(page.locator(".text-amber-500")).toHaveCount(0);
	expect(browserErrors).toEqual([]);

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("chat-context-meter-proof.png"),
	});
});
