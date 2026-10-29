import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const base =
	"/gateway-dialog-shell-proof.html?runtimeProof=true&gatewayDown=true&freezeStatusPoll=true";
async function waitForGateway(page: Page) {
	await expect(
		page.getByRole("button", { name: "Overview", exact: true })
	).toBeVisible({ timeout: 120_000 });
}
interface Call {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}
async function calls(page: Page): Promise<Call[]> {
	return page.evaluate(
		() =>
			/* SAFETY: gateway-dialog-shell-proof.tsx installs __gatewayDialogShellProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayDialogShellProof: { snapshot: () => { calls: Call[] } };
				}
			).__gatewayDialogShellProof.snapshot().calls
	);
}
async function fail(page: Page, path: string, method: string) {
	await page.evaluate(
		({ path, method }) =>
			/* SAFETY: gateway-dialog-shell-proof.tsx installs __gatewayDialogShellProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayDialogShellProof: {
						armRuntimeFailure: (path: string, method: string) => void;
					};
				}
			).__gatewayDialogShellProof.armRuntimeFailure(path, method),
		{ path, method }
	);
}
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceOverride = process.env.RYU_PROOF_EVIDENCE_DIR;
const evidence = (name: string) =>
	evidenceOverride
		? `${evidenceOverride}/${name}.png`
		: fileURLToPath(
				new URL(
					`../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/${name}.png`,
					import.meta.url
				)
			);
test.use({ viewport: { width: 1440, height: 1100 } });
test.setTimeout(180_000);

test("reachable auto-retry controls save ordered candidates, failed writes retry, and reload reads persisted policy", async ({
	page,
}) => {
	await page.goto(`${base}&reset=true&section=routing`);
	await waitForGateway(page);
	const enabled = page.getByRole("switch", {
		name: "Retry on another subscription",
	});
	await expect(enabled).toBeVisible({ timeout: 120_000 });
	await enabled.click();
	await expect(enabled).toBeChecked();
	const notify = page.getByRole("switch", {
		name: "Just tell me — don't retry",
	});
	await notify.click();
	await expect(notify).toBeChecked();
	await page.getByRole("button", { name: "Codex", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "1. Codex", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "Claude", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "2. Claude", exact: true })
	).toBeVisible();
	await expect(page.locator("button[aria-pressed]")).toHaveText([
		"1. Codex",
		"2. Claude",
	]);
	await expect(
		page.getByRole("button", { name: "Grok", exact: true })
	).toHaveCount(0);
	const slider = page.getByRole("slider");
	await slider.focus();
	await slider.press("ArrowRight");
	await expect(slider).toHaveAttribute("aria-valuenow", "3");
	await fail(page, "/api/routing/retry-policy", "PUT");
	await notify.click();
	await expect(
		page.getByText("Could not save auto-retry settings", { exact: true })
	).toBeVisible();
	await expect(notify).toBeChecked();
	await notify.click();
	await expect(notify).not.toBeChecked();
	const writes = (await calls(page)).filter(
		(call) => call.method === "PUT" && call.path === "/api/routing/retry-policy"
	);
	expect(writes).toHaveLength(7);
	expect(writes[0]).toEqual({
		method: "PUT",
		path: "/api/routing/retry-policy",
		authorization: "Bearer gateway-dialog-shell-proof-token",
		body: {
			enabled: true,
			notify_only: false,
			candidates: [],
			spent_below_percent: 2,
		},
	});
	expect(writes[5]).toEqual(writes[6]);
	expect(writes[6].body).toEqual({
		enabled: true,
		notify_only: false,
		candidates: ["acp:codex", "acp:claude"],
		spent_below_percent: 3,
	});
	await page.reload();
	await waitForGateway(page);
	await expect(enabled).toBeChecked();
	await expect(notify).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: "1. Codex", exact: true })
	).toBeVisible();
	await expect(slider).toHaveAttribute("aria-valuenow", "3");
	await page
		.getByRole("heading", { name: "Auto-retry on another plan", exact: true })
		.locator("..")
		.locator("..")
		.screenshot({ path: evidence("auto-retry-persisted") });
});

test("ACP runtime controls persist exact bounded settings and retry a failed save", async ({
	page,
}) => {
	await page.goto(`${base}&reset=true&section=runtime`);
	await waitForGateway(page);
	const idle = page.getByRole("spinbutton", {
		name: "ACP idle timeout in minutes",
	});
	await expect(idle).toHaveValue("10");
	await idle.fill("15");
	await idle.press("Enter");
	await expect
		.poll(
			async () =>
				(await calls(page)).filter(
					(call) => call.method === "PUT" && call.path === "/api/gateway/config"
				).length
		)
		.toBe(1);
	const parallel = page.getByRole("combobox", {
		name: "Maximum parallel ACP agents",
	});
	await parallel.click();
	await page.getByRole("option", { name: "4", exact: true }).click();
	await expect(
		page.getByText("1 active / 4 allowed", { exact: true })
	).toBeVisible();
	const awake = page.getByRole("switch", {
		name: "Keep this device awake while agents run",
	});
	await fail(page, "/api/gateway/config", "PUT");
	await awake.click();
	await expect(
		page.getByText("Could not save ACP runtime settings", { exact: true })
	).toBeVisible();
	await expect(awake).toBeChecked();
	await awake.click();
	await expect(awake).not.toBeChecked();
	const writes = (await calls(page)).filter(
		(call) => call.method === "PUT" && call.path === "/api/gateway/config"
	);
	expect(writes).toHaveLength(4);
	expect(writes[2]).toEqual(writes[3]);
	expect(writes[3]).toEqual({
		method: "PUT",
		path: "/api/gateway/config",
		authorization: "Bearer gateway-dialog-shell-proof-token",
		body: {
			acp: {
				idle_timeout_minutes: 15,
				max_parallel_agents: 4,
				keep_computer_awake: false,
			},
		},
	});
	await page.reload();
	await waitForGateway(page);
	await expect(idle).toHaveValue("15");
	await expect(awake).not.toBeChecked();
	await expect(parallel).toContainText("4");
	await page
		.locator('[data-slot="dialog-content"]')
		.first()
		.screenshot({ path: evidence("acp-runtime-persisted") });
});

test("failed initial policy reads cannot overwrite defaults and recover through visible retry", async ({
	page,
}) => {
	await page.goto(`${base}&reset=true&section=overview`);
	await waitForGateway(page);
	await expect(
		page.getByRole("heading", { name: "Overview", exact: true })
	).toBeVisible();
	await fail(page, "/api/routing/retry-policy", "GET");
	await page
		.getByRole("button", { name: "Model routing", exact: true })
		.click();
	await expect(
		page.getByText("Could not load auto-retry settings.", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("switch", {
			name: "Retry on another subscription",
		})
	).toBeDisabled();
	expect(
		(await calls(page)).filter(
			(call) =>
				call.method === "PUT" &&
				["/api/gateway/config", "/api/routing/retry-policy"].includes(call.path)
		)
	).toHaveLength(0);
	await page
		.getByRole("heading", { name: "Auto-retry on another plan", exact: true })
		.locator("..")
		.locator("..")
		.screenshot({ path: evidence("auto-retry-read-error") });
	await page
		.getByRole("button", { name: "Retry auto-retry settings", exact: true })
		.click();
	await expect(
		page.getByRole("switch", {
			name: "Retry on another subscription",
		})
	).toBeEnabled();
	await fail(page, "/api/gateway/config", "GET");
	await page
		.getByRole("button", { name: "Agent runtime", exact: true })
		.click();
	await expect(
		page.getByText("Could not load ACP runtime settings.", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("spinbutton", { name: "ACP idle timeout in minutes" })
	).toBeDisabled();
	await page
		.locator('[data-slot="dialog-content"]')
		.first()
		.screenshot({ path: evidence("acp-runtime-read-error") });
	await page
		.getByRole("button", { name: "Retry ACP runtime settings", exact: true })
		.click();
	await expect(
		page.getByRole("spinbutton", { name: "ACP idle timeout in minutes" })
	).toBeEnabled();
	expect(
		(await calls(page)).filter(
			(call) =>
				call.method === "PUT" &&
				["/api/gateway/config", "/api/routing/retry-policy"].includes(call.path)
		)
	).toHaveLength(0);
	await page
		.locator('[data-slot="dialog-content"]')
		.first()
		.screenshot({ path: evidence("runtime-read-recovered") });
});

test("workspace permission readback disables retry and ACP mutations", async ({
	page,
}) => {
	await page.goto(`${base}&reset=true&readOnly=true&section=routing`);
	await waitForGateway(page);
	await expect(
		page.getByRole("switch", {
			name: "Retry on another subscription",
		})
	).toBeDisabled();
	await expect
		.poll(
			async () =>
				(await calls(page)).filter(
					(call) => call.path === "/api/control-plane/me/permissions"
				).length
		)
		.toBeGreaterThan(0);
	await page
		.getByRole("button", { name: "Agent runtime", exact: true })
		.click();
	await expect(
		page.getByRole("spinbutton", { name: "ACP idle timeout in minutes" })
	).toBeDisabled();
	await expect(
		page.getByRole("combobox", { name: "Maximum parallel ACP agents" })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", {
			name: "Keep this device awake while agents run",
		})
	).toBeDisabled();
	expect(
		(await calls(page)).filter(
			(call) =>
				call.method === "PUT" &&
				["/api/gateway/config", "/api/routing/retry-policy"].includes(call.path)
		)
	).toHaveLength(0);
	await page
		.locator('[data-slot="dialog-content"]')
		.first()
		.screenshot({ path: evidence("runtime-read-only") });
});
