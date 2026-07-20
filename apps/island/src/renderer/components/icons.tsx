// Minimal inline SVG icons for the island action dock.
//
// The island deliberately ships no icon library (it pulls only from `@ryu/ui`),
// so these are tiny hand-rolled, lucide-style strokes drawn in `currentColor` to
// inherit each action circle's glass text colour. Keep them stroke-only and on a
// 24x24 viewBox so a single `size` prop scales them crisply.

interface IconProps {
	/** Rendered width/height in px (square). */
	size?: number;
}

const BASE_PROPS = {
	fill: "none",
	stroke: "currentColor",
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
	strokeWidth: 2,
	viewBox: "0 0 24 24",
};

/** Microphone — push-to-talk / voice mode. */
export function MicIcon({ size = 18 }: IconProps) {
	return (
		<svg aria-hidden="true" height={size} width={size} {...BASE_PROPS}>
			<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
			<path d="M5 11a7 7 0 0 0 14 0" />
			<line x1="12" x2="12" y1="18" y2="22" />
		</svg>
	);
}

/** Sound bars — continuous voice mode (distinct from the push-to-talk mic). */
export function VoiceModeIcon({ size = 18 }: IconProps) {
	return (
		<svg aria-hidden="true" height={size} width={size} {...BASE_PROPS}>
			<line x1="4" x2="4" y1="10" y2="14" />
			<line x1="8" x2="8" y1="7" y2="17" />
			<line x1="12" x2="12" y1="4" y2="20" />
			<line x1="16" x2="16" y1="7" y2="17" />
			<line x1="20" x2="20" y1="10" y2="14" />
		</svg>
	);
}

/** Paperclip — attach a file. */
export function AttachIcon({ size = 18 }: IconProps) {
	return (
		<svg aria-hidden="true" height={size} width={size} {...BASE_PROPS}>
			<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" />
		</svg>
	);
}

/** Command glyph — open the command palette. */
export function CommandIcon({ size = 18 }: IconProps) {
	return (
		<svg aria-hidden="true" height={size} width={size} {...BASE_PROPS}>
			<path d="M15 6a3 3 0 1 1 3 3h-3V6Zm-6 0a3 3 0 1 0-3 3h3V6Zm0 12a3 3 0 1 1-3-3h3v3Zm6 0a3 3 0 1 0 3-3h-3v3Z" />
			<rect height="6" rx="0" width="6" x="9" y="9" />
		</svg>
	);
}
