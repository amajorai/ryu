import {
	approveLoginApproval,
	denyLoginApproval,
	type LoginApprovalRequest,
	listLoginApprovals,
	streamLoginApprovals,
} from "@ryu/auth/lib/login-approval-client";
import { LoginApprovalPrompt } from "@ryu/blocks/web/login-approval";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	BACKEND_URL,
	getActiveUserId,
	TOKEN_KEY,
	useSession,
} from "@/lib/auth-client.ts";

const RECONNECT_DELAY_MS = 2000;

function activeToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
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
	const token = useMemo(activeToken, [userId]);
	const [activeRequest, setActiveRequest] =
		useState<LoginApprovalRequest | null>(null);
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dismissed = useRef(new Set<string>());

	useEffect(() => {
		if (!userId) {
			setActiveRequest(null);
			return;
		}

		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const auth = { token };

		const addRequest = (request: LoginApprovalRequest) => {
			if (cancelled || dismissed.current.has(request.id)) {
				return;
			}
			setActiveRequest((current) => current ?? request);
		};

		const removeRequest = (requestId: string) => {
			setActiveRequest((current) =>
				current?.id === requestId ? null : current
			);
		};

		const run = async () => {
			while (!cancelled) {
				try {
					const snapshot = await listLoginApprovals(BACKEND_URL, auth);
					if (!cancelled) {
						setActiveRequest((current) =>
							current && snapshot.some((request) => request.id === current.id)
								? current
								: (snapshot.find(
										(request) => !dismissed.current.has(request.id)
									) ?? null)
						);
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
				} catch {
					// Auth service/network recovery is best-effort; the next connection
					// receives a durable pending snapshot before live events resume.
				}
				if (cancelled) {
					break;
				}
				await new Promise<void>((resolve) => {
					reconnectTimer = setTimeout(resolve, RECONNECT_DELAY_MS);
				});
			}
		};
		void run();

		return () => {
			cancelled = true;
			controller.abort();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
		};
	}, [token, userId]);

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
				setActiveRequest((current) =>
					current?.id === activeRequest.id ? null : current
				);
			},
			Math.max(0, expiresAt - Date.now())
		);
		return () => clearTimeout(timer);
	}, [activeRequest]);

	const resolve = async (action: "approve" | "deny") => {
		if (!activeRequest || approving) {
			return;
		}
		setApproving(true);
		setError(null);
		try {
			const resolveRequest =
				action === "approve" ? approveLoginApproval : denyLoginApproval;
			await resolveRequest(BACKEND_URL, activeRequest.id, { token });
			dismissed.current.add(activeRequest.id);
			setActiveRequest(null);
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
		<LoginApprovalPrompt
			approving={approving}
			error={error}
			onApprove={() => resolve("approve")}
			onDeny={() => resolve("deny")}
			onOpenChange={(open) => {
				if (!(open || approving)) {
					setActiveRequest(null);
				}
			}}
			open
			request={activeRequest}
		/>
	);
}
