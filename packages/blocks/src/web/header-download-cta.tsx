"use client";

import { cn } from "@ryu/ui/lib/utils";
import { DownloadMenu } from "./download-menu.tsx";
import { LandingDownloadBeam } from "./landing-download-beam.tsx";

// Shared download button for the marketing, portal and docs headers, so every
// public header draws the same control as the landing hero: "Download for
// <OS logo>", with the CPU architecture morphing in on hover or focus.
//
// `variant` exists because the headers rank this action differently. In the
// portal the visitor has already bought and installing the app IS the next
// step, so it stays the filled primary. Marketing and docs headers pass `mono`
// (black on light, white on dark) instead of the theme blue. Download stays
// visible rather than folded into a menu, because the desktop app is the
// surface a firm's team actually works in, not a developer-only artifact.
export function HeaderDownloadCta({
	className,
	beam = false,
	showSeparator = false,
	siteOrigin,
	variant = "default",
}: {
	className?: string;
	/** Wrap the button in the landing's border beam (transparent hero headers). */
	beam?: boolean;
	showSeparator?: boolean;
	/** Forwarded to the menu for links back to the main site (docs header). */
	siteOrigin?: string;
	variant?: "default" | "ghost" | "mono" | "outline";
}) {
	const menu = (
		<DownloadMenu
			className={cn(className)}
			contentAlign="end"
			showOsLogo
			showSeparator={showSeparator}
			size="sm"
			transparentBackground={beam}
			variant={beam ? "outline" : variant}
			{...(siteOrigin ? { siteOrigin } : {})}
		/>
	);

	return beam ? (
		<LandingDownloadBeam
			borderRadius={16}
			testId="landing-header-download-beam"
		>
			{menu}
		</LandingDownloadBeam>
	) : (
		menu
	);
}
