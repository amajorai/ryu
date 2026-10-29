declare const window: Window;

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface PickerPaintWindow extends Window {
	__pickerPaintSamples: number[];
}

const agentCount = Number(process.env.RYU_PICKER_AGENTS ?? 250);
const deferOffscreen = process.env.RYU_PICKER_DEFER === "1";

test("measure populated picker input-to-frame time independently of click waits", async ({
	page,
	browserName,
}) => {
	await page.route("**/api/**", (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		const payloads = {
			"/api/agents": {
				agents: Array.from({ length: agentCount }, (_, index) => ({
					id: `fixture-${index}`,
					name: `Performance fixture ${String(index).padStart(4, "0")}`,
				})),
			},
			"/api/mcp/servers": {
				servers: [
					{
						name: "Workspace",
						command: "fixture",
						enabled: true,
						available: true,
						transport: "stdio",
					},
				],
			},
			"/api/mcp/tools": { tools: [] },
			"/api/apps": { apps: [] },
			"/api/identities": { profiles: [] },
		};
		const payload = Object.entries(payloads).find(
			([endpoint]) => endpoint === url.pathname
		)?.[1];
		return route.fulfill({ json: payload ?? {} });
	});
	await page.goto("/mcp-performance-proof.html");
	if (deferOffscreen) {
		await page.addStyleTag({
			content:
				"[data-slot=select-item] { content-visibility: auto; contain-intrinsic-size: auto 1.75rem; }",
		});
	}
	await page.getByRole("button", { name: "Filter & add", exact: true }).click();
	await page.evaluate(() => {
		const samples: number[] = [];
		// SAFETY: this callback installs and owns the native numeric sample array read by later callbacks.
		const proofWindow = window as PickerPaintWindow;
		proofWindow.__pickerPaintSamples = samples;
		document.addEventListener(
			"pointerdown",
			(event) => {
				const trigger =
					event.target instanceof Element
						? event.target.closest("#agent-filter")
						: null;
				if (!trigger || trigger.getAttribute("aria-expanded") === "true") {
					return;
				}
				const started = performance.now();
				const wait = () => {
					const popup = document.querySelector<HTMLElement>(
						'[data-slot="select-content"]'
					);
					if (
						popup?.getClientRects().length &&
						popup.querySelector('[role="option"]')
					) {
						requestAnimationFrame(() =>
							requestAnimationFrame(() =>
								samples.push(performance.now() - started)
							)
						);
					} else if (performance.now() - started < 5000) {
						requestAnimationFrame(wait);
					}
				};
				requestAnimationFrame(wait);
			},
			true
		);
	});
	const cdp =
		browserName === "chromium"
			? await page.context().newCDPSession(page)
			: null;
	await cdp?.send("Performance.enable");
	await cdp?.send("Profiler.enable");
	const metrics = async () => {
		if (!cdp) {
			return null;
		}
		const result = await cdp.send("Performance.getMetrics");
		return Object.fromEntries(
			result.metrics.map((metric) => [metric.name, metric.value])
		);
	};
	const samples = [];
	for (let index = 0; index < 5; index++) {
		const before = await metrics();
		if (index === 0 && cdp) {
			await cdp.send("Profiler.start");
		}
		const wall = performance.now();
		await page
			.getByRole("combobox", { name: "Allowlist", exact: true })
			.click();
		await expect(
			page.getByRole("option", {
				name: "Performance fixture 0000",
				exact: true,
			})
		).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => {
					// SAFETY: the preceding instrumentation installs this numeric array on this same page before measuring any pointer events.
					const proofWindow = window as PickerPaintWindow;
					return proofWindow.__pickerPaintSamples.length;
				})
			)
			.toBe(index + 1);
		const after = await metrics();
		const inputToTwoFramesMs = await page.evaluate((index) => {
			// SAFETY: instrumentation above installs and owns the sample array, and the poll confirms the requested index exists.
			const proofWindow = window as PickerPaintWindow;
			return proofWindow.__pickerPaintSamples[index];
		}, index);
		samples.push({
			index,
			inputToTwoFramesMs,
			observedWallMs: performance.now() - wall,
			scriptMs:
				after && before
					? (after.ScriptDuration - before.ScriptDuration) * 1000
					: null,
			layoutMs:
				after && before
					? (after.LayoutDuration - before.LayoutDuration) * 1000
					: null,
			styleMs:
				after && before
					? (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000
					: null,
		});
		if (index === 0 && cdp) {
			const profile = await cdp.send("Profiler.stop");
			await writeFile(
				"/tmp/ryu-agent-picker-cold.cpuprofile",
				JSON.stringify(profile)
			);
		}
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("combobox", { name: "Allowlist", exact: true })
		).toHaveAttribute("aria-expanded", "false");
	}
	const trigger = page.getByRole("combobox", {
		name: "Allowlist",
		exact: true,
	});
	await trigger.click();
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	const finalLabel = `Performance fixture ${String(agentCount - 1).padStart(4, "0")}`;
	await expect(trigger).toContainText(finalLabel);
	await trigger.click();
	await expect(
		page.getByRole("option", { name: finalLabel, exact: true })
	).toBeVisible();
	const triggerBox = await trigger.boundingBox();
	const popupBox = await page
		.locator('[data-slot="select-content"]')
		.boundingBox();
	expect(triggerBox).not.toBeNull();
	expect(popupBox).not.toBeNull();
	expect(popupBox!.y).toBeGreaterThanOrEqual(
		triggerBox!.y + triggerBox!.height - 1
	);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			`../../../docs/proof/performance-sweep/agent-picker-placement${browserName === "chromium" ? "" : `-${browserName}`}-completed.png`
		),
		fullPage: true,
		animations: "disabled",
	});
	await writeFile(
		path.resolve(
			import.meta.dirname,
			`../../../docs/proof/performance-sweep/agent-picker-frame-${agentCount}${deferOffscreen ? "-deferred" : ""}${browserName === "chromium" ? "" : `-${browserName}`}.json`
		),
		`${JSON.stringify({ scope: "Actual Tools Library with controlled agents; pointerdown to two animation frames after popup presence", browserName, agentCount, samples }, null, 2)}\n`
	);
});
