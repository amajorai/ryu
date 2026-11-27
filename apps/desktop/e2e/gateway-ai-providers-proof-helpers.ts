// Shared page helpers for the Gateway AI providers proofs
// (gateway-ai-providers-proof.spec.ts and gateway-ai-providers-signin-proof.spec.ts).
import { expect, test } from "@playwright/test";

export interface ProviderProofSnapshot {
	catalog: {
		agentModelOverrides?: Record<string, Record<string, boolean>>;
		providers: Array<{
			accounts?: Array<{
				accountId: string;
				active: boolean;
				gatewayActive?: boolean;
				label: string;
			}>;
			configured: boolean;
			custom: boolean;
			id: string;
			modelOverrides?: Record<string, boolean>;
			routing: string;
		}>;
	};
	config: {
		model: string | null;
		provider: string;
		providerRouting?: Record<string, string>;
		routing: string;
		thinkingLevel: string | null;
	};
	navigation: Array<{ open: boolean; section: string }>;
	preferences: Record<string, string>;
	requests: Array<{ body: unknown; method: string; path: string }>;
	settingsNavigation: Array<{ open: boolean; section: string }>;
	tauriCalls: Array<{ args?: unknown; command: string; failed: boolean }>;
}

// Screenshots are run output, not tracked proof: they go to this run's
// Playwright output directory so a rerun never rewrites committed evidence.
export const evidence = (name: string) => test.info().outputPath(name);

export async function readState(
	page: import("@playwright/test").Page
): Promise<ProviderProofSnapshot> {
	return await page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-ai-providers-proof.tsx installs __gatewayAiProvidersProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayAiProvidersProof: {
						snapshot: () => ProviderProofSnapshot;
					};
				}
			).__gatewayAiProvidersProof;
		return proof.snapshot();
	});
}

export async function armFailure(
	page: import("@playwright/test").Page,
	operation: string
): Promise<void> {
	await page.evaluate((value) => {
		/* SAFETY: gateway-ai-providers-proof.tsx installs __gatewayAiProvidersProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayAiProvidersProof: {
					armFailure: (name: string) => void;
					failNextExternalLaunch: () => void;
				};
			}
		).__gatewayAiProvidersProof.armFailure(value);
	}, operation);
}

export async function failNextExternalLaunch(
	page: import("@playwright/test").Page
): Promise<void> {
	await page.evaluate(() => {
		/* SAFETY: gateway-ai-providers-proof.tsx installs __gatewayAiProvidersProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayAiProvidersProof: {
					failNextExternalLaunch: () => void;
				};
			}
		).__gatewayAiProvidersProof.failNextExternalLaunch();
	});
}

/** The list row of one provider, found by the provider's exact name. */
export function providerRow(
	page: import("@playwright/test").Page,
	provider: string
) {
	return page
		.locator('[data-provider-page-row^="provider:"]')
		.filter({ has: page.getByText(provider, { exact: true }) });
}

/** The page that is open: a provider's or one of the shared ones. */
export function openPage(page: import("@playwright/test").Page) {
	return page.locator("[data-provider-page]");
}

/**
 * Open a provider's page from the list. The page takes focus on its title,
 * and the line under the title names the provider's api type.
 */
export async function openProvider(
	page: import("@playwright/test").Page,
	provider: string,
	api: string
): Promise<void> {
	await providerRow(page, provider).click();
	await expect(
		page.getByRole("heading", { name: provider, exact: true })
	).toBeFocused();
	await expect(page.locator("[data-provider-page-meta]")).toContainText(api);
}

/** Open a shared page of the list (media, agent models, custom provider…). */
export async function openListPage(
	page: import("@playwright/test").Page,
	rowId: string
): Promise<void> {
	await page.locator(`[data-provider-page-row="${rowId}"]`).click();
	await expect(openPage(page)).toBeVisible();
}

/** Back to the list. The row that opened the page has the focus again. */
export async function backToList(
	page: import("@playwright/test").Page
): Promise<void> {
	await page.getByRole("button", { name: "Back to AI providers" }).click();
	await expect(page.locator("[data-provider-list]")).toBeVisible();
}
