import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { fetchMfaEnrollmentAccess } from "@ryuhq/core-client/mfa-enrollment";
import {
	resolveNodeWaitlistAccess,
	type WaitlistAccess,
} from "@ryuhq/core-client/waitlist";
import {
	type CoreAuthStatusWire,
	coreAuthStatusWireSchema,
} from "./auth-status-wire.ts";
import { accountBackendTarget } from "./authBackend.ts";
import { frontendUrl } from "./controlPlane.ts";

/** The website origin for the pages the CLI links to (waitlist, 2FA setup). */
export const FRONTEND_URL = frontendUrl();

export type CliWaitlistAccess = WaitlistAccess;

/** What the root gate shows: a waitlist state, or second-factor enrollment. */
export type CliGateAccess = CliWaitlistAccess | "mfa_enrollment_required";

/** The control-plane account bearer Core holds for this node, if any. */
async function readAccountToken(
	coreTarget: ApiTarget,
	signal?: AbortSignal
): Promise<string | null> {
	let status: CoreAuthStatusWire | null = null;
	try {
		status = await request(
			coreTarget,
			"/api/auth/status",
			{
				signal,
			},
			coreAuthStatusWireSchema
		);
	} catch {
		// A node that cannot answer auth/status is not enough evidence to classify
		// it as managed. Its node bearer is not an account token.
	}
	return status?.token?.trim() || null;
}

async function accountWaitlistAccess(
	token: string,
	coreTarget: ApiTarget,
	signal?: AbortSignal
): Promise<CliWaitlistAccess> {
	const result = await resolveNodeWaitlistAccess(
		accountBackendTarget(token),
		coreTarget.url,
		signal
	);
	return result.scope === "bypassed" ? "approved" : result.access;
}

/** Apply the server-selected waitlist scope to the active Core node. */
export async function resolveCliWaitlistAccess(
	coreTarget: ApiTarget,
	signal?: AbortSignal
): Promise<CliWaitlistAccess> {
	const token = await readAccountToken(coreTarget, signal);
	if (!token) {
		return "approved";
	}
	return await accountWaitlistAccess(token, coreTarget, signal);
}

/**
 * How long each phase of a gate check may take. The waitlist phase fails
 * closed: past its deadline the check is inconclusive and the gate keeps what
 * it shows. The enrollment read fails open: past its deadline the status is
 * unknown and the account goes through. Together they stay under the gate's
 * poll interval, so a slow check finishes before the next one supersedes it.
 */
export interface CliGateDeadlines {
	accessMs: number;
	enrollmentMs: number;
}

/** How often the gate re-reads access while it is mounted. */
export const CLI_GATE_POLL_MS = 20_000;

export const CLI_GATE_DEADLINES: Readonly<CliGateDeadlines> = {
	accessMs: 10_000,
	enrollmentMs: 5000,
};

/** A gate decision, or `timed_out` when the waitlist phase hit its deadline. */
export type CliGateCheck = CliGateAccess | "timed_out";

/** Run `phase` until `parent` aborts or `ms` passes; report which ended it. */
async function withDeadline<T>(
	parent: AbortSignal | undefined,
	ms: number,
	phase: (signal: AbortSignal) => Promise<T>
): Promise<{ expired: boolean; value: T }> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), ms);
	try {
		const signal = parent
			? AbortSignal.any([parent, deadline.signal])
			: deadline.signal;
		const value = await phase(signal);
		return { expired: deadline.signal.aborted, value };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve what the TUI's root gate shows for the active Core node: the waitlist
 * decision, then, for a signed-in account the waitlist lets through, whether
 * the control plane still requires it to enroll a second factor. Signed-out
 * use never asks. An unreadable or slow enrollment status lets the account
 * through: the control plane still refuses each request, and the gate asks
 * again on its next check. A caller that aborts `signal` discards the result.
 */
export async function resolveCliGateAccess(
	coreTarget: ApiTarget,
	signal?: AbortSignal,
	deadlines: Readonly<CliGateDeadlines> = CLI_GATE_DEADLINES
): Promise<CliGateCheck> {
	const access = await withDeadline(
		signal,
		deadlines.accessMs,
		async (phaseSignal) => {
			const token = await readAccountToken(coreTarget, phaseSignal);
			if (!token) {
				return { access: "approved" as const, token: null };
			}
			return {
				access: await accountWaitlistAccess(token, coreTarget, phaseSignal),
				token,
			};
		}
	);
	if (access.expired) {
		return "timed_out";
	}
	const { token } = access.value;
	if (!token || access.value.access !== "approved" || signal?.aborted) {
		return access.value.access;
	}
	const enrollment = await withDeadline(
		signal,
		deadlines.enrollmentMs,
		(phaseSignal) =>
			fetchMfaEnrollmentAccess(accountBackendTarget(token), phaseSignal)
	);
	return enrollment.value === "required"
		? "mfa_enrollment_required"
		: "approved";
}
