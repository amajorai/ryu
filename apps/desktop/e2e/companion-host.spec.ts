import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// PATH-B COMPANION CERTIFICATE — the handshake every shipped app depends on,
// run under the SHELL CSP the desktop actually ships.
//
// A companion app (`ui_format: "html"`) ships a `vite-plugin-singlefile` bundle
// that Core serves from `GET /api/plugins/:id/ui-bundle`; the desktop wraps it in
// `htmlCompanionSrcdoc` and mounts it in the null-origin `<ExtensionHost>` frame.
// The panel sits on "…is taking a while / The sandboxed interface hasn't connected
// yet" until the frame's injected bridge posts `ryu-plugin-ready` and the host
// transfers the RPC port.
//
// Two gaps let that break silently, and this spec closes both:
//
//  1. **No real bundle was ever mounted.** `html-companion.test.ts` wraps
//     `"<p>hi</p>"` under happy-dom, and `plugin-runtime.spec.ts` certifies Path A
//     (the base64 / `new Function` path no shipped app uses). `companion connects`
//     below runs the ACTUAL fixture bytes through the ACTUAL wrapper and the
//     ACTUAL `<ExtensionHost>` in real Chromium.
//
//  2. **CSP INHERITANCE — the bug this spec was written for.** A document loaded
//     from `about:srcdoc` does not get a fresh policy container: it INHERITS the
//     embedder's CSP, and the two policies then apply as a conjunction. The frame's
//     own `<meta>` CSP (`script-src 'unsafe-inline' 'unsafe-eval'`) is therefore
//     not enough on its own — if the SHELL's `script-src` forbids inline script,
//     the injected bridge never executes, `ryu-plugin-ready` is never posted, and
//     every companion in the product hangs on "taking a while" forever. That is
//     exactly what happened when `app.security.csp` went from `null` to
//     `script-src 'self'`: no test noticed, because no test ran a companion frame
//     under the shell's policy. `under the shipped shell CSP` below reads the CSP
//     out of `src-tauri/tauri.conf.json` itself, so tightening it back re-fails
//     here instead of in the user's hands.
//
// Loosening `script-src` in the shell does NOT loosen the sandbox: the frame keeps
// its own `default-src 'none'; connect-src 'none'` policy, and the conjunction means
// the strictest of the two wins for everything except the inline-script permission
// the frame explicitly grants itself. The egress lock is unaffected.
//
// Fixtures are read off disk rather than imported into the harness bundle: they are
// the same bytes `include_str!` compiles into Core, and pulling 550 KB of HTML
// through the vite graph on every story build buys nothing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../core/src/plugin_manifest/fixtures");
const TAURI_CONF = path.resolve(HERE, "../src-tauri/tauri.conf.json");

/** The CSP the shipped desktop shell applies to its own document — and therefore,
 *  by policy-container inheritance, to every `srcdoc` app frame inside it. Read
 *  from the config so this certificate tracks what ships, never a copy of it. */
function shippedShellCsp(): string {
	const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
	const csp = conf.app?.security?.csp;
	if (!isNativeText(csp) || csp.length === 0) {
		throw new Error(
			"apps/desktop/src-tauri/tauri.conf.json has no app.security.csp — if the " +
				"shell genuinely ships without a CSP, delete this certificate; do not " +
				"weaken it to pass."
		);
	}
	return csp;
}

/** The three the user reported dead, plus two more on the same path. If one
 *  connects and another does not, the difference is the app; if none do, the
 *  difference is the host — which is what it turned out to be. */
const APPS: { file: string; grants: string[]; id: string }[] = [
	{ file: "calendar.ui.html", grants: ["calendar:crud"], id: "@ryu/calendar" },
	{ file: "learning.ui.html", grants: ["learning:crud"], id: "@ryu/learning" },
	{ file: "webhooks.ui.html", grants: ["webhooks:crud"], id: "@ryu/webhooks" },
	{
		file: "approvals.ui.html",
		grants: ["approvals:crud", "quests:crud"],
		id: "@ryu/approvals",
	},
	{
		file: "activity.ui.html",
		grants: ["activity:read", "shell:integrate"],
		id: "@ryu/activity",
	},
];

interface CompanionApi {
	announced: string[];
	connected: () => boolean;
	mount: (options: {
		appHtml: string;
		grants: string[];
		pluginId: string;
	}) => void;
	srcdoc: () => string;
}

declare global {
	interface Window {
		__ryuCompanion: CompanionApi;
	}
}

function readFixture(file: string): string {
	return readFileSync(path.join(FIXTURES, file), "utf8");
}

/** Mount an app in the harness and hand back the composed srcdoc. */
async function mountInHarness(
	page: Page,
	app: (typeof APPS)[number]
): Promise<string> {
	await page.goto("/companion-host-story.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate((opts) => window.__ryuCompanion.mount(opts), {
		appHtml: readFixture(app.file),
		grants: app.grants,
		pluginId: app.id,
	});
	return await page.evaluate(() => window.__ryuCompanion.srcdoc());
}

async function mountRawCompanion(page: Page, srcdoc: string): Promise<string> {
	return page.evaluate(
		(frameHtml) =>
			new Promise<string>((resolve) => {
				const timeout = window.setTimeout(() => finish("timeout"), 5000);
				const finish = (result: string) => {
					window.clearTimeout(timeout);
					window.removeEventListener("message", onMessage);
					resolve(result);
				};
				const onMessage = (event: MessageEvent<unknown>) => {
					if (event.data === "csp-fetch-allowed") {
						finish("allowed");
					} else if (event.data === "csp-fetch-blocked") {
						finish("blocked");
					}
				};
				window.addEventListener("message", onMessage);
				const frame = document.createElement("iframe");
				frame.setAttribute("sandbox", "allow-scripts");
				frame.srcdoc = frameHtml;
				document.body.appendChild(frame);
			}),
		srcdoc
	);
}

for (const app of APPS) {
	test(`companion '${app.id}' completes the sandbox handshake`, async ({
		page,
	}) => {
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push(msg.text());
			}
		});
		page.on("pageerror", (err) => consoleErrors.push(String(err)));

		const srcdoc = await mountInHarness(page, app);

		// The builder intentionally prepends the security prefix before the app's
		// `<html><head>` token. The HTML parser places that prefix in the document
		// head, while the raw-string ordering guarantees that hostile pre-head app
		// markup cannot run before the bridge.
		const appDocumentAt = srcdoc.indexOf("<html");
		const cspAt = srcdoc.indexOf("Content-Security-Policy");
		const bridgeAt = srcdoc.indexOf("ryu-plugin-ready");
		const appScriptAt = srcdoc.indexOf('<script type="module"');
		expect(appDocumentAt).toBeGreaterThanOrEqual(0);
		expect(cspAt).toBeGreaterThanOrEqual(0);
		expect(cspAt).toBeLessThan(appDocumentAt);
		expect(bridgeAt).toBeGreaterThan(cspAt);
		expect(appScriptAt).toBeGreaterThan(bridgeAt);

		// The handshake itself. Generous but finite: the panel gives up (shows the
		// stall state) at 8s, so anything slower is a user-visible failure anyway.
		await expect
			.poll(() => page.evaluate(() => window.__ryuCompanion.connected()), {
				timeout: 15_000,
			})
			.toBe(true);

		// Which half broke, when it breaks.
		const announced = await page.evaluate(
			() => window.__ryuCompanion.announced
		);
		expect(
			announced,
			`frame never announced; console: ${consoleErrors.join(" | ")}`
		).toContain("ryu-plugin-ready");
	});
}

test("a companion frame still announces under the shipped shell CSP", async ({
	page,
}) => {
	const app = APPS[0];
	const srcdoc = await mountInHarness(page, app);
	const csp = shippedShellCsp();

	// A page carrying the SHELL's policy, then the real composed srcdoc inside a
	// real sandboxed frame. `page.evaluate` is exempt from page CSP, but the frame
	// it creates inherits the policy exactly as one created by app code would —
	// which is the whole point.
	await page.setContent(
		`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('"', "&quot;")}"></head><body></body></html>`
	);
	const announced = await page.evaluate(async (frameHtml: string) => {
		const seen: string[] = [];
		window.addEventListener("message", (event: MessageEvent) => {
			if (event.data?.kind === "ryu-plugin-ready") {
				seen.push("ryu-plugin-ready");
			}
		});
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts");
		frame.srcdoc = frameHtml;
		document.body.appendChild(frame);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		return seen;
	}, srcdoc);

	expect(
		announced,
		"the app frame never announced under the shell CSP — an `about:srcdoc` " +
			"document INHERITS the embedder's policy, so a shell `script-src` without " +
			"'unsafe-inline' silently kills the bridge in every companion, widget and " +
			"artifact frame. Restore it in apps/desktop/src-tauri/tauri.conf.json."
	).toContain("ryu-plugin-ready");
});

test("the custom-app CSP setting controls direct network access in the sandbox", async ({
	page,
}) => {
	let networkRequests = 0;
	await page.route("https://csp-test.invalid/**", async (route) => {
		networkRequests += 1;
		await route.fulfill({ status: 204 });
	});
	const shellCsp = shippedShellCsp();
	await page.setContent(
		`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${shellCsp.replaceAll('"', "&quot;")}"></head><body></body></html>`
	);
	const appHtml = `<!doctype html><html><head></head><body><script>fetch("https://csp-test.invalid/ping", { mode: "no-cors" }).then(() => parent.postMessage("csp-fetch-allowed", "*"), () => parent.postMessage("csp-fetch-blocked", "*"));</script></body></html>`;
	const enforced = htmlCompanionSrcdoc(
		"nonce-default-csp",
		appHtml,
		"@test/custom-app"
	);

	expect(await mountRawCompanion(page, enforced)).toBe("blocked");
	expect(networkRequests).toBe(0);

	await page.evaluate(() => {
		for (const frame of document.querySelectorAll("iframe")) {
			frame.remove();
		}
	});
	const disabled = htmlCompanionSrcdoc(
		"nonce-csp-disabled",
		appHtml,
		"@test/custom-app",
		undefined,
		undefined,
		undefined,
		false,
		{ enforceDefaultCsp: false }
	);

	expect(await mountRawCompanion(page, disabled)).toBe("allowed");
	expect(networkRequests).toBeGreaterThan(0);
});

test("the shipped shell CSP keeps its narrowing while permitting the bootstraps", () => {
	const directives = new Map(
		shippedShellCsp()
			.split(";")
			.map((d) => d.trim())
			.filter(Boolean)
			.map((d) => {
				const space = d.indexOf(" ");
				return space === -1
					? ([d, ""] as const)
					: ([d.slice(0, space), d.slice(space + 1)] as const);
			})
	);

	// Inline SCRIPT ELEMENTS: what the frame bootstraps are. `script-src-elem` is
	// the narrow grant — it does NOT also license inline event handlers.
	expect(directives.get("script-src-elem")).toContain("'unsafe-inline'");
	// Inline EVENT HANDLERS (`onclick=`, `javascript:`): nothing in the shell or in
	// any frame bootstrap uses one, so they stay denied. This is the whole reason
	// `script-src-elem` is spelled out separately instead of dropping
	// `'unsafe-inline'` into `script-src` and calling it done.
	expect(directives.get("script-src-attr")).toBe("'none'");
	// `script-src` still has to carry `'unsafe-inline'` as the FALLBACK for any
	// engine that does not implement the `-elem`/`-attr` split: an unknown
	// directive is ignored, and `script-src` is what such an engine would enforce.
	// Verified against both engines this ships on (Chromium → WebView2, WebKit →
	// WKWebView/WebKitGTK); both honour `script-src-elem`, but the fallback costs
	// nothing and removes the "silently back to square one" failure mode.
	expect(directives.get("script-src")).toContain("'unsafe-inline'");
	// Eval: Path A (`thirdPartyPluginSrcdoc`) runs a plugin bundle through
	// `new Function`, and `ArtifactRenderer` ships the same allowance for
	// model-generated documents. Both live in frames pinned to `connect-src 'none'`,
	// so there is nothing remote to fetch and eval — but the inherited shell policy
	// still has to permit it, or those two surfaces break exactly the way the
	// companions did.
	expect(directives.get("script-src")).toContain("'unsafe-eval'");
});

test("a sandboxed app can call the grant-gated toast bridge", async ({
	page,
}) => {
	const appHtml = `<!doctype html><html><head></head><body><script>
    (async function () {
      var id = await window.ryu.ui.toast.show({
        title: "Sandbox toast",
        description: "Rendered by the host Sileo surface",
        variant: "loading",
        duration: 60000
      });
      window.parent.postMessage({ kind: "toast-shown" }, "*");
      await window.ryu.ui.toast.update({
        id: id,
        title: "Sandbox toast updated",
        variant: "success"
      });
      window.parent.postMessage({ kind: "toast-updated" }, "*");
    })().catch(function () {
      window.parent.postMessage({ kind: "toast-failed" }, "*");
    });
  </script></body></html>`;

	await page.goto("/companion-host-story.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate((options) => window.__ryuCompanion.mount(options), {
		appHtml,
		grants: ["ui:toast"],
		pluginId: "@ryu/toast-e2e",
	});
	await expect
		.poll(() => page.evaluate(() => window.__ryuCompanion.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	await expect
		.poll(() => page.evaluate(() => window.__ryuCompanion.announced), {
			timeout: 15_000,
		})
		.toContain("toast-updated");
	await expect(page.getByText("Sandbox toast updated")).toBeVisible();
	await page.waitForTimeout(1200);
	await page.screenshot({
		path: test.info().outputPath("plugin-toast-bridge-proof.png"),
		fullPage: true,
	});
});

test("a mounted Companion follows live palette and appearance changes", async ({
	page,
}) => {
	const appHtml = `<!doctype html><html><head><style>
    html, body { height: 100%; margin: 0; }
    body { display: grid; place-items: center; gap: 12px; background: var(--background); color: var(--foreground); font: 16px/1.5 sans-serif; }
    #probe { padding: 16px; background: var(--card); color: var(--foreground); border: 1px solid var(--border); }
    #action { padding: 8px 14px; color: var(--primary-foreground); background: var(--primary); border: 0; border-radius: var(--radius); }
  </style></head><body><div id="probe">Theme-aware Companion</div><button id="action" type="button">Action</button></body></html>`;

	await page.goto("/companion-host-story.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(() => {
		const root = document.documentElement;
		root.className = "light";
		root.style.setProperty("--background", "rgb(247 250 252)");
		root.style.setProperty("--foreground", "rgb(15 23 42)");
		root.style.setProperty("--card", "rgb(255 255 255)");
		root.style.setProperty("--primary", "rgb(37 99 235)");
		root.style.setProperty("--primary-foreground", "rgb(255 255 255)");
		root.style.setProperty("--border", "rgb(203 213 225)");
		root.style.setProperty("--radius", "0.625rem");
		root.style.setProperty("--ryu-ui-scale", "1");
	});
	await page.evaluate((options) => window.__ryuCompanion.mount(options), {
		appHtml,
		grants: [],
		pluginId: "@ryu/appearance-e2e",
	});
	await expect
		.poll(() => page.evaluate(() => window.__ryuCompanion.connected()), {
			timeout: 15_000,
		})
		.toBe(true);

	const frame = page
		.frames()
		.find((candidate) => candidate !== page.mainFrame());
	if (!frame) {
		throw new Error("Companion iframe did not mount");
	}
	await expect(frame.locator("#probe")).toHaveText("Theme-aware Companion");
	const before = await frame.locator("#probe").evaluate((element) => ({
		background: getComputedStyle(element).backgroundColor,
		mode: document.documentElement.getAttribute("data-ryu-theme"),
	}));
	expect(before.background).toBe("rgb(255, 255, 255)");
	expect(before.mode).toBe("light");

	await page.evaluate(() => {
		const root = document.documentElement;
		root.className = "dark";
		root.style.setProperty("--background", "rgb(11 17 32)");
		root.style.setProperty("--foreground", "rgb(248 250 252)");
		root.style.setProperty("--card", "rgb(30 41 59)");
		root.style.setProperty("--primary", "rgb(217 70 239)");
		root.style.setProperty("--primary-foreground", "rgb(255 255 255)");
		root.style.setProperty("--border", "rgb(71 85 105)");
		root.style.setProperty("--radius", "1.25rem");
		root.style.setProperty("--ryu-ui-scale", "1.25");
		root.setAttribute("data-pointer-cursor", "true");
		root.setAttribute("data-dialog-overlay-blur", "off");
		root.setAttribute("data-popup-overlay-blur", "on");
		root.setAttribute("data-ryu-animations", "off");
	});

	await expect
		.poll(
			() =>
				frame.locator("#probe").evaluate((element) => ({
					background: getComputedStyle(element).backgroundColor,
					mode: document.documentElement.getAttribute("data-ryu-theme"),
					radius: document.documentElement.style.getPropertyValue("--radius"),
					zoom: document.documentElement.style.getPropertyValue(
						"--ryu-ui-scale"
					),
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
			mode: "dark",
			radius: "1.25rem",
			zoom: "1.25",
			pointer: "true",
			dialog: "off",
			popup: "on",
			animations: "off",
		});

	await page.screenshot({
		path: "test-results/companion-appearance-proof.png",
		fullPage: true,
	});
});
