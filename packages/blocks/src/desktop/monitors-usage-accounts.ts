import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * A saved provider account offered by the reset-monitor account picker. The
 * label may be an email address: render it, never persist it into a monitor.
 */
export interface UsageAccountOption {
	accountId: string;
	active: boolean;
	label: string | null;
	needsReauth?: boolean;
}

/** Saved accounts keyed by provider id, for providers with per-account usage. */
export type UsageAccountsByProvider = Readonly<
	Record<string, readonly UsageAccountOption[]>
>;

/** Called when the editor's provider or watched account changes. An absent
 *  `accountId` means the provider's active account. */
export type UsageSelectionChange = (
	providerId: string | null,
	accountId?: string
) => void;

/** Explain an unavailable reading. No reason means Core has not read this
 *  account yet and chose not to wait on the provider. */
export function unavailableUsageMessage(
	reason: string | null | undefined,
	tl: LiteralMessage
): string {
	if (!reason) {
		return "Usage for this account has not been read yet. It updates within a minute.";
	}
	if (reason === "account_not_found") {
		return "This account is no longer saved for this provider.";
	}
	return tl("Usage is unavailable for this account ({reason}).", { reason });
}

export function accountOptionLabel(
	account: UsageAccountOption,
	tl: LiteralMessage
): string {
	const name = account.label ?? "Saved account";
	if (account.needsReauth) {
		return tl("{name} (sign in again)", { name });
	}
	return account.active ? `${name} (active)` : name;
}

/** Name the account a provider-reset monitor watches, resolved at render time
 *  so account labels are never stored in the monitor itself. */
export function watchedAccountLabel(
	accountId: string | null | undefined,
	accounts: readonly UsageAccountOption[]
): string {
	if (!accountId) {
		return "active account";
	}
	const account = accounts.find((option) => option.accountId === accountId);
	if (!account) {
		return "removed account";
	}
	return account.label ?? "saved account";
}
