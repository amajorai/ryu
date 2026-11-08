// Where a tapped notification leads. Core may attach a `link` (a desktop
// route) to a notification; the desktop opens only the routes listed here, so
// a notification can never steer the app to an arbitrary page or URL.

import { VAULT_TABS } from "@/src/pages/VaultPage.model.ts";
import { requestVaultFocus } from "../vault-focus.ts";

export interface NotificationLinkTarget {
	path: string;
	/** Runs before the tab opens, e.g. to pick the Vault tab and proposal. */
	prepare: () => void;
	title: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ORIGIN = "https://desktop.invalid";

function vaultLink(params: URLSearchParams): NotificationLinkTarget | null {
	const tab = params.get("tab") ?? "secrets";
	if (!VAULT_TABS.some((known) => known === tab)) {
		return null;
	}
	const proposal = params.get("proposal");
	if (proposal !== null && !ID_PATTERN.test(proposal)) {
		return null;
	}
	return {
		path: "/vault",
		title: "Vault",
		prepare: () => {
			requestVaultFocus({ tab, proposalId: proposal });
		},
	};
}

/** The allowlisted route a notification `link` names, or null. */
export function parseNotificationLink(
	link: string | null | undefined
): NotificationLinkTarget | null {
	if (!link?.startsWith("/") || link.startsWith("//")) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(link, ORIGIN);
	} catch {
		return null;
	}
	if (url.origin !== ORIGIN || url.hash) {
		return null;
	}
	if (url.pathname === "/vault") {
		return vaultLink(url.searchParams);
	}
	return null;
}

/** Open the route a notification links to. False when the link is not allowed. */
export function openNotificationLink(
	link: string | null | undefined,
	openTab: (path: string, opts?: { title?: string }) => void
): boolean {
	const target = parseNotificationLink(link);
	if (!target) {
		return false;
	}
	target.prepare();
	openTab(target.path, { title: target.title });
	return true;
}
