import { cn } from "@ryu/ui/lib/utils";
import type { ComponentProps } from "react";
import { SV_UI } from "./world-2d-palette.ts";

export const HUD_FONT =
	"font-(family-name:--sv-font) font-normal [font-synthesis:none]";

/**
 * A chunky keyboard key in the hotbar's beige. The glyph is crisp: no text
 * shadow (the HUD's pixel shadow smears a keycap's small letters).
 */
export function PixelKey({
	className,
	style,
	...props
}: ComponentProps<"kbd">) {
	return (
		<kbd
			className={cn(
				"font-(family-name:--sv-font) inline-flex h-6 min-w-6 items-center justify-center border-(--sv-wood-dark) border-2 bg-(--sv-key) px-1 font-normal text-(--sv-ink) text-[16px] leading-5 shadow-[inset_-2px_-2px_0_var(--sv-key-shade),0_2px_0_var(--sv-outline)] [font-synthesis:none]",
				className
			)}
			style={{ ...style, textShadow: "none" }}
			{...props}
		/>
	);
}

/** Stardew's red close "X", as pixels (4 screen pixels per art pixel). */
function CloseIcon() {
	return (
		<svg
			aria-hidden="true"
			height="28"
			shapeRendering="crispEdges"
			viewBox="0 0 7 7"
			width="28"
		>
			<path
				d="M0 0h2v1h1v1h1v-1h1v-1h2v2h-1v1h-1v1h1v1h1v2h-2v-1h-1v-1h-1v1h-1v1h-2v-2h1v-1h1v-1h-1v-1h-1z"
				fill={SV_UI.closeDark}
			/>
			<path
				d="M1 1h1v1h1v1h1v-1h1v-1h1v1h-1v1h-1v1h1v1h1v1h-1v-1h-1v-1h-1v1h-1v1h-1v-1h1v-1h1v-1h-1v-1h-1z"
				fill={SV_UI.close}
			/>
		</svg>
	);
}

/**
 * Stardew's red close "X" (a 32px target), placed just past a menu's
 * top-right corner rather than on its frame.
 */
export function CloseButton({
	keyShortcut,
	label,
	onClick,
	title,
}: {
	keyShortcut?: string;
	label: string;
	onClick: () => void;
	title: string;
}) {
	return (
		<button
			aria-keyshortcuts={keyShortcut}
			aria-label={label}
			className="pointer-events-auto flex size-8 shrink-0 items-center justify-center outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-1 active:translate-y-px"
			onClick={onClick}
			title={title}
			type="button"
		>
			<CloseIcon />
		</button>
	);
}
