import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	fitBlockReason,
	isBlockedFit,
	isSlowFit,
	SLOW_FIT_WARNING,
} from "@ryu/blocks/desktop/model-fit.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useState } from "react";
import type { ModelDetail } from "./types.ts";

/**
 * The install verdict line under a model file or snapshot: the full refusal
 * reason (with this device's numbers) when the verdict blocks the install, an
 * amber "may be slow" warning when it runs on the CPU or only partly on the GPU,
 * and nothing otherwise. Core computes the verdict for the node that serves it.
 */
export function FitInstallNotice({
	blocking: blockingProp,
	device,
	fit,
	label,
}: {
	/** False when the verdict reads as blocked but this node still installs it
	 *  (an older Core's soft `too_big`): shown as a warning. */
	blocking?: boolean;
	device: ModelDetail["device"];
	fit: string;
	label: string;
}) {
	const tl = useLiteralMessages();
	const blocking = blockingProp ?? isBlockedFit(fit);
	const reason = blocking ? fitBlockReason(fit, label, device) : null;
	if (reason) {
		return (
			<p
				className="flex items-start gap-1.5 text-status-destructive text-xs"
				role="note"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-px size-3.5 shrink-0"
					icon={Alert02Icon}
				/>
				<span>
					{tl("{reason} You can't add it on this device.", { reason })}
				</span>
			</p>
		);
	}
	if (isSlowFit(fit) || (isBlockedFit(fit) && !blocking)) {
		return (
			<p
				className="flex items-center gap-1.5 text-status-warning text-xs"
				role="note"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3.5 shrink-0"
					icon={Alert02Icon}
				/>
				{SLOW_FIT_WARNING}
			</p>
		);
	}
	return null;
}

/**
 * Run an install and keep its failure message for display. The host's install
 * layer rejects with Core's plain-language reason (e.g. the 422 "won't fit"
 * refusal when the detail was stale), which used to be swallowed silently.
 */
export function useInstallAttempt() {
	const [error, setError] = useState<string | null>(null);
	const attempt = useCallback((run: () => Promise<void>) => {
		setError(null);
		run().catch((err: unknown) => {
			setError(
				err instanceof Error && err.message
					? err.message
					: "Couldn't add this model."
			);
		});
	}, []);
	return { attempt, error };
}

/** The last install failure, announced to assistive tech. */
export function InstallErrorNote({ message }: { message: string | null }) {
	if (!message) {
		return null;
	}
	return (
		<p className="text-status-destructive text-xs" role="alert">
			{message}
		</p>
	);
}
