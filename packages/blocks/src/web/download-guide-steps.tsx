"use client";

// The install half of the post-download guide: numbered step cards (three
// columns on wide screens, stacked on narrow ones), copyable terminal commands,
// and the Gatekeeper / SmartScreen note as a quiet callout.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	Check,
	Copy,
	FileCog,
	FolderInput,
	HardDriveDownload,
	LifeBuoy,
	ListChecks,
	type LucideIcon,
	MousePointerClick,
	PackageCheck,
	Play,
	Rocket,
	ShieldAlert,
	Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
	InstallerFormat,
	InstallGuide,
	InstallStep,
} from "./download-guide.ts";

const STEP_ICONS: Record<InstallerFormat, LucideIcon[]> = {
	appimage: [FileCog, Play, LifeBuoy],
	deb: [Terminal, PackageCheck, Rocket],
	dmg: [HardDriveDownload, FolderInput, Rocket],
	exe: [MousePointerClick, ListChecks, Rocket],
	msi: [MousePointerClick, ListChecks, Rocket],
	rpm: [Terminal, PackageCheck, Rocket],
};

/** The icon drawn on step `index` of a format's guide. */
export function stepIcon(format: InstallerFormat, index: number): LucideIcon {
	const icons = STEP_ICONS[format];
	return icons[index] ?? icons.at(-1) ?? Rocket;
}

type CopyState = "copied" | "failed" | "idle";

const COPY_STATUS: Record<CopyState, string> = {
	copied: "Copied",
	failed: "Couldn't copy. The command is selected, so copy it yourself.",
	idle: "",
};

export function CommandBlock({ command }: { command: string }) {
	const [copyState, setCopyState] = useState<CopyState>("idle");
	const codeRef = useRef<HTMLElement>(null);

	useEffect(() => {
		if (copyState !== "copied") {
			return;
		}
		const timer = window.setTimeout(() => setCopyState("idle"), 2000);
		return () => window.clearTimeout(timer);
	}, [copyState]);

	// When the browser refuses the clipboard, select the command so the visitor
	// can copy it with the keyboard instead.
	const copyFailed = () => {
		setCopyState("failed");
		const code = codeRef.current;
		const selection = window.getSelection();
		if (code && selection) {
			const range = document.createRange();
			range.selectNodeContents(code);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	};

	const copy = () => {
		if (!navigator.clipboard) {
			copyFailed();
			return;
		}
		navigator.clipboard
			.writeText(command)
			.then(() => setCopyState("copied"))
			.catch(copyFailed);
	};

	const copied = copyState === "copied";
	return (
		<div className="mt-3">
			<div className="flex items-center gap-1 rounded-xl border border-border/70 bg-muted/60 py-1 ps-3 pe-1">
				<span
					aria-hidden="true"
					className="select-none font-mono text-muted-foreground text-xs"
				>
					$
				</span>
				<code
					className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1 font-mono text-foreground text-xs"
					ref={codeRef}
				>
					{command}
				</code>
				<Button
					aria-label={copied ? "Copied" : "Copy command"}
					className="shrink-0"
					onClick={copy}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{copied ? (
						<Check className="size-3.5" />
					) : (
						<Copy className="size-3.5" />
					)}
				</Button>
			</div>
			<p
				aria-live="polite"
				className={cn(
					"mt-1 text-muted-foreground text-xs",
					copyState === "failed" ? null : "sr-only"
				)}
			>
				{COPY_STATUS[copyState]}
			</p>
		</div>
	);
}

function StepCard({
	format,
	index,
	step,
}: {
	format: InstallerFormat;
	index: number;
	step: InstallStep;
}) {
	const tl = useLiteralMessages();
	const Icon = stepIcon(format, index);
	return (
		<li className="relative flex flex-col rounded-3xl border border-border/70 bg-background/70 p-5">
			<div className="flex items-center justify-between">
				<span className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
					<Icon aria-hidden="true" className="size-5" />
				</span>
				<span
					aria-hidden="true"
					className="font-heading font-medium text-3xl text-muted-foreground/25 tabular-nums"
				>
					{index + 1}
				</span>
			</div>
			<h4 className="mt-4 font-heading font-medium text-base text-foreground">
				<span className="sr-only">
					{tl("Step {number}:", { number: index + 1 })}{" "}
				</span>
				{step.title}
			</h4>
			<p className="mt-1.5 text-pretty text-muted-foreground text-sm leading-relaxed">
				{step.description}
			</p>
			{step.command ? <CommandBlock command={step.command} /> : null}
		</li>
	);
}

export function InstallSteps({ guide }: { guide: InstallGuide }) {
	return (
		<>
			<ol
				className="grid gap-3 md:grid-cols-3"
				data-testid="download-guide-steps"
			>
				{guide.steps.map((step, index) => (
					<StepCard
						format={guide.format}
						index={index}
						key={step.title}
						step={step}
					/>
				))}
			</ol>
			{guide.troubleshooting ? (
				<aside
					className="mt-3 flex gap-3 rounded-2xl border border-border/70 border-dashed bg-muted/30 p-4"
					data-testid="download-guide-troubleshooting"
				>
					<ShieldAlert
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
					/>
					<div>
						<p className="font-medium text-foreground text-sm">
							{guide.troubleshooting.title}
						</p>
						<p className="mt-1 text-pretty text-muted-foreground text-sm leading-relaxed">
							{guide.troubleshooting.description}
						</p>
					</div>
				</aside>
			) : null}
		</>
	);
}
