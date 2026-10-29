"use client";

// Preserve the island-specific screen-context send and shortcut contracts while
// using the shared InputBar for its field, attachment chips, and send controls.

import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { InputBar } from "../../desktop/agent-elements/input-bar.tsx";

/** One staged image shown as a removable chip above the composer input. */
export interface ComposerAttachment {
	/** `data:<mime>;base64,...` URL, used for the chip thumbnail. */
	dataUrl: string;
	/** Stable id (the source path) used as the key + remove target. */
	id: string;
	name: string;
}

interface MessageInputProps {
	attachments?: ComposerAttachment[];
	disabled?: boolean;
	leftActions?: ReactNode;
	onComposerKeyDown?: (event: KeyboardEvent<HTMLElement>) => boolean;
	onComposerResize?: (height: number) => void;
	onPrefillConsumed?: () => void;
	onRemoveAttachment?: (id: string) => void;
	onSend?: (text: string, options: { withScreen: boolean }) => void;
	onStop?: () => void;
	prefill?: string | null;
	sending?: boolean;
}

const noop = (): void => {
	// Static-render default; the live island injects the real chat send/stop.
};

export function MessageInput({
	attachments = [],
	disabled,
	leftActions,
	prefill,
	onComposerKeyDown,
	onPrefillConsumed,
	onComposerResize = noop,
	onRemoveAttachment,
	onSend = noop,
	onStop = noop,
	sending = false,
}: MessageInputProps) {
	const [value, setValue] = useState("");

	useEffect(() => {
		if (prefill && prefill.length > 0) {
			setValue(prefill);
			onPrefillConsumed?.();
		}
	}, [prefill, onPrefillConsumed]);

	return (
		<InputBar
			attachedImages={attachments.map((attachment) => ({
				filename: attachment.name,
				id: attachment.id,
				url: attachment.dataUrl,
			}))}
			autoFocus
			compact
			disabled={disabled}
			leftActions={leftActions}
			onChange={setValue}
			onHeightChange={onComposerResize}
			onRemoveImage={onRemoveAttachment}
			onSend={({ content }) => onSend(content, { withScreen: true })}
			onStop={onStop}
			onTextareaKeyDown={(event) => {
				if (onComposerKeyDown?.(event)) {
					event.preventDefault();
				}
			}}
			placeholder={disabled ? "Core is offline" : "Ask Ryu…"}
			seamless
			status={sending ? "streaming" : "ready"}
			value={value}
		/>
	);
}
