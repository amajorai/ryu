import { useEffect, useRef } from "react";
import { playSound } from "./play-sound.ts";

/**
 * Knock once when a permission prompt appears. Re-renders of the same prompt
 * stay silent; a new request id knocks again. The `approval:<id>` key dedupes
 * against the Core approval stream announcing the same request.
 */
export function usePermissionPromptSound(
	requestId: string | null | undefined
): void {
	const lastRequestId = useRef<string | null>(null);

	useEffect(() => {
		if (!requestId || requestId === lastRequestId.current) {
			return;
		}
		lastRequestId.current = requestId;
		playSound("approval-needed", { key: `approval:${requestId}` });
	}, [requestId]);
}
