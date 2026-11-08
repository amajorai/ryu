"use client";

// The raw converter or Core text under a failed Spaces file row.
//
// It is untranslated by design (the translated sentence sits above it), so the
// DOM localizer is told to leave it alone, and it is isolated left-to-right in a
// `<bdi>` so a path or "libreoffice is not installed — …" does not reorder
// inside an Arabic row. The outer span keeps the row's own direction, so the
// line still aligns with the title above it.

export function FileRawDetail({ text }: { text: string }) {
	return (
		<span
			className="truncate text-muted-foreground/80 text-xs"
			data-ryu-i18n="off"
			title={text}
		>
			<bdi dir="ltr">{text}</bdi>
		</span>
	);
}
