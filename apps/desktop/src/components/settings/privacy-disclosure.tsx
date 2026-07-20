// apps/desktop/src/components/settings/privacy-disclosure.tsx
//
// The first-run privacy disclosure (P0 of
// docs/observability-analytics-support-access.md). The §6 posture requires us to
// "disclose at first run even when on" — anonymous, content-free product
// analytics and crash reports default ON, and that disclosure is what makes the
// opt-out legitimate. So this surfaces ONCE at app startup, app-level (mounted in
// the layout shell next to DeepLinkController), regardless of whether the user
// ever opens Settings → Privacy. It is gated on a local "acknowledged" flag
// (mirrors MemoryTab's localStorage pattern), so it shows once and never again
// and reaches existing installs too (not only new users via onboarding).
//
// NO data is collected in this unit — this is the consent/disclosure surface
// that ships BEFORE any collection, so collection can never precede consent.

import { Alert01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { useCallback, useEffect, useState } from "react";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

// Shared with PrivacySettings.tsx so the in-tab notice and this startup dialog
// use ONE acknowledgement flag: dismissing either never re-shows the other.
export const DISCLOSURE_ACK_KEY = "ryu:privacy-disclosure-ack";

// The transparency reference: the published privacy/telemetry page (#549). Shown
// in the first-run disclosure and reused by PrivacySettings, so both surfaces
// point at the same place. Opened in the browser (via openExternal) as a real,
// followable link rather than a dead file path.
export const PRIVACY_DOCS_PATH = "/docs/desktop/transparency";

/** True once the user has acknowledged the first-run privacy disclosure. */
export function isPrivacyDisclosureAcknowledged(): boolean {
	return localStorage.getItem(DISCLOSURE_ACK_KEY) === "true";
}

/** Persist the acknowledgement so the disclosure never surfaces again. */
export function acknowledgePrivacyDisclosure(): void {
	localStorage.setItem(DISCLOSURE_ACK_KEY, "true");
}

/**
 * A non-visual controller that pops the first-run privacy disclosure once.
 * Mounted app-level in the layout shell (like DeepLinkController) so it reaches
 * the user even if they never open Settings.
 */
export function PrivacyDisclosure() {
	const [open, setOpen] = useState(false);
	const openSettings = useSettingsDialog((s) => s.openSettings);

	useEffect(() => {
		if (!isPrivacyDisclosureAcknowledged()) {
			setOpen(true);
		}
	}, []);

	const dismiss = useCallback(() => {
		acknowledgePrivacyDisclosure();
		setOpen(false);
	}, []);

	const openPrivacySettings = useCallback(() => {
		acknowledgePrivacyDisclosure();
		setOpen(false);
		openSettings("privacy");
	}, [openSettings]);

	// Open the published privacy/data page in the browser so the reference is a
	// real, followable link rather than a dead file path.
	const openDocs = useCallback(() => {
		Promise.resolve(openExternal(`${FRONTEND_URL}${PRIVACY_DOCS_PATH}`)).catch(
			() => undefined
		);
	}, []);

	// Closing via the overlay/Esc still counts as acknowledged — the disclosure
	// has been shown, which is what the AC requires.
	const handleOpenChange = useCallback((next: boolean) => {
		if (!next) {
			acknowledgePrivacyDisclosure();
		}
		setOpen(next);
	}, []);

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<HugeiconsIcon className="size-4 opacity-70" icon={Alert01Icon} />
						How Ryu handles your data
					</DialogTitle>
					<DialogDescription className="text-left leading-relaxed">
						Ryu is local-first and encrypted by default. Anonymous, content-free
						product analytics and crash reports are on by default so we can fix
						what breaks and improve the app. They never include your prompts,
						conversations, files, or any agent content, and they use a random
						install ID that is not linked to your account. Everything Ryu runs
						on your device stays on your device unless you turn on diagnostics
						export. You can change any of this any time in Settings &rarr;
						Privacy.{" "}
						<button
							className="text-primary underline-offset-4 hover:underline"
							onClick={openDocs}
							type="button"
						>
							Read the full privacy &amp; data breakdown
						</button>
						.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button onClick={openPrivacySettings} variant="outline">
						Review privacy settings
					</Button>
					<Button onClick={dismiss}>Got it</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
