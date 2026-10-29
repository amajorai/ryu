/* @jsxImportSource @opentui/react */

import { useKeyboard, useRenderer } from "@opentui/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { AUTH_BACKEND_URL } from "../core/authBackend.ts";
import { useCore } from "../core/CoreContext.tsx";
import { herdrReporter } from "../core/herdr.ts";
import {
	getCliIdentitySnapshot,
	subscribeCliIdentity,
} from "../core/identity.ts";
import {
	MFA_ENROLLMENT_REASON,
	MFA_ENROLLMENT_SETUP_URL,
	MFA_ENROLLMENT_TITLE,
} from "../core/mfaEnrollment.ts";
import { openBrowser } from "../core/openBrowser.ts";
import {
	CLI_GATE_DEADLINES,
	CLI_GATE_POLL_MS,
	type CliGateAccess,
	type CliGateDeadlines,
	FRONTEND_URL,
	resolveCliGateAccess,
} from "../core/waitlist.ts";
import { tf } from "../i18n/translate.ts";

type GateState = "loading" | CliGateAccess;

/** Bumps when the signed-in account may have changed (sign-in, switch,
 * sign-out), not on the identity source's keep-fresh retries. */
function accountGeneration(): number {
	return getCliIdentitySnapshot().accountGeneration;
}

function GateContent({
	state,
}: {
	state: Exclude<GateState, "loading" | "approved" | "mfa_enrollment_required">;
}) {
	const theme = useTheme();
	const pending = state === "pending";
	const unauthenticated = state === "unauthenticated";
	return (
		<box
			alignItems="center"
			flexDirection="column"
			flexGrow={1}
			gap={1}
			justifyContent="center"
			padding={2}
		>
			<box border borderStyle="rounded" padding={2} width={64}>
				<text fg={theme.colors.primary}>
					<strong>
						{unauthenticated
							? "Sign in to Ryu"
							: pending
								? "You're on the waitlist"
								: "Access check unavailable"}
					</strong>
				</text>
				<text fg={theme.colors.foreground} marginTop={1}>
					{unauthenticated
						? "Run `ryu-cli login`, then restart the TUI."
						: pending
							? tf(
									"Your account is queued. Apply or check your status at {waitlistUrl}.",
									{
										waitlistUrl: `${FRONTEND_URL.replace(/\/+$/, "")}/waitlist`,
									}
								)
							: tf(
									"Ryu could not verify access from {authBackendUrl}. Press r to retry.",
									{ authBackendUrl: AUTH_BACKEND_URL }
								)}
				</text>
				<text fg={theme.colors.mutedForeground} marginTop={1}>
					{unauthenticated
						? "The workspace is locked until an account is signed in."
						: "The workspace stays locked until the control plane says approved."}
				</text>
			</box>
			<text fg={theme.colors.mutedForeground}>r retry · Ctrl+C quit</text>
		</box>
	);
}

/** The account must add a passkey or an authenticator app on the website. */
function MfaEnrollmentContent({ checking }: { checking: boolean }) {
	const theme = useTheme();
	const [opened, setOpened] = useState(false);
	useKeyboard((key) => {
		if (key.name === "return") {
			openBrowser(MFA_ENROLLMENT_SETUP_URL);
			setOpened(true);
		}
	});
	return (
		<box
			alignItems="center"
			flexDirection="column"
			flexGrow={1}
			gap={1}
			justifyContent="center"
			padding={2}
		>
			<box border borderStyle="rounded" padding={2} width={64}>
				<text fg={theme.colors.primary}>
					<strong>{MFA_ENROLLMENT_TITLE}</strong>
				</text>
				<text fg={theme.colors.foreground} marginTop={1}>
					{MFA_ENROLLMENT_REASON}
				</text>
				<text fg={theme.colors.foreground} marginTop={1}>
					Add one on the Ryu website:
				</text>
				<text fg={theme.colors.foreground}>{MFA_ENROLLMENT_SETUP_URL}</text>
				<text fg={theme.colors.mutedForeground} marginTop={1}>
					{opened
						? "Finish in your browser, then press r. If nothing opened, copy the link above."
						: "The workspace stays locked until the account has a second factor."}
				</text>
				<text fg={theme.colors.mutedForeground} marginTop={1}>
					Wrong account? Quit, run `ryu-cli logout`, then `ryu-cli login`.
				</text>
			</box>
			<text fg={theme.colors.mutedForeground}>
				{checking
					? "Checking two-factor status…"
					: "Enter open in browser · r check again · Ctrl+C quit"}
			</text>
		</box>
	);
}

/** Gate the whole TUI before any workspace tab or Core-backed view mounts. */
export function WaitlistGate({
	children,
	deadlines = CLI_GATE_DEADLINES,
}: {
	children: ReactNode;
	/** Per-phase check deadlines; tests shorten them. */
	deadlines?: Readonly<CliGateDeadlines>;
}) {
	const renderer = useRenderer();
	const theme = useTheme();
	const { target } = useCore();
	const account = useSyncExternalStore(
		subscribeCliIdentity,
		accountGeneration,
		accountGeneration
	);
	const { accessMs, enrollmentMs } = deadlines;
	const [state, setState] = useState<GateState>("loading");
	const [retry, setRetry] = useState(0);
	const [checking, setChecking] = useState(false);
	// The newest check owns the result; a superseded or unmounted one is aborted
	// and never touches state.
	const inFlight = useRef<AbortController | null>(null);

	const check = useCallback(async () => {
		inFlight.current?.abort();
		const controller = new AbortController();
		inFlight.current = controller;
		// The workspace and the enrollment screen stay up while a check runs.
		setState((current) =>
			current === "approved" || current === "mfa_enrollment_required"
				? current
				: "loading"
		);
		// Only a newer check or unmount aborts this one. A waitlist phase that runs
		// out of time is inconclusive and keeps the current screen; an enrollment
		// read that runs out of time comes back approved.
		const access = await resolveCliGateAccess(target, controller.signal, {
			accessMs,
			enrollmentMs,
		});
		if (inFlight.current !== controller) {
			return;
		}
		inFlight.current = null;
		setChecking(false);
		if (access !== "timed_out") {
			setState(access);
		}
	}, [accessMs, enrollmentMs, target]);

	// `account` and `retry` only re-run the check: a new signed-in account, or r.
	useEffect(() => {
		void check();
		const interval = setInterval(() => void check(), CLI_GATE_POLL_MS);
		return () => {
			clearInterval(interval);
			inFlight.current?.abort();
			inFlight.current = null;
		};
	}, [account, check, retry]);

	// Unit and shell tests exercise the workspace in isolation with no control-plane
	// server. The production entry point never sets NODE_ENV=test, so the real CLI
	// always takes the server-authoritative path.
	const passThrough = process.env.NODE_ENV === "test" || state === "approved";

	useKeyboard((key) => {
		// Once the workspace is showing, the shell owns Ctrl+C (copy selection,
		// interrupt, then a two-press quit). While the gate blocks, one press quits.
		if (passThrough) {
			return;
		}
		if (key.ctrl && key.name === "c") {
			renderer.setTerminalTitle("");
			if (herdrReporter) {
				void herdrReporter.release().finally(() => renderer.destroy());
			} else {
				renderer.destroy();
			}
			return;
		}
		if (key.name === "r") {
			setChecking(true);
			setRetry((value) => value + 1);
		}
	});

	if (passThrough) {
		return <>{children}</>;
	}
	if (state === "loading") {
		return (
			<box alignItems="center" flexGrow={1} justifyContent="center">
				<text fg={theme.colors.mutedForeground}>Checking account access…</text>
			</box>
		);
	}
	if (state === "mfa_enrollment_required") {
		return <MfaEnrollmentContent checking={checking} />;
	}
	return <GateContent state={state} />;
}
