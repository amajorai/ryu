import { type Chord, chordTokens, eventToChord } from "@ryu/hotkeys/chord";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { useState } from "react";

/** Render a chord as keycaps, or a muted "Unbound" when null. */
export function ChordCaps({ chord }: { chord: Chord | null }) {
	if (!chord) {
		return <span className="text-muted-foreground text-xs">Unbound</span>;
	}
	return (
		<span className="flex items-center gap-1">
			{chordTokens(chord).map((token, index) => (
				<Kbd key={`${index}-${token}`}>{token}</Kbd>
			))}
		</span>
	);
}
interface ChordRecorderProps {
	conflicting?: boolean;
	disabled?: boolean;
	onChange: (chord: Chord) => void;
	testId?: string;
	value: Chord | null;
}

/** A keycap button that records the next chord in canonical cross-platform form. */
export function ChordRecorder({
	disabled = false,
	value,
	onChange,
	conflicting,
	testId,
}: ChordRecorderProps) {
	const [capturing, setCapturing] = useState(false);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (disabled || !capturing) {
			return;
		}
		e.preventDefault();
		if (e.key === "Escape") {
			setCapturing(false);
			return;
		}
		const chord = eventToChord(e.nativeEvent);
		if (chord) {
			onChange(chord);
			setCapturing(false);
		}
	};

	return (
		<button
			className={`flex min-w-32 items-center justify-center gap-1 rounded-lg bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring ${conflicting ? "ring-2 ring-destructive" : ""}`}
			data-testid={testId}
			disabled={disabled}
			onBlur={() => setCapturing(false)}
			onClick={() => setCapturing(true)}
			onKeyDown={handleKeyDown}
			type="button"
		>
			{capturing ? (
				<span className="text-muted-foreground text-xs">Press keys…</span>
			) : (
				<ChordCaps chord={value} />
			)}
		</button>
	);
}
