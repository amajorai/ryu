import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type SecurityKeyRequestsState,
	useSecurityKeyRequests,
} from "@/src/hooks/useSecurityKeyRequests.ts";
import {
	isPinRequired,
	isRetryableSecurityKeyError,
	type PendingSecurityKeyRequest,
	performSecurityKeyRequest,
	securityKeyAvailability,
	securityKeyErrorCode,
} from "@/src/lib/api/security-key.ts";
import {
	type SecurityKeyPhase,
	SecurityKeyPrompt,
} from "./SecurityKeyPrompt.tsx";
import {
	securityKeyErrorMessage,
	securityKeyPinMessage,
} from "./security-key-errors.ts";

/** Deny reason sent when the user says no (or closes the prompt). */
export const SECURITY_KEY_DENIED_BY_USER = "denied_by_user";

interface FlowProps {
	answer: SecurityKeyRequestsState["answer"];
	nodeName: string;
	request: PendingSecurityKeyRequest;
}

/**
 * One request from prompt to answer. The answer is sent exactly once: an
 * approval with the key's credential, or a denial (the user said no, closed
 * the prompt, or the key cannot answer this site). A native result that lands
 * after the user already denied is dropped.
 */
export function SecurityKeyRequestFlow({
	answer,
	nodeName,
	request,
}: FlowProps) {
	const tl = useLiteralMessages();
	const [phase, setPhase] = useState<SecurityKeyPhase>("confirm");
	const [message, setMessage] = useState<string | null>(null);
	const [availabilityProblem, setAvailabilityProblem] = useState<string | null>(
		null
	);
	const settled = useRef(false);
	// The code of the error that ended the request, sent as the deny reason.
	const failureCode = useRef<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		securityKeyAvailability()
			.then((availability) => {
				if (cancelled || availability.available) {
					return;
				}
				setAvailabilityProblem(
					availability.reason
						? tl("This device can't use a security key: {reason}", {
								reason: availability.reason,
							})
						: tl("This device can't use a security key.")
				);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [tl]);

	const settle = useCallback(
		(decision: Parameters<FlowProps["answer"]>[1]) => {
			if (settled.current) {
				return;
			}
			settled.current = true;
			// The request leaves the queue either way; a late 404/409 means Core
			// already stopped waiting, and the page has its answer.
			answer(request.id, decision).catch(() => undefined);
		},
		[answer, request.id]
	);

	const deny = useCallback(() => {
		settle({
			decision: "deny",
			reason: failureCode.current ?? SECURITY_KEY_DENIED_BY_USER,
		});
	}, [settle]);

	const run = useCallback(
		async (pin?: string) => {
			setPhase("touch");
			setMessage(null);
			try {
				const credential = await performSecurityKeyRequest(request, pin);
				if (settled.current) {
					return;
				}
				setPhase("sending");
				settle({ credential, decision: "approve" });
			} catch (error) {
				if (settled.current) {
					return;
				}
				if (isPinRequired(error)) {
					setPhase("pin");
					setMessage(securityKeyPinMessage(error, tl));
					return;
				}
				setMessage(securityKeyErrorMessage(error, tl));
				if (isRetryableSecurityKeyError(error)) {
					setPhase("retry");
					return;
				}
				failureCode.current = securityKeyErrorCode(error);
				setPhase("failed");
			}
		},
		[request, settle, tl]
	);

	return (
		<SecurityKeyPrompt
			availabilityProblem={availabilityProblem}
			message={message}
			nodeName={nodeName}
			onApprove={() => {
				run().catch(() => undefined);
			}}
			onDeny={deny}
			onSubmitPin={(pin) => {
				run(pin).catch(() => undefined);
			}}
			phase={phase}
			request={request}
		/>
	);
}

/**
 * Mounted once at the app shell. Shows the oldest security-key request from a
 * browser on the active node while this device's "Allow hardware security
 * key" setting is on; renders nothing otherwise.
 */
export function SecurityKeyRequests() {
	const { answer, nodeName, request } = useSecurityKeyRequests();
	if (!request) {
		return null;
	}
	return (
		<SecurityKeyRequestFlow
			answer={answer}
			key={request.id}
			nodeName={nodeName}
			request={request}
		/>
	);
}
