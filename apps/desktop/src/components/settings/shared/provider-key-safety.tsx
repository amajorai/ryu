import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";

/** Public explanation of how provider keys are stored and what that protects against. */
export const PROVIDER_KEY_DOCS_PATH = "/docs/security/provider-api-keys";

/**
 * Billing pages where a provider lets the account owner cap spend. Only
 * providers whose limit page is a stable, documented URL are listed; every
 * other provider falls back to the docs page.
 */
const SPEND_LIMIT_URLS: Readonly<Record<string, string>> = {
	anthropic: "https://console.anthropic.com/settings/limits",
	openai: "https://platform.openai.com/settings/organization/limits",
	openrouter: "https://openrouter.ai/settings/keys",
};

export function providerSpendLimitUrl(providerId: string): string | undefined {
	return SPEND_LIMIT_URLS[providerId.toLowerCase()];
}

function openLink(url: string) {
	Promise.resolve(openExternal(url)).catch(() => undefined);
}

function DocsLink() {
	return (
		<button
			className="underline underline-offset-4"
			onClick={() => openLink(`${FRONTEND_URL}${PROVIDER_KEY_DOCS_PATH}`)}
			type="button"
		>
			How Ryu stores your keys
		</button>
	);
}

/**
 * Where the keys entered below end up. `vault` is Core's encrypted provider
 * vault; `gateway` is the Gateway's owner-only configuration file, whose
 * credential values are sealed with a Gateway key derived from the master key.
 * The copy must stay true to the storage it describes.
 */
export type ProviderKeyStorage = "vault" | "gateway";

const STORAGE_COPY: Record<ProviderKeyStorage, string> = {
	vault:
		"Ryu encrypts saved keys on disk (ChaCha20-Poly1305, with the master key held in your OS keychain) and hands them to the agent runtime only in memory when it starts. Programs running as you can still reach them, so a spending limit is your main protection.",
	gateway:
		"Ryu encrypts Gateway keys inside its owner-only configuration file (ChaCha20-Poly1305, with a Gateway key derived from the master key held in your OS keychain). Programs running as you can still reach them, so a spending limit is your main protection.",
};

export function ProviderKeySafetyNotice({
	storage,
}: {
	storage: ProviderKeyStorage;
}) {
	return (
		<Alert variant="warning">
			<HugeiconsIcon icon={Alert02Icon} />
			<AlertTitle>Set a spending limit on every provider key</AlertTitle>
			<AlertDescription className="space-y-1.5">
				<p>
					A leaked key can run up charges until you revoke it, whether it leaks
					from this device or from any other app or service that holds it.
					Before you paste a key, set a hard monthly limit in the provider's
					billing settings, and create a key just for Ryu so you can revoke it
					on its own.
				</p>
				<p>{STORAGE_COPY[storage]}</p>
				<p>
					<DocsLink />
				</p>
			</AlertDescription>
		</Alert>
	);
}

/**
 * Required confirmation before a provider key is saved. Callers keep the
 * checked state, block their save action until it is true, and reset it after
 * each successful save so every new key is confirmed on its own.
 */
export function SpendLimitConfirm({
	id,
	providerId,
	providerLabel,
	checked,
	onCheckedChange,
	disabled = false,
}: {
	id: string;
	providerId: string;
	providerLabel: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
}) {
	const tl = useLiteralMessages();
	const limitUrl = providerSpendLimitUrl(providerId);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
			<span className="flex items-center gap-2">
				<Checkbox
					checked={checked}
					disabled={disabled}
					id={id}
					onCheckedChange={(next) => onCheckedChange(next === true)}
				/>
				<label className="cursor-pointer text-muted-foreground" htmlFor={id}>
					{tl("I have set a spending limit for this key at {providerLabel}", {
						providerLabel,
					})}
				</label>
			</span>
			{limitUrl ? (
				<button
					className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
					onClick={() => openLink(limitUrl)}
					type="button"
				>
					{tl("Open {providerLabel} limits", { providerLabel })}
				</button>
			) : null}
		</div>
	);
}
