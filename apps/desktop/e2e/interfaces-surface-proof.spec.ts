// The real in-app interface chrome: the desktop App (Layout in OS product
// mode, with the workspace interfaces rolled out) over the console-access
// fixture's mocked Core and control plane, with an interface active. For
// each case, at 1280 and at 390, the host's top bar (the Ryu lockup, the
// labelled switcher, Marketplace and Settings) must be visible, unobstructed
// (the topmost element at each control's centre) and clickable.
//
// Screenshots land in docs/proof/interfaces/surface/.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { installConsoleAccessAppFixture } from "./console-access-app-proof.fixture.ts";

// Under software WebGL (CI) a 3D scene's frame can hold the main thread for
// over a second, so every step here allows for slow input handling.
test.describe.configure({ timeout: 600_000 });
const STEP_MS = 90_000;

const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/interfaces/surface"
);
mkdirSync(PROOF_DIR, { recursive: true });

/** A Marketplace interface with junk params and a long label. */
const MALFORMED = {
	description: "",
	id: "@fixture/broken:night",
	label: "A Marketplace interface with a long, unwieldy name",
	params: { camera: 7, junk: true, theme: "lava" },
	plugin: "@fixture/broken",
	renderer: "world-3d",
};

const CASES = [
	{ id: "ryu:kitchen", name: "kitchen", label: "Kitchen" },
	{ id: "ryu:passport", name: "passport", label: "Passport" },
	{ id: "ryu:aquarium", name: "aquarium", label: "Aquarium" },
	{ id: "ryu:world-3d", name: "world-3d", label: "World 3D" },
	{ id: "ryu:board", name: "board", label: "Board" },
	{ id: MALFORMED.id, name: "malformed-marketplace", label: MALFORMED.label },
] as const;

const VIEWPORTS = [
	{ height: 800, width: 1280 },
	{ height: 844, width: 390 },
] as const;

async function installApp(page: Page, interfaceId: string) {
	const fixture = await installConsoleAccessAppFixture(page);
	fixture.setRole("owner");
	// The two rollout flags, on: OS and the workspace interfaces beyond it.
	await page.route("**/api/billing/subscription-status", (route) =>
		route.fulfill({
			body: JSON.stringify({
				entitlement: {
					desktopAccess: true,
					managedInference: true,
					marketplaceApps: true,
					monthlyCreditPoolMicroUsd: 15_000_000,
					plan: "pro",
					seats: 1,
				},
				features: { "ui.interface_os": true, "ui.workspace_interfaces": true },
				plan: "pro",
				subscription: {
					currentPeriodEnd: "2099-01-01T00:00:00Z",
					interval: "month",
					status: "active",
				},
			}),
			contentType: "application/json",
		})
	);
	await page.route("**/api/plugins/contributions", async (route) => {
		await route.fulfill({
			body: JSON.stringify({
				agent_edit_panels: [],
				backgrounds: [],
				companions: [],
				interfaces: [MALFORMED],
			}),
			contentType: "application/json",
		});
	});
	await page.addInitScript((id) => {
		localStorage.setItem("ryu:product-mode", "os");
		localStorage.setItem("ryu:workspace-interface", id);
	}, interfaceId);
}

/**
 * Click a bar control. A heavy 3D scene, or the fixture's reconnect banner,
 * can keep the layout from settling for Playwright's stability check; the
 * obstruction probe already proved the control is on top, so fall back to a
 * click that skips that wait.
 */
async function press(locator: Locator) {
	try {
		await locator.click({ timeout: 20_000 });
	} catch {
		await locator.click({ force: true, timeout: STEP_MS });
	}
}

/**
 * Open the switcher menu. A click is a toggle, so under a slow main thread
 * click again only once the menu has had time to open and has not: a
 * fallback click after a timed-out but delivered click would close it.
 */
async function openSwitcherMenu(switcher: Locator, back: Locator) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (await back.isVisible()) {
			return;
		}
		await switcher.click({ force: attempt > 0, timeout: STEP_MS });
		try {
			await back.waitFor({ state: "visible", timeout: 30_000 });
			return;
		} catch {
			// Not open yet; try again.
		}
	}
	await expect(back).toBeVisible({ timeout: STEP_MS });
}

/** Every bar control must be the topmost element at its own centre. */
async function obstructions(page: Page): Promise<string[]> {
	return await page.evaluate(() => {
		const bar = document.querySelector('[data-testid="ryu-interface-topbar"]');
		if (!bar) {
			return ["no top bar"];
		}
		const buttons = [
			...bar.querySelectorAll('nav[aria-label="Workspace"] button'),
		];
		const named = (text: string) =>
			buttons.find((button) => button.textContent?.includes(text)) ?? null;
		const controls: [string, Element | null][] = [
			["Ryu lockup", bar.querySelector("svg")?.closest("span") ?? null],
			[
				"switcher",
				bar.querySelector('[data-testid="interface-switcher-button"]'),
			],
			["Marketplace", named("Marketplace")],
			["Settings", named("Settings")],
		];
		const problems: string[] = [];
		for (const [name, element] of controls) {
			if (!element) {
				problems.push(`${name}: missing`);
				continue;
			}
			const rect = element.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) {
				problems.push(`${name}: zero size`);
				continue;
			}
			if (rect.right > window.innerWidth || rect.left < 0) {
				problems.push(`${name}: off screen`);
				continue;
			}
			const hit = document.elementFromPoint(
				rect.left + rect.width / 2,
				rect.top + rect.height / 2
			);
			if (!(hit && (hit === element || element.contains(hit)))) {
				problems.push(
					`${name}: covered by ${hit?.tagName.toLowerCase() ?? "nothing"}`
				);
			}
		}
		return problems;
	});
}

for (const viewport of VIEWPORTS) {
	for (const item of CASES) {
		test(`${item.name} @${viewport.width}: the host bar is visible, unobstructed and clickable`, async ({
			page,
		}) => {
			await page.setViewportSize(viewport);
			// Software WebGL in CI: reduced motion lets the 3D scenes rest, so a
			// continuous render loop does not starve the clicks under test.
			await page.emulateMedia({ reducedMotion: "reduce" });
			await installApp(page, item.id);
			await page.goto("/console-access-app-proof.html");
			const surface = page.locator(
				`[data-testid="ryu-interface-surface"][data-interface="${item.id}"]`
			);
			await expect(surface).toBeVisible({ timeout: 60_000 });
			const bar = page.getByTestId("ryu-interface-topbar");
			const switcher = page.getByTestId("interface-switcher-button");
			await expect(bar).toBeVisible();
			await expect(switcher).toBeVisible();
			await expect(switcher).toHaveAttribute("title", "Switch interface");
			await expect(switcher).toContainText(item.label.slice(0, 12));
			// Let the renderer mount and draw (3D scenes load lazily).
			await page.waitForTimeout(6000);
			await page.screenshot({
				animations: "disabled",
				path: path.join(PROOF_DIR, `${item.name}-${viewport.width}.png`),
			});
			expect(await obstructions(page)).toEqual([]);

			// Clickable: the switcher opens the menu, with Back to chat first.
			const back = page.getByRole("menuitem", { name: "Back to chat" });
			await openSwitcherMenu(switcher, back);
			await page.screenshot({
				animations: "disabled",
				path: path.join(PROOF_DIR, `${item.name}-${viewport.width}-menu.png`),
			});
			await page.keyboard.press("Escape");
			await expect(back).toBeHidden({ timeout: STEP_MS });

			// Settings and Marketplace open as pages over the interface.
			await press(
				bar
					.getByRole("navigation", { name: "Workspace" })
					.getByRole("button", { name: "Settings" })
			);
			await expect(page.getByTestId("ryu-interface-page")).toBeVisible({
				timeout: STEP_MS,
			});
			await page
				.getByTestId("ryu-interface-page")
				.getByRole("button", { name: /^Back to/ })
				.click({ timeout: STEP_MS });
			await expect(page.getByTestId("ryu-interface-page")).toBeHidden({
				timeout: STEP_MS,
			});
			await press(
				bar
					.getByRole("navigation", { name: "Workspace" })
					.getByRole("button", { name: "Marketplace" })
			);
			await expect(page.getByTestId("ryu-interface-page")).toBeVisible({
				timeout: STEP_MS,
			});
			// The bar stays reachable over a page too.
			expect(await obstructions(page)).toEqual([]);
		});
	}
}
