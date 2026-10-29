import { expect, test } from "@playwright/test";

test("worktree settings persist, validate retention and report save failures", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await page.goto("/worktree-settings-proof.html", {
		waitUntil: "domcontentloaded",
	});
	const root = page.getByRole("textbox", { name: "Worktree root" });
	const fetchUpstream = page.getByRole("switch", {
		name: "Always fetch upstream before creating worktrees",
	});
	const autoDelete = page.getByRole("switch", {
		name: "Automatically delete old worktrees",
	});
	const limit = page.getByRole("spinbutton", { name: "Auto-delete limit" });
	await expect(fetchUpstream).toBeEnabled();
	await expect(root).toBeDisabled();
	await expect(fetchUpstream).toHaveAttribute("aria-checked", "false");
	await expect(autoDelete).toHaveAttribute("aria-checked", "true");
	await expect(limit).toHaveValue("15");
	await page.getByRole("tab", { name: "Node", exact: true }).click();
	await root.fill("C:/Ryu/worktrees");
	await root.press("Tab");
	await expect(fetchUpstream).toBeEnabled();
	await fetchUpstream.click();
	await expect(fetchUpstream).toHaveAttribute("aria-checked", "true");
	await limit.fill("8");
	await limit.press("Tab");
	await expect(fetchUpstream).toBeEnabled();
	await page.reload();
	await expect(root).toHaveValue("C:/Ryu/worktrees");
	await expect(limit).toHaveValue("8");
	await expect(fetchUpstream).toHaveAttribute("aria-checked", "true");
	await limit.fill("1.5");
	await limit.press("Tab");
	await expect(limit).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByRole("alert")).toContainText(
		"Enter a whole number from 1 to 100."
	);
	await page.reload();
	await expect(limit).toHaveValue("8");
	await autoDelete.click();
	await expect(limit).toBeDisabled();
	await page.reload();
	await expect(autoDelete).toHaveAttribute("aria-checked", "false");
	await autoDelete.click();
	await expect(limit).toBeEnabled();
	await page.evaluate(() => {
		sessionStorage.setItem("proof-worktree-save-failure", "true");
		sessionStorage.removeItem("proof-worktree-write-bodies");
	});
	await fetchUpstream.click();
	const saveAlert = page.getByRole("alert").filter({
		hasText: "We couldn’t save Worktree settings. Retry the last change.",
	});
	await expect(saveAlert).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Retry Worktree save" })
	).toBeEnabled();
	await expect(fetchUpstream).toHaveAttribute("aria-checked", "true");
	await page.getByRole("tab", { name: "Node", exact: true }).click();
	await root.fill("C:/Ryu/unsaved-worktrees");
	await root.press("Tab");
	await expect(root).toHaveValue("C:/Ryu/worktrees");
	const refusedWrites = await page.evaluate(() => {
		const bodies: string[] = JSON.parse(
			sessionStorage.getItem("proof-worktree-write-bodies") ?? "[]"
		);
		return bodies.map((body) => JSON.parse(body));
	});
	expect(refusedWrites).toEqual([
		{ scope: "user", values: { autoDelete: true, fetchUpstream: false } },
		{
			scope: "node",
			values: {
				autoDelete: true,
				autoDeleteLimit: 8,
				fetchUpstream: true,
				root: "C:/Ryu/unsaved-worktrees",
			},
		},
	]);
	await page.evaluate(() =>
		sessionStorage.removeItem("proof-worktree-save-failure")
	);
	await page.getByRole("button", { name: "Retry Worktree save" }).click();
	await expect(saveAlert).toHaveCount(0);
	await expect(root).toHaveValue("C:/Ryu/unsaved-worktrees");
	const retriedWrites = await page.evaluate(() => {
		const bodies: string[] = JSON.parse(
			sessionStorage.getItem("proof-worktree-write-bodies") ?? "[]"
		);
		return bodies.map((body) => JSON.parse(body));
	});
	expect(retriedWrites).toEqual([...refusedWrites, refusedWrites[1]]);
	await page.reload();
	await expect(root).toHaveValue("C:/Ryu/unsaved-worktrees");
	await expect(fetchUpstream).toHaveAttribute("aria-checked", "true");
	await expect(limit).toHaveValue("8");
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("worktree-settings-desktop.png"),
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(root).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth
		)
	).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("worktree-settings-mobile.png"),
	});
	expect(errors).toEqual([]);
});
