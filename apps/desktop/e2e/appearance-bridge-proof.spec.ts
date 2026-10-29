import { expect, test } from "@playwright/test";

const APP_HTML = `<!doctype html><html lang="en"><head><style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: var(--background); color: var(--foreground); font: 16px/1.5 var(--font-sans), sans-serif; }
  #probe { width: 240px; box-sizing: border-box; padding: 16px; background: var(--card); color: var(--foreground); border: 1px solid var(--border); }
  #muted { padding: 8px; background: var(--muted); color: var(--muted-foreground); }
  #action { padding: 8px 14px; color: var(--primary-foreground); background: var(--primary); border: 0; border-radius: var(--radius); }
  #timestamp { font-size: 12px; color: var(--muted-foreground); }
</style></head><body><div id="probe">Theme-aware Companion</div><div id="muted">Muted surface</div><button id="action" type="button">Action</button><div id="timestamp"></div><script>
  const renderTimestamp = () => {
    const locale = document.documentElement.style.getPropertyValue("--ryu-locale");
    const timeZone = document.documentElement.style.getPropertyValue("--ryu-timezone");
    document.getElementById("timestamp").textContent = new Intl.DateTimeFormat(locale, { day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone, year: "numeric" }).format(new Date("2026-01-15T23:30:00.000Z"));
  };
  renderTimestamp();
  new MutationObserver(renderTimestamp).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
</script></body></html>`;

interface AppearanceBridgeApi {
	apply: (input: {
		attributes?: Record<string, string | null>;
		className?: string;
		tokens: Record<string, string>;
	}) => void;
	connected: () => boolean;
	mount: (input: { appHtml: string }) => void;
}

declare global {
	interface Window {
		__ryuAppearanceBridge: AppearanceBridgeApi;
	}
}

test("a mounted Companion follows the complete live appearance snapshot", async ({
	page,
}) => {
	await page.goto("/appearance-bridge-story.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(() => {
		window.__ryuAppearanceBridge.apply({
			className: "light",
			tokens: {
				"--background": "rgb(247 250 252)",
				"--foreground": "rgb(15 23 42)",
				"--card": "rgb(255 255 255)",
				"--muted": "rgb(226 232 240)",
				"--muted-foreground": "rgb(71 85 105)",
				"--primary": "rgb(37 99 235)",
				"--primary-foreground": "rgb(255 255 255)",
				"--border": "rgb(203 213 225)",
				"--radius": "0.625rem",
				"--font-sans": "Inter, sans-serif",
				"--ryu-ui-scale": "1",
				"--ryu-timezone": "UTC",
				"--ryu-locale": "en-US",
			},
		});
	});
	await page.evaluate(
		(appHtml) => window.__ryuAppearanceBridge.mount({ appHtml }),
		APP_HTML
	);
	await expect
		.poll(() => page.evaluate(() => window.__ryuAppearanceBridge.connected()), {
			timeout: 15_000,
		})
		.toBe(true);

	const frame = page
		.frames()
		.find((candidate) => candidate !== page.mainFrame());
	if (!frame) {
		throw new Error("Companion iframe did not mount");
	}
	const frameBefore = frame;
	await expect(frame.locator("#probe")).toHaveText("Theme-aware Companion");
	await expect
		.poll(() =>
			frame.locator("#probe").evaluate((element) => ({
				background: getComputedStyle(element).backgroundColor,
				mode: document.documentElement.getAttribute("data-ryu-theme"),
			}))
		)
		.toEqual({ background: "rgb(255, 255, 255)", mode: "light" });
	await expect(frame.locator("#muted")).toHaveCSS(
		"background-color",
		"rgb(226, 232, 240)"
	);
	await page.evaluate(() => {
		window.__ryuAppearanceBridge.apply({
			attributes: {
				"data-pointer-cursor": "true",
				"data-dialog-overlay-blur": "off",
				"data-popup-overlay-blur": "on",
				"data-ryu-animations": "off",
			},
			className: "dark",
			tokens: {
				"--background": "rgb(11 17 32)",
				"--foreground": "rgb(248 250 252)",
				"--card": "rgb(30 41 59)",
				"--muted": "rgb(51 65 85)",
				"--muted-foreground": "rgb(203 213 225)",
				"--primary": "rgb(217 70 239)",
				"--primary-foreground": "rgb(255 255 255)",
				"--border": "rgb(71 85 105)",
				"--radius": "1.25rem",
				"--spacing": "0.3rem",
				"--card-pad": "1.2rem",
				"--font-sans": "Courier New, monospace",
				"--ryu-ui-scale": "1.25",
				"--ryu-timezone": "America/Los_Angeles",
				"--ryu-locale": "en-GB",
			},
		});
	});

	await expect
		.poll(
			() =>
				frame.locator("#probe").evaluate((element) => ({
					background: getComputedStyle(element).backgroundColor,
					mutedBackground: getComputedStyle(document.getElementById("muted")!)
						.backgroundColor,
					mode: document.documentElement.getAttribute("data-ryu-theme"),
					radius: document.documentElement.style.getPropertyValue("--radius"),
					zoom: document.documentElement.style.getPropertyValue(
						"--ryu-ui-scale"
					),
					spacing: document.documentElement.style.getPropertyValue("--spacing"),
					cardPadding:
						document.documentElement.style.getPropertyValue("--card-pad"),
					font: getComputedStyle(document.body).fontFamily,
					timezone:
						document.documentElement.style.getPropertyValue("--ryu-timezone"),
					locale:
						document.documentElement.style.getPropertyValue("--ryu-locale"),
					formattedTimestamp: new Intl.DateTimeFormat(
						document.documentElement.style.getPropertyValue("--ryu-locale"),
						{
							day: "2-digit",
							hour: "2-digit",
							hourCycle: "h23",
							minute: "2-digit",
							month: "2-digit",
							timeZone:
								document.documentElement.style.getPropertyValue(
									"--ryu-timezone"
								),
							year: "numeric",
						}
					).format(new Date("2026-01-15T23:30:00.000Z")),
					bodyZoom: getComputedStyle(document.body).zoom,
					pointer: document.documentElement.getAttribute("data-pointer-cursor"),
					dialog: document.documentElement.getAttribute(
						"data-dialog-overlay-blur"
					),
					popup: document.documentElement.getAttribute(
						"data-popup-overlay-blur"
					),
					animations: document.documentElement.getAttribute(
						"data-ryu-animations"
					),
				})),
			{ timeout: 15_000 }
		)
		.toEqual({
			background: "rgb(30, 41, 59)",
			mutedBackground: "rgb(51, 65, 85)",
			mode: "dark",
			radius: "1.25rem",
			zoom: "1.25",
			spacing: "0.3rem",
			cardPadding: "1.2rem",
			font: '"Courier New", monospace',
			timezone: "America/Los_Angeles",
			locale: "en-GB",
			formattedTimestamp: "15/01/2026, 15:30",
			// Desktop already zooms the containing root; the Companion must not
			// apply the same scale a second time inside the iframe.
			bodyZoom: "1",
			pointer: "true",
			dialog: "off",
			popup: "on",
			animations: "off",
		});
	await expect(frame.locator("#timestamp")).toHaveText("15/01/2026, 15:30");
	expect(
		page.frames().find((candidate) => candidate !== page.mainFrame())
	).toBe(frameBefore);
	await page.screenshot({
		path: test.info().outputPath("companion-appearance-proof.png"),
		fullPage: true,
	});
});
