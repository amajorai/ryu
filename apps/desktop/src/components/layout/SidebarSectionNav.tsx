"use client";

import { cn } from "@ryu/ui/lib/utils";
import { motion, type Transition, useReducedMotion } from "framer-motion";
import { useState } from "react";

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

const MORPH_SPRING: Transition = {
	type: "spring",
	stiffness: 320,
	damping: 34,
	mass: 0.9,
};
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
						? "border-border/60 bg-popover/95 shadow-lg backdrop-blur"
						: "border-transparent bg-foreground/20 hover:bg-foreground/30"
				)}
				initial={false}
				transition={transition}
			>
				<motion.nav
					animate={{ opacity: open ? 1 : 0 }}
					aria-label="Jump to sidebar section"
					className="no-scrollbar flex h-full flex-col gap-0.5 overflow-y-auto p-1.5"
					initial={false}
					style={{ pointerEvents: open ? "auto" : "none" }}
					transition={{ duration: 0.12, delay: open ? 0.05 : 0 }}
				>
					{items.map((item) => (
						<button
							className="truncate rounded-md px-2 py-1 text-left text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
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
