import type { ReactNode } from "react";
import { COMPOSER_ICONS } from "../lib/app-icon-composer.mjs";
import { safeMediaUrl } from "../lib/safe-media-url.ts";
import { cn } from "../lib/utils.ts";

export type AppIconPresentation =
	| "os-default"
	| "os-preview"
	| "os-launcher"
	| "os-dock"
	| "inbox";

/** Shared shell artwork treatment, applied by each native artwork root. */
export function appIconPresentationClasses(
	presentation: AppIconPresentation | undefined
) {
	if (!presentation) {
		return undefined;
	}
	if (presentation === "inbox") {
		return "rounded-(--radius-inbox-app-icon)";
	}
	return cn(
		"overflow-hidden text-white",
		presentation === "os-preview" &&
			"rounded-(--radius-os-icon-preview) shadow-lg",
		presentation === "os-launcher" &&
			"rounded-(--radius-os-icon-launcher) shadow-(--shadow-os-icon-launcher)",
		presentation === "os-dock" && "rounded-(--radius-os-icon-dock) shadow-lg"
	);
}

/** Native manifest IDs and public catalog namespace IDs refer to the same art. */
export function composerIconFor(id: string | null | undefined) {
	if (!id) {
		return null;
	}
	for (const key of [id, `@${id}`]) {
		if (Object.hasOwn(COMPOSER_ICONS, key)) {
			return COMPOSER_ICONS[key] ?? null;
		}
	}
	return null;
}

/** Completed artwork, shared by client catalogs and server-rendered listings. */
export default function AppIconArtwork({
	id,
	className,
	size = 40,
	fallback = null,
	corners = "default",
	presentation,
}: {
	id: string | null | undefined;
	className?: string;
	size?: number;
	fallback?: ReactNode;
	corners?: "default" | "compact" | "mention";
	presentation?: AppIconPresentation;
}) {
	const artwork = composerIconFor(id);
	if (!artwork) {
		return fallback;
	}
	const light = safeMediaUrl(artwork.light);
	const dark = safeMediaUrl(artwork.dark);
	return (
		<span
			className={cn(
				"relative flex shrink-0 items-center justify-center",
				corners === "compact" && "rounded-artwork-compact",
				corners === "mention" && "rounded-artwork-mention",
				appIconPresentationClasses(presentation),
				className
			)}
			data-app-icon="layered"
		>
			<img
				alt=""
				className="size-full dark:hidden"
				height={size}
				loading="lazy"
				src={light ?? undefined}
				width={size}
			/>
			<img
				alt=""
				className="hidden size-full dark:block"
				height={size}
				loading="lazy"
				src={dark ?? undefined}
				width={size}
			/>
		</span>
	);
}
