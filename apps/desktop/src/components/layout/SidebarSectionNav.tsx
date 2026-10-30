"use client";

import { SPRING_MORPH } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, type Transition, useReducedMotion } from "motion/react";
import type { CSSProperties as LayoutCSSProperties } from "react";
import { useState } from "react";
import layoutStyles from "./SidebarSectionNav.module.css";

/**
 * A "peek" tab pinned to the sidebar's left edge that morphs open on hover into
 * a floating list of the sidebar's sections — a quick way to jump the sidebar
 * scroll to any section. Mirrors the single-surface morph of the "Ask Ryu"
 * MorphPopover: one animated shell whose width/height/radius spring between the
 * bare peek sliver and the full panel, with the section list crossfading in.
 *
 * Each section's `SidebarGroup` carries `id="sidebar-sec-<key>"` (see
 * AppSidebar's SidebarSection); clicking a row scrolls that anchor into view.
 */

// Shared with MorphPopover via the SPRING_MORPH token — these were two
// byte-identical inline copies before.
const MORPH_SPRING: Transition = SPRING_MORPH;
const REDUCED_TRANSITION: Transition = { duration: 0.15, ease: "easeOut" };
const PEEK_WIDTH = 5;
const PEEK_HEIGHT = 46;
const PANEL_WIDTH = 208;
const PANEL_RADIUS = 14;
const ROW_HEIGHT = 26;
const PANEL_MAX_HEIGHT = 420;

export interface SidebarSectionNavItem {
	key: string;
	label: string;
}

export function SidebarSectionNav({
	items,
}: {
	items: SidebarSectionNavItem[];
}) {
	const [open, setOpen] = useState(false);
	const reduceMotion = useReducedMotion();
	const transition = reduceMotion ? REDUCED_TRANSITION : MORPH_SPRING;

	// Nothing worth a jump-list with a single section.
	if (items.length < 2) {
		return null;
	}

	const scrollToSection = (key: string) => {
		const el = document.getElementById(`sidebar-sec-${key}`);
		el?.scrollIntoView({
			behavior: reduceMotion ? "auto" : "smooth",
			block: "start",
		});
	};

	const panelHeight = Math.min(
		items.length * ROW_HEIGHT + 10,
		PANEL_MAX_HEIGHT
	);

	const cssVariables1: LayoutCssVariables = {
		"--desktop-inline1-pointer-Events": open ? "auto" : "none",
	};
	return (
		// Wrapper widens the hover hit-area so the thin peek sliver is easy to grab.
		<div
			className="absolute top-1/2 left-0 z-30 flex -translate-y-1/2 items-center pr-3"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<motion.div
				animate={{
					width: open ? PANEL_WIDTH : PEEK_WIDTH,
					height: open ? panelHeight : PEEK_HEIGHT,
					borderRadius: open ? PANEL_RADIUS : 999,
				}}
				className={cn(
					"overflow-hidden border transition-colors",
					open
						? "border-border bg-popover shadow-lg"
						: "border-transparent bg-foreground/20 hover:bg-foreground/30"
				)}
				initial={false}
				transition={transition}
			>
				<motion.nav
					animate={{ opacity: open ? 1 : 0 }}
					aria-label="Jump to sidebar section"
					className={cn(
						"scroll-fade no-scrollbar flex h-full flex-col gap-0.5 overflow-y-auto p-1.5",
						layoutStyles.inline1
					)}
					initial={false}
					style={cssVariables1}
					transition={{ duration: 0.12, delay: open ? 0.05 : 0 }}
				>
					{items.map((item) => (
						<button
							className="truncate rounded-lg px-2 py-1 text-left text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
							key={item.key}
							onClick={() => scrollToSection(item.key)}
							type="button"
						>
							{item.label}
						</button>
					))}
				</motion.nav>
			</motion.div>
		</div>
	);
}

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-pointer-Events"?: string | number;
}
