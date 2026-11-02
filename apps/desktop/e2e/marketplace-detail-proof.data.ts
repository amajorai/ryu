import { expect, type Page } from "@playwright/test";
import {
	answerDesktopSecretSlot,
	answerEmptyLegacyAuthStore,
	LEGACY_VAULT_LOCAL_STORAGE_KEYS,
	memorySlotStorage,
	type SlotStorage,
} from "./harness/desktop-secret-slots.ts";

// Fixtures and helpers for marketplace-detail-proof.spec.ts, kept apart so each file stays under the token limit.

/**
 * The desktop's sealed `auth-vault` slot for a proof that switches accounts:
 * without a native slot the auth client keeps a switch in memory only, so it
 * cannot survive the reload the switch triggers. The slot record lives on the
 * Node side, so it survives every reload of the page. The bridge answers only
 * the slot commands, their change event and the (empty) legacy `auth.bin`
 * store; any other native call is refused as a missing desktop command.
 */
export async function installNativeVaultBridge(
	page: Page
): Promise<SlotStorage> {
	const slots = memorySlotStorage();
	await page.exposeBinding(
		"marketplaceDetailNative",
		(_source, command: string, args?: Record<string, unknown>) => {
			const slot = answerDesktopSecretSlot(slots, command, args ?? {});
			if (slot.handled) {
				return slot;
			}
			return answerEmptyLegacyAuthStore(command, args ?? {});
		}
	);
	await page.addInitScript(() => {
		const native = (
			window as unknown as {
				marketplaceDetailNative: (
					command: string,
					args?: Record<string, unknown>
				) => Promise<{ handled: boolean; value: unknown }>;
			}
		).marketplaceDetailNative;
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke: async (command: string, args?: Record<string, unknown>) => {
					const answer = await native(command, args);
					if (!answer.handled) {
						throw new Error(`Unhandled native command: ${command}`);
					}
					return answer.value;
				},
				transformCallback: () => 0,
				unregisterCallback: () => undefined,
			},
		});
	});
	return slots;
}

export async function plaintextVault(
	page: Page
): Promise<Array<string | null>> {
	return await page.evaluate(
		(keys) => keys.map((key) => localStorage.getItem(key)),
		[...LEGACY_VAULT_LOCAL_STORAGE_KEYS]
	);
}
export async function openLink(page: Page, name: string, expectedPath: string) {
	const popup = page.context().waitForEvent("page");
	await page
		.getByRole("link", { name, exact: true })
		.or(page.getByRole("button", { name, exact: true }))
		.or(page.getByRole("menuitem", { name, exact: true }))
		.first()
		.click();
	const opened = await popup;
	await expect(opened).toHaveURL(new RegExp(`${expectedPath}$`));
	await opened.close();
}
