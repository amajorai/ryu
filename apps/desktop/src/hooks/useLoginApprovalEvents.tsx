import {
	approveLoginApproval,
	denyLoginApproval,
	LOGIN_APPROVAL_STABLE_CONNECTION_MS,
	type LoginApprovalRequest,
	listLoginApprovals,
	loginApprovalRetryDelay,
	streamLoginApprovals,
} from "@ryu/auth/lib/login-approval-client";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
	BACKEND_URL,
	getActiveToken,
	getActiveUserId,
	useSession,
} from "@/lib/auth-client.ts";
import { abortableDelay } from "@/src/lib/abortable-delay.ts";

// The approval prompt (with its QR code renderer) loads when a request arrives.
const LoginApprovalPrompt = lazy(() =>
	import("@ryu/blocks/web/login-approval.tsx").then((module) => ({
		default: module.LoginApprovalPrompt,
	}))
);

function activeToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		return null;
	}
}

function withoutRequest(
	requests: LoginApprovalRequest[],
	requestId: string
): LoginApprovalRequest[] {
	return requests.filter((request) => request.id !== requestId);
}

/**
 * Account-level approval listener for Desktop and the browser extension.
 *
 * This intentionally targets the Better Auth control plane, not the active
 * Core node: an account can approve a sign-in while Core is stopped or absent.
 */
export function LoginApprovalEvents() {
	const { data: session } = useSession();
	const userId = session?.user?.id ?? getActiveUserId();
	// Pending requests in arrival order, minus the ones handled or dismissed here.
	// The prompt shows the head; resolving, dismissing or expiring it advances
	// to the next, so a second sign-in started meanwhile is not lost.
	const [pending, setPending] = useState<LoginApprovalRequest[]>([]);
	const activeRequest = pending[0] ?? null;
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dismissed = useRef(new Set<string>());

	useEffect(() => {
		if (!userId) {
			setPending([]);
			return;
		}

		let cancelled = false;
		const controller = new AbortController();

		const addRequest = (request: LoginApprovalRequest) => {
			if (cancelled || dismissed.current.has(request.id)) {
				return;
			}
			setPending((current) =>
				current.some((entry) => entry.id === request.id)
					? current
					: [...current, request]
			);
		};

		const removeRequest = (requestId: string) => {
			dismissed.current.delete(requestId);
			setPending((current) => withoutRequest(current, requestId));
		};

		const run = async () => {
			let attempt = 0;
			while (!cancelled) {
				const connectedAt = Date.now();
				let lastError: unknown = null;
				// Read per connection: signing in again as the same user writes a
				// new token without changing `userId`, so a captured one goes stale.
				const auth = { token: activeToken() };
				try {
					const snapshot = await listLoginApprovals(
						BACKEND_URL,
						auth,
						controller.signal
					);
					if (!cancelled) {
						// Forget dismissals of requests that are no longer pending.
						for (const id of dismissed.current) {
							if (!snapshot.some((request) => request.id === id)) {
								dismissed.current.delete(id);
							}
						}
						const fresh = snapshot.filter(
							(request) => !dismissed.current.has(request.id)
						);
						// Keep the prompt already on screen at the head.
						setPending((current) => {
							const head = current[0];
							const shown = head && fresh.find((entry) => entry.id === head.id);
							return shown
								? [shown, ...withoutRequest(fresh, shown.id)]
								: fresh;
						});
					}
					if (cancelled) {
						break;
					}
					await streamLoginApprovals(
						BACKEND_URL,
						auth,
						(event) => {
							if (event.type === "created") {
								addRequest(event.request);
							} else {
								removeRequest(event.requestId);
							}
						},
						controller.signal
					);
				} catch (error) {
					// Auth service/network recovery is best-effort; the next connection
					// receives a durable pending snapshot before live events resume.
					lastError = error;
				}
				if (cancelled) {
					break;
				}
				if (Date.now() - connectedAt >= LOGIN_APPROVAL_STABLE_CONNECTION_MS) {
					attempt = 0;
				}
				// Jittered backoff, so every client dropped by the same outage does
				// not return as one wave; a refused session (401/403) waits minutes.
				const delay = loginApprovalRetryDelay(attempt, lastError);
				attempt += 1;
				await abortableDelay(delay, controller.signal);
			}
		};
		run().catch(() => undefined);

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [userId]);

	useEffect(() => {
		if (!activeRequest) {
			return;
		}
		const expiresAt = Date.parse(activeRequest.expiresAt);
		if (!Number.isFinite(expiresAt)) {
			return;
		}
		const timer = setTimeout(
			() => {
				setPending((current) => withoutRequest(current, activeRequest.id));
			},
			Math.max(0, expiresAt - Date.now())
		);
		return () => clearTimeout(timer);
	}, [activeRequest]);

	const dismiss = (requestId: string) => {
		dismissed.current.add(requestId);
		setPending((current) => withoutRequest(current, requestId));
	};

	const resolve = async (action: "approve" | "deny") => {
		if (!activeRequest || approving) {
			return;
		}
		setApproving(true);
		setError(null);
		try {
			const resolveRequest =
				action === "approve" ? approveLoginApproval : denyLoginApproval;
			await resolveRequest(BACKEND_URL, activeRequest.id, {
				token: activeToken(),
			});
			dismiss(activeRequest.id);
		} catch (resolveError) {
			setError(
				resolveError instanceof Error
					? resolveError.message
					: "Could not handle this sign-in request"
			);
		} finally {
			setApproving(false);
		}
	};

	if (!activeRequest) {
		return null;
	}
	return (
		<Suspense fallback={null}>
			<LoginApprovalPrompt
				approving={approving}
				error={error}
				onApprove={() => resolve("approve")}
				onDeny={() => resolve("deny")}
				onOpenChange={(open) => {
					if (!(open || approving)) {
						dismiss(activeRequest.id);
					}
				}}
				open
				request={activeRequest}
			/>
		</Suspense>
	);
}
