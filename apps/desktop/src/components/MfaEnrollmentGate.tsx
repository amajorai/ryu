import type { RyuFetch } from "@ryuhq/core-client/client.ts";
import { mfaEnrollmentSetupUrl } from "@ryuhq/core-client/mfa-enrollment.ts";
import type { ComponentType, ReactNode } from "react";
import { BACKEND_URL, WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useMfaEnrollmentAccess } from "../hooks/useMfaEnrollmentAccess.ts";
import {
	readMfaEnrollmentClear,
	resolveMfaEnrollmentSurface,
} from "../lib/mfa-enrollment-gate.ts";
import MfaEnrollmentPage from "../pages/MfaEnrollmentPage.tsx";

function Unframed({ children }: { children: ReactNode }) {
	return children;
}

export interface MfaEnrollmentGateProps {
	accountEmail?: string | null;
	/** The signed-in account; a different one reads the status afresh. */
	accountId: string | null;
	/** The app, shown when the account is clear or the status is unknown. */
	children: ReactNode;
	/** Control-plane origin. */
	controlPlaneUrl?: string;
	/** True only for a signed-in, non-anonymous account the waitlist let in. */
	enabled: boolean;
	/** Injected by tests; the global `fetch` otherwise. */
	fetch?: RyuFetch;
	/** The shell frame the enrollment screen sits in (`PageWrapper`). */
	frame?: ComponentType<{ children: ReactNode }>;
	/** Shown while an account with no earlier `clear` waits on its first read. */
	loading: ReactNode;
	/** Opens a URL in the system browser. */
	openUrl?: (url: string) => Promise<void> | void;
	/** The control-plane bearer, when the shell holds one. */
	token: string | null;
	/** Website origin that serves `/settings/setup-2fa`. */
	webOrigin?: string;
}

/**
 * Second-factor gate between the waitlist and the app.
 *
 * Mounted where the app would render, so it only runs for an account the
 * waitlist already let in. An account with neither an authenticator app nor a
 * passkey gets the enrollment screen; `clear` and `unknown` get the app, and
 * nothing here ever signs anyone out or touches stored tokens.
 */
export function MfaEnrollmentGate({
	accountEmail,
	accountId,
	children,
	controlPlaneUrl = BACKEND_URL,
	enabled,
	fetch,
	frame: Frame = Unframed,
	loading,
	openUrl = openExternal,
	token,
	webOrigin = WEB_URL,
}: MfaEnrollmentGateProps) {
	const { access, recheck } = useMfaEnrollmentAccess({
		accountId,
		enabled,
		fetch,
		token,
		url: controlPlaneUrl,
	});
	const surface = resolveMfaEnrollmentSurface({
		access,
		cachedClear: readMfaEnrollmentClear(accountId),
		enabled,
	});
	if (surface === "loading") {
		return loading;
	}
	if (surface === "enroll") {
		return (
			<Frame>
				<MfaEnrollmentPage
					accountEmail={accountEmail}
					onCheckAgain={recheck}
					// The shell has no back button, so the website must never open
					// inside the app window.
					onOpenSetup={() => openUrl(mfaEnrollmentSetupUrl(webOrigin))}
				/>
			</Frame>
		);
	}
	return children;
}
