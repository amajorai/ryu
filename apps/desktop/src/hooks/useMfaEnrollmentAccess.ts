import type { RyuFetch } from "@ryuhq/core-client/client.ts";
import {
	fetchMfaEnrollmentAccess,
	type MfaEnrollmentAccess,
} from "@ryuhq/core-client/mfa-enrollment.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	MFA_ENROLLMENT_CHECK_TIMEOUT_MS,
	MFA_ENROLLMENT_POLL_MS,
	rememberMfaEnrollmentAccess,
} from "../lib/mfa-enrollment-gate.ts";

export interface MfaEnrollmentAccessOptions {
	/** The signed-in account. A different account reads the status afresh. */
	accountId: string | null;
	/** False for anonymous and signed-out use: there is no account to enroll. */
	enabled: boolean;
	/** Injected by tests; the global `fetch` otherwise. */
	fetch?: RyuFetch;
	/** The control-plane bearer when the shell holds one. The webapp can be
	 *  cookie-only, which the status read also accepts. */
	token: string | null;
	/** Control-plane origin. */
	url: string;
}

export interface MfaEnrollmentAccessState {
	/** This account's latest answer, or null until its first read lands. */
	access: MfaEnrollmentAccess | null;
	/** Read the status now. Resolves with the answer, or null when the gate was
	 *  torn down or a newer read replaced this one. */
	recheck: () => Promise<MfaEnrollmentAccess | null>;
}

interface TaggedAccess {
	access: MfaEnrollmentAccess;
	identity: string;
}

/**
 * Whether the signed-in account still has to enroll a second factor.
 *
 * Reads on mount and whenever the account, token or control plane changes,
 * then every 20 seconds and on window focus until the answer is `clear`, so an
 * account that finishes setup in the browser gets the app back without a
 * restart. An `exempt` answer (for example a waitlisted account) keeps the
 * poll, because the mandate can start to apply once the account is approved. An in-flight read is aborted on teardown and when a newer read
 * starts, and nothing is written to state after either.
 */
export function useMfaEnrollmentAccess({
	accountId,
	enabled,
	fetch,
	token,
	url,
}: MfaEnrollmentAccessOptions): MfaEnrollmentAccessState {
	// Answers are tagged with the identity they were read for, so switching to
	// another account never shows it the previous account's answer.
	const identity = [url, accountId ?? "", token ?? ""].join("\u001f");
	const [latest, setLatest] = useState<TaggedAccess | null>(null);
	const checkRef = useRef<(() => Promise<MfaEnrollmentAccess | null>) | null>(
		null
	);

	useEffect(() => {
		if (!enabled) {
			checkRef.current = null;
			return;
		}
		let active = true;
		let controller: AbortController | null = null;
		let poll: ReturnType<typeof setInterval> | null = null;
		let last: MfaEnrollmentAccess | null = null;

		const stopPolling = () => {
			if (poll) {
				clearInterval(poll);
				poll = null;
			}
		};
		const check = async (): Promise<MfaEnrollmentAccess | null> => {
			controller?.abort();
			const current = new AbortController();
			controller = current;
			const timeout = setTimeout(
				() => current.abort(),
				MFA_ENROLLMENT_CHECK_TIMEOUT_MS
			);
			let access: MfaEnrollmentAccess;
			try {
				access = await fetchMfaEnrollmentAccess(
					{ fetch, token, url },
					current.signal
				);
			} finally {
				clearTimeout(timeout);
			}
			if (!active || controller !== current) {
				return null;
			}
			controller = null;
			last = access;
			rememberMfaEnrollmentAccess(accountId, access);
			setLatest({ access, identity });
			if (access === "clear") {
				// Enrolled. Like the waitlist gate after approval, stop asking; the
				// control plane still refuses requests if a factor is removed later.
				stopPolling();
			} else if (!poll) {
				poll = setInterval(() => void check(), MFA_ENROLLMENT_POLL_MS);
			}
			return access;
		};
		// Setup happens in the browser, so returning to the window is the moment
		// the answer is most likely to have changed.
		// Focus and visibilitychange both fire when the user comes back; one read
		// already in flight answers for both.
		const onReturn = () => {
			if (
				last !== "clear" &&
				controller === null &&
				document.visibilityState === "visible"
			) {
				void check();
			}
		};

		checkRef.current = check;
		void check();
		poll = setInterval(() => void check(), MFA_ENROLLMENT_POLL_MS);
		window.addEventListener("focus", onReturn);
		document.addEventListener("visibilitychange", onReturn);
		return () => {
			active = false;
			controller?.abort();
			stopPolling();
			window.removeEventListener("focus", onReturn);
			document.removeEventListener("visibilitychange", onReturn);
			if (checkRef.current === check) {
				checkRef.current = null;
			}
		};
	}, [accountId, enabled, fetch, identity, token, url]);

	const recheck = useCallback(
		async () => (await checkRef.current?.()) ?? null,
		[]
	);
	const access =
		enabled && latest?.identity === identity ? latest.access : null;
	return { access, recheck };
}
