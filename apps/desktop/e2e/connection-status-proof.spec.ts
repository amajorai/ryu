import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/connection-status-proof.html";

test("connection states keep the workspace mounted and recover in place", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);

	const proof = page.getByTestId("connection-status-proof");
	const toast = page.getByTestId("connection-status-toast");
	const surface = toast.locator('[data-slot="connection-status-surface"]');
	await expect(proof).toHaveAttribute("data-harness-ready", "1");
	await expect(toast).toHaveAttribute(
		"data-connection-phase",
		"node-unreachable"
	);
	await expect(surface).toBeVisible();
	await expect(
		surface.locator('[data-slot="connection-status-title"]')
	).toHaveText("Node offline");
	const detail = surface.locator('[data-slot="connection-status-detail"]');
	await expect(detail).toContainText("Can’t reach Design node");
	await expect(toast).toContainText("Node offline");
	await expect(toast).toContainText("Can’t reach Design node");
	await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible();
	const surfaceStyle = await surface.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			backdropFilter: style.backdropFilter,
			backgroundColor: style.backgroundColor,
			borderWidth: style.borderWidth,
			paddingRight: style.paddingRight,
		};
	});
	expect(surfaceStyle.backdropFilter).not.toBe("none");
	expect(surfaceStyle.backgroundColor).toContain("0.65");
	expect(surfaceStyle.borderWidth).toBe("0px");
	expect(Number.parseFloat(surfaceStyle.paddingRight)).toBeGreaterThanOrEqual(
		15
	);
	const icon = surface.locator('span[aria-hidden="true"]');
	expect(
		await icon.evaluate((element) => getComputedStyle(element).boxShadow)
	).toBe("none");
	const retryGeometry = await toast
		.getByRole("button", { name: "Retry" })
		.evaluate((element) => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return {
				cornerShape: style.getPropertyValue("corner-shape"),
				height: Math.round(rect.height),
				width: Math.round(rect.width),
			};
		});
	expect(retryGeometry.width).toBe(retryGeometry.height);
	expect(["round", "superellipse(1)"]).toContain(retryGeometry.cornerShape);
	await page.screenshot({
		path: testInfo.outputPath("connection-status-pill-proof.png"),
	});
	await page.setViewportSize({ width: 360, height: 720 });
	await expect
		.poll(() =>
			detail.evaluate((element) => getComputedStyle(element).maskImage)
		)
		.not.toBe("none");
	await detail.hover();
	await expect(page.getByRole("tooltip")).toHaveText(
		"Can’t reach Design node. Reconnecting automatically…"
	);
	await page.screenshot({
		path: testInfo.outputPath("connection-status-tooltip-proof.png"),
	});
	await page.mouse.move(20, 100);
	await page.setViewportSize({ width: 1280, height: 720 });

	await page.getByRole("button", { name: "Simulate no Wi-Fi" }).click();
	await expect(toast).toHaveAttribute("data-connection-phase", "offline");
	await expect(toast).toContainText("Offline mode");
	await expect(toast).toContainText("Waiting for connectivity");
	await expect(toast.getByRole("button", { name: "Retry" })).toHaveCount(0);
	await page.screenshot({
		path: testInfo.outputPath("offline-mode-proof.png"),
	});

	await page.getByRole("button", { name: "Confirm restored" }).click();
	await expect(toast).toHaveAttribute("data-connection-phase", "online");
	await expect(toast).toHaveAttribute("data-connection-restored", "true");
	await expect(toast).toContainText("Connection restored");
	await page.screenshot({
		path: testInfo.outputPath("connection-restored-proof.png"),
	});

	await page.getByRole("button", { name: "Reconnect" }).click();
	await expect(toast).toHaveAttribute("data-connection-phase", "checking");
	await expect(toast).toContainText("Connecting to Design node");
	await page.getByRole("button", { name: "Finish recovery" }).click();
	await expect(toast).toHaveCount(0);
});

test("status pills stack, expand for hover and keyboard, and recover independently", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Toggle second status" }).click();
	const toasts = page.getByTestId("connection-status-toast");
	const front = toasts.filter({ hasText: "Offline mode" });
	const behind = toasts.filter({ hasText: "Node offline" });
	await expect(front).toHaveAttribute("data-stack-index", "0");
	await expect(behind).toHaveAttribute("data-stack-index", "1");
	const surface = (toast: typeof front) =>
		toast.locator('[data-slot="connection-status-surface"]');
	const gap = async () => {
		const first = await surface(front).boundingBox();
		const second = await surface(behind).boundingBox();
		return second && first ? second.y - first.y - first.height : -100;
	};
	await expect.poll(gap).toBeLessThan(0);
	await expect
		.poll(() =>
			surface(behind)
				.locator("span[aria-hidden]")
				.evaluate((element) => getComputedStyle(element).opacity)
		)
		.toBe("0");
	await page.screenshot({
		path: testInfo.outputPath("connection-status-collapsed-stack.png"),
	});
	await surface(front).hover();
	await expect(behind).toHaveAttribute("data-stack-expanded", "true");
	await expect.poll(gap).toBeGreaterThanOrEqual(7);
	await page.screenshot({
		path: testInfo.outputPath("connection-status-expanded-stack.png"),
	});
	await surface(behind).hover();
	await expect(behind).toHaveAttribute("data-stack-expanded", "true");
	await page.mouse.move(20, 200);
	await expect(behind).toHaveAttribute("data-stack-expanded", "false");
	await behind.getByRole("button", { name: "Retry" }).focus();
	await expect(behind).toHaveAttribute("data-stack-expanded", "true");
	await expect.poll(gap).toBeGreaterThanOrEqual(7);
	await page.getByRole("button", { name: "Finish recovery" }).click();
	await expect(toasts).toHaveCount(1);
	await expect(front).toHaveAttribute("data-stack-index", "0");
});

test("reduced motion shows settled states without entry or exit movement", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(STORY_URL);
	const toast = page.getByTestId("connection-status-toast");
	await expect(toast).toBeVisible();
	await expect
		.poll(() =>
			toast.evaluate((element) => getComputedStyle(element).transform)
		)
		.toBe("none");
	await page.getByRole("button", { name: "Reconnect" }).click();
	await expect(toast).toContainText("Connecting to Design node");
	await page.getByRole("button", { name: "Finish recovery" }).click();
	await expect(toast).toHaveCount(0);
});
