"use client";

// The island composer: a single blended text input (no box, no ring — it reads
// as part of the island glass). Enter sends; Shift+Enter inserts a newline.
// Screen context is always included by default, so there is no toggle. The
// textarea auto-grows with the draft and reports its height so the island can
// size the compact bar to it. While a reply streams a small stop control appears.

import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

/** Cap (px) the textarea grows to before it scrolls internally. */
const MAX_TEXTAREA_H = 120;

/** One staged image shown as a removable chip above the composer input. */
export interface ComposerAttachment {
	/** `data:<mime>;base64,...` URL, used for the chip thumbnail. */
	dataUrl: string;
	/** Stable id (the source path) used as the key + remove target. */
	id: string;
	name: string;
}

interface MessageInputProps {
	/** Images staged on the composer, rendered as removable chips above the input. */
	attachments?: ComposerAttachment[];
	/** Disable the composer (e.g. Core unreachable). */
	disabled?: boolean;
	/** Agent · Model · Thinking picker (desktop composer parity). */
	leftActions?: ReactNode;
	/** Report the measured composer height so the island can size the compact bar. */
	onComposerResize?: (height: number) => void;
	/** Called once the prefill has been applied so the store can clear it. */
	onPrefillConsumed?: () => void;
	/** Remove one staged attachment (the chip's ✕). */
	onRemoveAttachment?: (id: string) => void;
	/** Send the message. Screen context is always requested. */
	onSend?: (text: string, options: { withScreen: boolean }) => void;
	onStop?: () => void;
	/** Text to seed the input with (suggestion Accept prefill). */
	prefill?: string | null;
	/** True while a reply is streaming; a stop control appears. */
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
	onPrefillConsumed,
	onComposerResize = noop,
	onRemoveAttachment,
	onSend = noop,
	onStop = noop,
	sending = false,
}: MessageInputProps) {
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Grow the textarea to fit the draft, up to a cap (then it scrolls).
	const autosize = useCallback((): void => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_H)}px`;
	}, []);

	// Apply an incoming prefill once, then notify the store to clear it.
	useEffect(() => {
		if (prefill && prefill.length > 0) {
			setValue(prefill);
			onPrefillConsumed?.();
			textareaRef.current?.focus();
		}
	}, [prefill, onPrefillConsumed]);

	// Re-fit on every value change (typing, prefill, send-clear). `value` is in the
	// deps on purpose: `autosize` is a stable callback, so depending on it alone
	// would only fit once on mount and the textarea would never grow past one row.
	useEffect(() => {
		autosize();
	}, [autosize]);

	// Report the composer row's height to the island so the compact bar tracks it.
	useEffect(() => {
		const el = rootRef.current;
		if (!el) {
			return;
		}
		onComposerResize(el.offsetHeight);
		const observer = new ResizeObserver(() => {
			onComposerResize(el.offsetHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [onComposerResize]);

	const submit = (): void => {
		const text = value.trim();
		// An image-only message (no caption) is a valid turn; only block a wholly
		// empty composer or an offline one.
		if ((text.length === 0 && attachments.length === 0) || disabled) {
			return;
		}
		// Screen context is always on by default — there is no per-message toggle.
		onSend(text, { withScreen: true });
		setValue("");
	};

	return (
		<div className="flex flex-col gap-1.5" ref={rootRef}>
			{attachments.length > 0 ? (
				<div
					className="flex gap-1.5 overflow-x-auto"
					style={{ scrollbarWidth: "none" }}
				>
					{attachments.map((attachment) => (
						<div
							className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 py-1 pr-1 pl-1"
							key={attachment.id}
						>
							{/** biome-ignore lint/performance/noImgElement: island is plain React/Electron, no next/image */}
							<img
								alt={attachment.name}
								className="size-6 shrink-0 rounded object-cover"
								src={attachment.dataUrl}
							/>
							<span className="max-w-[90px] truncate text-neutral-200 text-xs">
								{attachment.name}
							</span>
							<button
								aria-label={`Remove ${attachment.name}`}
								className="flex size-4 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100"
								onClick={() => onRemoveAttachment?.(attachment.id)}
								type="button"
							>
								<svg
									aria-hidden="true"
									fill="none"
									height="10"
									stroke="currentColor"
									strokeLinecap="round"
									strokeWidth="2"
									viewBox="0 0 24 24"
									width="10"
								>
									<path d="M18 6 6 18M6 6l12 12" />
								</svg>
							</button>
						</div>
					))}
				</div>
			) : null}

			<div className="flex items-center gap-2">
				{leftActions ? (
					<div className="shrink-0 self-end">{leftActions}</div>
				) : null}
				{/** biome-ignore lint/a11y/noAutofocus: the composer is the sole purpose of the expanded island */}
				<textarea
					aria-label="Message Ryu"
					autoFocus
					className="min-h-0 flex-1 resize-none overflow-y-auto bg-transparent text-neutral-100 text-sm leading-relaxed outline-none placeholder:text-neutral-500"
					disabled={disabled}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
					placeholder={disabled ? "Core is offline" : "Ask Ryu…"}
					ref={textareaRef}
					rows={1}
					value={value}
				/>
				{sending ? (
					<button
						aria-label="Stop"
						className="flex size-7 shrink-0 items-center justify-center self-end rounded-full text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100"
						onClick={onStop}
						type="button"
					>
						<span className="size-2.5 rounded-[2px] bg-current" />
					</button>
				) : null}
			</div>
		</div>
	);
}
