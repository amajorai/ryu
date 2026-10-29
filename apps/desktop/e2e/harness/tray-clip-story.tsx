import proofStyles from "./tray-clip-story.module.css";
// Standalone browser story for the REAL sidebar-footer tray (TrayMorph, shared
// by the Downloads and Inbox trays). It reproduces every host the sidebar
// footer renders in, so the 23rem panel can be checked against each:
//
//   * "clipped": `overflow: hidden` + a transform — Layout's hover-peek panel.
//   * "clip-only": `overflow: clip` with no transform — the background-
//     customization rule (`html[data-ryu-bg-active] [data-slot=sidebar-inner]`).
//   * "control": the docked sidebar, which clips nothing.
//   * hover-peek: the same clip, but slid in by a transform AFTER mount — the
//     case where an anchor measured at mount is stale.
//   * Sheet: the phone sidebar. It does not clip, but it is modal, so the tray
//     has to stay inside it rather than portal to an `aria-hidden` body.
//
// Open the tray in each: any panel that stops at the 260px column edge is the
// bug, and any panel that lands off-screen is a stale anchor.

import { Download01Icon } from "@hugeicons/core-free-icons";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@ryu/ui/components/sheet.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	TrayEmpty,
	TrayFooter,
	TrayHeader,
	TrayMorph,
} from "../../src/components/shell/TrayPopover.tsx";
import "../../src/index.css";

function Tray({ testid }: { testid: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex items-center justify-end p-2" data-testid={testid}>
			<TrayMorph
				icon={Download01Icon}
				label="Downloads"
				onOpenChange={setOpen}
				open={open}
			>
				<TrayHeader count={0} status="nothing downloading" title="Downloads" />
				<TrayEmpty
					description="Installs and updates you start show their progress here."
					icon={Download01Icon}
					title="Nothing downloading"
				/>
				<TrayFooter label="Open downloads" onClick={() => undefined} />
			</TrayMorph>
		</div>
	);
}

/**
 * A tray whose body is far taller than TRAY_MORPH_INITIAL_H (240px), so the box
 * height has to come from the measured panel rather than the fallback. The
 * fallback is invisible in a short tray — the empty state happens to land within
 * a few px of it — so only this column can tell a live measurement from a dead
 * one.
 */
function TallTray() {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex items-center justify-end p-2" data-testid="tray-tall">
			<TrayMorph
				icon={Download01Icon}
				label="Downloads"
				onOpenChange={setOpen}
				open={open}
			>
				<TrayHeader count={12} status="12 downloading" title="Downloads" />
				<div className="flex flex-col gap-1 p-1.5">
					{Array.from({ length: 12 }, (_, i) => (
						<div
							className="h-12 rounded-(--radius-xl) bg-muted/60"
							// static filler rows
							key={i}
						/>
					))}
				</div>
				<TrayFooter label="Open downloads" onClick={() => undefined} />
			</TrayMorph>
		</div>
	);
}

function Column({
	label,
	variant,
	testid,
}: {
	label: string;
	variant: "clipped" | "clip-only" | "control";
	testid: string;
}) {
	return (
		<div className={proofStyles.fixture1}>
			<div className={proofStyles.column} data-variant={variant}>
				<p className="px-2 text-muted-foreground text-xs">{label}</p>
				<Tray testid={testid} />
			</div>
		</div>
	);
}

/**
 * Layout's hover-peek sidebar: mounted off-screen left and slid in by a
 * transform on hover, never re-mounted. The tray's anchor therefore has to be
 * re-measured when it opens — a mount-time measurement is a negative `left` by
 * then — which is why this column exists and why the measure is a layout
 * effect.
 */
function PeekColumn() {
	const [peeked, setPeeked] = useState(false);
	return (
		<div className={proofStyles.fixture2}>
			<div
				className={proofStyles.peekColumn}
				data-peeked={peeked}
				data-testid="peek-panel"
				onMouseEnter={() => setPeeked(true)}
				onMouseLeave={() => setPeeked(false)}
			>
				<p className="px-2 text-muted-foreground text-xs">hover-peek</p>
				<Tray testid="tray-peek" />
			</div>
			{/* The left-edge hover zone that reveals the panel. */}
			{/** hover-peek zone */}
			<div
				className="absolute top-0 left-0 h-full w-6"
				data-testid="peek-zone"
				onMouseEnter={() => setPeeked(true)}
			/>
		</div>
	);
}

/**
 * The phone host: the sidebar is a modal Sheet. Nothing in that chain clips, but
 * everything outside the open Sheet is `aria-hidden`, so the tray must portal
 * into the Sheet's own popup rather than to the body.
 */
function SheetColumn() {
	return (
		<div className={proofStyles.fixture3}>
			<Sheet>
				<SheetTrigger data-testid="sheet-open">Open sheet sidebar</SheetTrigger>
				<SheetContent
					className="flex w-[260px] flex-col justify-end sm:max-w-[260px]"
					side="left"
				>
					<SheetHeader className="sr-only">
						<SheetTitle>Sidebar</SheetTitle>
					</SheetHeader>
					<Tray testid="tray-sheet" />
				</SheetContent>
			</Sheet>
		</div>
	);
}

function Story() {
	return (
		<div className="flex gap-16 p-10">
			<Column
				label="clipped (overflow hidden + transform)"
				testid="tray-clipped"
				variant="clipped"
			/>
			<Column
				label="clip only (no transform)"
				testid="tray-clip-only"
				variant="clip-only"
			/>
			<Column
				label="control (no clip)"
				testid="tray-control"
				variant="control"
			/>
			<PeekColumn />
			<SheetColumn />
			<div className={proofStyles.fixture4}>
				<div className="flex h-full flex-col justify-end overflow-hidden bg-sidebar">
					<p className="px-2 text-muted-foreground text-xs">tall tray</p>
					<TallTray />
				</div>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
