// Reusable global-shortcut capture control: renders the current accelerator as
// keycaps inside a button that, when focused, records the next key chord and
// reports it as an Electron accelerator string (e.g. "CommandOrControl+Shift+A").
// Used by the Island settings for the command-summon and push-to-talk shortcuts.
// Pure presentation plus a local capturing state; the parent owns persistence.

import { Button } from "@ryu/ui/components/button";
import { useState } from "react";

/** Pretty labels for accelerator tokens shown as keycaps. */
const TOKEN_LABELS: Record<string, string> = {
	CommandOrControl: "Ctrl",
	Alt: "Alt",
	Shift: "Shift",
	Space: "Space",
};

/** Named keys whose `KeyboardEvent.key` differs from the Electron accelerator. */
const NAMED_KEYS: Record<string, string> = {
	" ": "Space",
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Escape: "Esc",
	Enter: "Return",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
};

const MODIFIER_ONLY_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/**
 * Build an Electron accelerator string from a keydown event, or `null` for a
 * modifier-only press (the user is still composing the chord).
 */
function eventToAccelerator(e: React.KeyboardEvent): string | null {
	if (MODIFIER_ONLY_KEYS.has(e.key)) {
		return null;
	}
	const parts: string[] = [];
	if (e.ctrlKey || e.metaKey) {
		parts.push("CommandOrControl");
	}
	if (e.altKey) {
		parts.push("Alt");
	}
	if (e.shiftKey) {
		parts.push("Shift");
	}
	const main =
		NAMED_KEYS[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
	parts.push(main);
	return parts.join("+");
}

/** Split an accelerator into display keycaps. */
function acceleratorTokens(accelerator: string): string[] {
	return accelerator
		.split("+")
		.map((t) => TOKEN_LABELS[t] ?? t)
		.filter((t) => t.length > 0);
}

interface ShortcutCaptureProps {
	/** Accessible label for the capture button. */
	ariaLabel: string;
	/** Called with the new Electron accelerator string when a chord is captured. */
	onChange: (accelerator: string) => void;
	/** Optional reset handler; renders a "Reset" button when provided. */
	onReset?: () => void;
	/** The current accelerator string to display. */
	value: string;
}

/** Keycap button that records the next key chord as an Electron accelerator. */
export function ShortcutCapture({
	ariaLabel,
	onChange,
	onReset,
	value,
}: ShortcutCaptureProps) {
	const [capturing, setCapturing] = useState(false);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!capturing) {
			return;
		}
		e.preventDefault();
		if (e.key === "Escape") {
			setCapturing(false);
			return;
		}
		const accelerator = eventToAccelerator(e);
		if (accelerator) {
			onChange(accelerator);
			setCapturing(false);
		}
	};

	return (
		<div className="flex items-center gap-2">
			<button
				aria-label={ariaLabel}
				className="flex min-w-40 items-center justify-center gap-1 rounded-md bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
				onBlur={() => setCapturing(false)}
				onClick={() => setCapturing(true)}
				onKeyDown={handleKeyDown}
				type="button"
			>
				{capturing ? (
					<span className="text-muted-foreground text-xs">Press keys…</span>
				) : (
					acceleratorTokens(value).map((token) => (
						<kbd
							className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
							key={token}
						>
							{token}
						</kbd>
					))
				)}
			</button>
			{onReset ? (
				<Button onClick={onReset} size="sm" variant="ghost">
					Reset
				</Button>
			) : null}
		</div>
	);
}
