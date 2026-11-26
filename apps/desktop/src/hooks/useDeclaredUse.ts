import { useEffect, useState } from "react";
import type { NodeSetupKind } from "@/src/lib/api/onboarding-profile.ts";
import { announceLocalStorageChange } from "@/src/lib/same-document-storage-event.ts";

/** How the person says they use Ryu on this computer: their own declaration.
    It is never detected (no email-domain or usage guessing), never checked
    against a licence, and nothing in the app is blocked or limited by it.

    Seeded from the onboarding answer ("Personal use" or "Team or company use")
    and changeable in Settings → Billing → Desktop access. Kept per install, in
    localStorage, so a home computer and a work computer can differ. Reactive
    through the same localStorage + `storage`-event pattern as the other
    desktop preferences (see `useStartupBehavior`). */
export type DeclaredUse = "personal" | "work";

/** The storage key. Later work (for example a work-use notice) reads the
    declaration through {@link readDeclaredUse} or {@link useDeclaredUse}. */
export const DECLARED_USE_KEY = "ryu_declared_use";

/** The choices in the order Settings lists them. */
export const DECLARED_USE_VALUES: readonly DeclaredUse[] = ["personal", "work"];

function isDeclaredUse(value: string | null): value is DeclaredUse {
	return DECLARED_USE_VALUES.some((candidate) => candidate === value);
}

/** What the person answered, or `null` when they were never asked (an install
    that skipped node setup, or one from before the question was stored). */
export function readStoredDeclaredUse(): DeclaredUse | null {
	try {
		const stored = localStorage.getItem(DECLARED_USE_KEY);
		return isDeclaredUse(stored) ? stored : null;
	} catch {
		return null;
	}
}

/** The declared use. Someone who never answered is treated as a personal
    user (`personal`) and is not asked again. */
export function readDeclaredUse(): DeclaredUse {
	return readStoredDeclaredUse() ?? "personal";
}

/** Store the declaration and tell every {@link useDeclaredUse} consumer. */
export function setDeclaredUse(use: DeclaredUse): void {
	try {
		localStorage.setItem(DECLARED_USE_KEY, use);
	} catch {
		// Storage is unavailable: the choice lasts for this render only.
		return;
	}
	// Same-document listeners don't get the native `storage` event, so
	// broadcast one ourselves.
	announceLocalStorageChange(DECLARED_USE_KEY);
}

/** The declaration that matches an onboarding node-setup answer. */
export function declaredUseForSetupKind(kind: NodeSetupKind): DeclaredUse {
	return kind === "team" ? "work" : "personal";
}

/** Record the onboarding answer as the declared use. Called when the person
    submits the "How will you use this node?" step, so the newest answer wins. */
export function recordDeclaredUseFromSetup(kind: NodeSetupKind): void {
	setDeclaredUse(declaredUseForSetupKind(kind));
}

/** The declared use, re-read whenever it changes in this or another window. */
export function useDeclaredUse(): DeclaredUse {
	const [use, setUse] = useState<DeclaredUse>(readDeclaredUse);

	useEffect(() => {
		const handler = () => setUse(readDeclaredUse());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return use;
}
