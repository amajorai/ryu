/**
 * Confirms an action that moves the interface level between Ryu Work and Code.
 * The level decides the response mode Core receives, and the response mode
 * picks the operating contract in every Ryu assistant thread's system prompt,
 * so the switch resets each of those threads' prompt cache once. Callers hand
 * over the target level and the action; the action runs at once when the
 * response mode would not change, after "Apply now" when it would, and never
 * when the user cancels.
 */

import { type ReactNode, useCallback, useState } from "react";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import {
	type InterfaceLevel,
	readInterfaceLevel,
} from "@/src/lib/interface-level.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { responseModeCacheWarning } from "@/src/lib/response-mode-prompt.ts";

interface PendingLevelChange {
	apply: () => void;
	confirmation: PromptCacheConfirmation;
}

export function useResponseModeConfirm(): {
	confirmLevelChange: (next: InterfaceLevel, apply: () => void) => void;
	dialog: ReactNode;
} {
	const [pending, setPending] = useState<PendingLevelChange | null>(null);

	const confirmLevelChange = useCallback(
		(next: InterfaceLevel, apply: () => void) => {
			// Ryu Bot pins the level to Ryu Work, so nothing it does moves the mode.
			const warning = responseModeCacheWarning(
				readInterfaceLevel(),
				isRyuBot() ? "simple" : next
			);
			if (!warning) {
				apply();
				return;
			}
			setPending({ apply, confirmation: warning });
		},
		[]
	);

	const onApply = () => {
		const change = pending;
		setPending(null);
		change?.apply();
	};

	const dialog = (
		<PromptCacheConfirmDialog
			confirmation={pending?.confirmation ?? null}
			onApply={onApply}
			onCancel={() => setPending(null)}
		/>
	);

	return { confirmLevelChange, dialog };
}
