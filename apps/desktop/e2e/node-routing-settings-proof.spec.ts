import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const PAGE_URL = "/node-routing-settings-proof.html";
const ROUTING_PATH = "/api/preferences/node-routing-prefs";
const NODE_TOKEN = "node-routing-proof-token";
// RYU_NODE_ROUTING_PROOF_DIR redirects screenshots for verification runs that
// must not rewrite the tracked evidence images.
const EVIDENCE_DIR =
	process.env.RYU_NODE_ROUTING_PROOF_DIR ??
	path.resolve(
		process.cwd(),
		"../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

interface CoreCall {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

interface ProofSnapshot {
	calls: CoreCall[];
	failedSaves: number;
	preferences: Record<string, string>;
}

interface NodeRoutingProofWindow extends Window {
	__nodeRoutingSettingsProof: {
		armNextSaveFailure: () => void;
		releaseRoutingRead: () => void;
		routingReadStarted: boolean;
		snapshot: () => ProofSnapshot;
	};
}

const SEEDED_ROUTING = {
	fallback: ["openai"],
	firewall: {
		custom_patterns: [
			{ kind: "secret", name: "legacy_id", regex: "legacy-token" },
		],
	},
};

const VALID_RULES = [
	{
		kind: "secret",
		name: " internal_id ",
		regex: " ^X-Internal-Id$ ",
	},
];

const EXPECTED_ROUTING = {
	fallback: ["anthropic", "openrouter"],
	firewall: {
		custom_patterns: [
			{ kind: "secret", name: "internal_id", regex: "^X-Internal-Id$" },
		],
	},
};

async function openNodeRouting(page: Page, query = "") {
	await page.goto(`${PAGE_URL}${query}`, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => {
		// SAFETY: node-routing-settings-proof.tsx installs this typed native fixture observation before the readiness poll.
		const proofWindow = window as NodeRoutingProofWindow;
		return proofWindow.__nodeRoutingSettingsProof !== undefined;
	});
	await expect(
		page.getByRole("heading", { name: "Node routing preferences" })
	).toBeVisible();
	const openButton = page.getByRole("button", {
		name: "Open Gateway settings",
		exact: true,
	});
	await openButton.click();
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	const dialog = page.locator('[data-slot="dialog-content"]').first();
	await expect(dialog).toBeVisible();
	const networkNavigation = dialog.getByRole("button", {
		name: "Network",
		exact: true,
	});
	await expect(networkNavigation).toBeVisible();
	await networkNavigation.click();
	await expect(
		dialog.getByRole("heading", {
			name: "Managed request routing",
			exact: true,
		})
	).toBeVisible();
	return {
		dialog,
		fallback: dialog.getByPlaceholder("anthropic, openrouter, local"),
		patterns: dialog.getByLabel("Extra firewall rules JSON"),
		save: dialog.getByRole("button", {
			name: "Save routing preferences",
			exact: true,
		}),
	};
}

async function readSnapshot(page: Page): Promise<ProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: node-routing-settings-proof.tsx installs __nodeRoutingSettingsProof before this proof page is evaluated. */ (
			window as NodeRoutingProofWindow
		).__nodeRoutingSettingsProof.snapshot()
	);
}

async function saveScreenshot(page: Page, fileName: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.resolve(EVIDENCE_DIR, fileName),
	});
}

function routingCalls(snapshot: ProofSnapshot) {
	return snapshot.calls.filter((call) => call.path === ROUTING_PATH);
}

test("loads disabled routing fields from Core and defaults missing preferences to empty", async ({
	page,
}) => {
	const { dialog, fallback, patterns, save } = await openNodeRouting(
		page,
		"?delayRoutingRead=true"
	);
	await page.waitForFunction(
		() =>
			/* SAFETY: node-routing-settings-proof.tsx installs __nodeRoutingSettingsProof before this proof page is evaluated. */ (
				window as NodeRoutingProofWindow
			).__nodeRoutingSettingsProof.routingReadStarted
	);
	await expect(fallback).toBeDisabled();
	await expect(patterns).toBeDisabled();
	await expect(save).toBeDisabled();

	await page.evaluate(() => {
		/* SAFETY: node-routing-settings-proof.tsx installs __nodeRoutingSettingsProof before this proof page is evaluated. */ (
			window as NodeRoutingProofWindow
		).__nodeRoutingSettingsProof.releaseRoutingRead();
	});
	await expect(fallback).toBeEnabled();
	await expect(patterns).toBeEnabled();
	await expect(save).toBeEnabled();
	await expect(fallback).toHaveValue("");
	await expect(patterns).toHaveValue("");
	await expect(dialog.getByText("Managed request routing")).toBeVisible();
	await saveScreenshot(page, "desktop-node-routing-defaults.png");

	const reads = routingCalls(await readSnapshot(page)).filter(
		(call) => call.method === "GET"
	);
	expect(reads).toEqual([
		{
			authorization: `Bearer ${NODE_TOKEN}`,
			body: null,
			method: "GET",
			path: ROUTING_PATH,
		},
	]);
});

test("validates firewall JSON before sending a Core write", async ({
	page,
}) => {
	const { fallback, patterns, save } = await openNodeRouting(page);
	await fallback.fill("  anthropic , , openrouter  ");

	await patterns.fill("{ invalid");
	await save.click();
	await expect(
		page.getByText("Extra firewall rules must be valid JSON.", { exact: true })
	).toBeVisible();
	await expect(fallback).toHaveValue("  anthropic , , openrouter  ");
	await expect(patterns).toHaveValue("{ invalid");
	await expect(save).toBeEnabled();

	await patterns.fill("{}");
	await save.click();
	await expect(
		page.getByText("Extra firewall rules must be a JSON array.", {
			exact: true,
		})
	).toBeVisible();
	await expect(save).toBeEnabled();

	await patterns.fill('[{"kind":"unsupported","name":"private","regex":"x"}]');
	await save.click();
	await expect(
		page.getByText(
			"Each rule needs a kind (pii, secret, or prompt_injection), name, and regex.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(save).toBeEnabled();
	await expect
		.poll(async () =>
			routingCalls(await readSnapshot(page)).filter(
				(call) => call.method === "PUT"
			)
		)
		.toEqual([]);
});

test("trims provider IDs, saves the exact firewall payload, and reloads persisted values", async ({
	page,
}) => {
	const { fallback, patterns, save } = await openNodeRouting(
		page,
		"?seed=existing"
	);
	await expect(fallback).toHaveValue("openai");
	await expect
		.poll(async () => JSON.parse(await patterns.inputValue()))
		.toEqual(SEEDED_ROUTING.firewall.custom_patterns);

	await fallback.fill("  anthropic, , openrouter  ");
	await patterns.fill(JSON.stringify(VALID_RULES, null, 2));
	await save.click();
	await expect(
		page.getByText("Routing preferences saved", { exact: true })
	).toBeVisible();
	await expect(save).toBeEnabled();

	const expectedValue = JSON.stringify(EXPECTED_ROUTING);
	const saved = await readSnapshot(page);
	expect(routingCalls(saved).filter((call) => call.method === "PUT")).toEqual([
		{
			authorization: `Bearer ${NODE_TOKEN}`,
			body: { value: expectedValue },
			method: "PUT",
			path: ROUTING_PATH,
		},
	]);
	expect(saved.preferences["node-routing-prefs"]).toBe(expectedValue);
	await page.reload({ waitUntil: "domcontentloaded" });
	const reloaded = await openNodeRouting(page, "?seed=existing");
	await expect(reloaded.fallback).toHaveValue("anthropic, openrouter");
	await expect
		.poll(async () => JSON.parse(await reloaded.patterns.inputValue()))
		.toEqual(EXPECTED_ROUTING.firewall.custom_patterns);
	await expect(
		reloaded.dialog.getByRole("heading", { name: "Network", exact: true })
	).toBeVisible();
	await saveScreenshot(page, "desktop-node-routing-saved.png");
});

test("retains the draft after a Core write failure and saves it on retry", async ({
	page,
}) => {
	const { fallback, patterns, save } = await openNodeRouting(
		page,
		"?seed=existing"
	);
	const initialValue = JSON.stringify(SEEDED_ROUTING);
	await fallback.fill("  cloudflare, anthropic  ");
	await patterns.fill(JSON.stringify(VALID_RULES));
	await page.evaluate(() => {
		/* SAFETY: node-routing-settings-proof.tsx installs __nodeRoutingSettingsProof before this proof page is evaluated. */ (
			window as NodeRoutingProofWindow
		).__nodeRoutingSettingsProof.armNextSaveFailure();
	});
	await save.click();
	await expect(
		page.getByText("Failed to save routing preferences", { exact: true })
	).toBeVisible();
	await expect(save).toBeEnabled();
	await expect(fallback).toHaveValue("  cloudflare, anthropic  ");
	await expect(patterns).toHaveValue(JSON.stringify(VALID_RULES));

	const failed = await readSnapshot(page);
	expect(failed.failedSaves).toBe(1);
	expect(failed.preferences["node-routing-prefs"]).toBe(initialValue);
	const expectedRetryValue = JSON.stringify({
		fallback: ["cloudflare", "anthropic"],
		firewall: {
			custom_patterns: [
				{ kind: "secret", name: "internal_id", regex: "^X-Internal-Id$" },
			],
		},
	});
	expect(routingCalls(failed).filter((call) => call.method === "PUT")).toEqual([
		{
			authorization: `Bearer ${NODE_TOKEN}`,
			body: { value: expectedRetryValue },
			method: "PUT",
			path: ROUTING_PATH,
		},
	]);
	await saveScreenshot(page, "desktop-node-routing-save-error.png");

	await save.click();
	await expect(
		page.getByText("Routing preferences saved", { exact: true })
	).toBeVisible();
	const retried = await readSnapshot(page);
	expect(retried.failedSaves).toBe(1);
	expect(retried.preferences["node-routing-prefs"]).toBe(expectedRetryValue);
	expect(routingCalls(retried).filter((call) => call.method === "PUT")).toEqual(
		[
			{
				authorization: `Bearer ${NODE_TOKEN}`,
				body: { value: expectedRetryValue },
				method: "PUT",
				path: ROUTING_PATH,
			},
			{
				authorization: `Bearer ${NODE_TOKEN}`,
				body: { value: expectedRetryValue },
				method: "PUT",
				path: ROUTING_PATH,
			},
		]
	);

	const reloaded = await openNodeRouting(page, "?seed=existing");
	await expect(reloaded.fallback).toHaveValue("cloudflare, anthropic");
	await expect
		.poll(async () => JSON.parse(await reloaded.patterns.inputValue()))
		.toEqual(EXPECTED_ROUTING.firewall.custom_patterns);
});

declare global {
	interface Window {
		__nodeRoutingSettingsProof: NodeRoutingProofWindow["__nodeRoutingSettingsProof"];
	}
}
