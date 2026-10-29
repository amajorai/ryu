import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * The desktop app forces every `kbd` into the code face with `!important`.
 * Key caps here are labels for keys, so the glyphs sit in a plain span that
 * takes the UI face and centres on the cap.
 */
function KeyFace({ children }: { children: ReactNode }) {
	return <span className="font-sans leading-none">{children}</span>;
}

/**
 * One key-cap shape for the whole inbox: a 20px square-ish cap with a 4px
 * radius, so single letters and words ("Enter") read as the same object.
 */
const KEY_CAP =
	"inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-medium text-xs leading-none";

/**
 * A shortcut hint inside a tooltip. The shared Kbd assumes an inverted
 * tooltip, but Ryu's tooltip sits on the muted surface with foreground text,
 * so the key cap is re-toned to stay readable in every theme.
 */
export function InboxTooltipKbd({ children }: { children: ReactNode }) {
	return (
		<Kbd
			className={cn(
				KEY_CAP,
				"in-data-[slot=tooltip-content]:bg-background/70 in-data-[slot=tooltip-content]:text-muted-foreground dark:in-data-[slot=tooltip-content]:bg-background/50"
			)}
		>
			<KeyFace>{children}</KeyFace>
		</Kbd>
	);
}

/** A key cap inside an outline button, on the button's own surface. */
export function InboxButtonKbd({ children }: { children: ReactNode }) {
	return (
		<Kbd className={cn(KEY_CAP, "-mr-1 bg-muted text-muted-foreground")}>
			<KeyFace>{children}</KeyFace>
		</Kbd>
	);
}

/** A key cap inside a primary button, tinted from the button's own text. */
export function InboxPrimaryKbd({ children }: { children: ReactNode }) {
	return (
		<Kbd
			className={cn(
				KEY_CAP,
				"-mr-1 bg-primary-foreground/15 text-primary-foreground"
			)}
		>
			<KeyFace>{children}</KeyFace>
		</Kbd>
	);
}

/** A key cap in running text, on the page's muted surface. */
export function InboxHintKbd({ children }: { children: ReactNode }) {
	return (
		<Kbd className={cn(KEY_CAP, "bg-muted text-muted-foreground")}>
			<KeyFace>{children}</KeyFace>
		</Kbd>
	);
}
