"use client";

// Presentational leaf components shared by the desktop Models catalog. The live
// section (`apps/desktop/src/components/store/ModelsCatalogSection.tsx`) is a
// deeply hook-coupled master-detail surface (infinite scroll, HF catalog hooks,
// app Markdown) so its orchestration stays in the app; this block extracts the
// genuinely presentational pieces that BOTH the real section and the storyboard
// render — chiefly the device-fit verdict indicator (the colored dot + label that
// tells a user whether a model fits their machine) and the quant-file row.
//
// One source of truth: the real section's `fitStyle` and the storyboard's
// `FIT_DOT`/`FIT_TEXT` were parallel copies of the same thing — they now both
// resolve through `fitStyle` here.

import {
	CheckmarkCircle02Icon,
	Download01Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";

/** The five device-fit verdicts Core computes per model file. */
export type ModelFit = "great" | "ok" | "partial" | "cpu" | "too_big" | string;

/** Tailwind classes + dot color for a device-fit verdict. Single source of truth
 *  for the fit color language across the real section and the storyboard. */
export function fitStyle(fit: ModelFit): { className: string; dot: string } {
	switch (fit) {
		case "great":
			return {
				className: "text-emerald-600 dark:text-emerald-400",
				dot: "bg-emerald-500",
			};
		case "ok":
			return {
				className: "text-green-600 dark:text-green-400",
				dot: "bg-green-500",
			};
		case "partial":
			return {
				className: "text-amber-600 dark:text-amber-400",
				dot: "bg-amber-500",
			};
		case "cpu":
			return {
				className: "text-sky-600 dark:text-sky-400",
				dot: "bg-sky-500",
			};
		case "too_big":
			return { className: "text-red-600 dark:text-red-400", dot: "bg-red-500" };
		default:
			return {
				className: "text-muted-foreground",
				dot: "bg-muted-foreground/50",
			};
	}
}

/** The colored dot + label that summarizes whether a model file fits the device. */
export function ModelFitIndicator({
	fit,
	label,
	className,
}: {
	fit: ModelFit;
	label: string;
	className?: string;
}) {
	const style = fitStyle(fit);
	return (
		<span
			className={`flex items-center gap-1 ${style.className} ${className ?? ""}`}
		>
			<span className={`size-1.5 rounded-full ${style.dot}`} />
			{label}
		</span>
	);
}

/** The catalog search header (search input + optional trailing controls). */
export function ModelSearchHeader({
	value,
	onChange,
	placeholder = "Search Hugging Face GGUF models…",
	trailing,
}: {
	value?: string;
	onChange?: (value: string) => void;
	placeholder?: string;
	trailing?: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 border-border border-b px-4 py-3">
			<div className="relative max-w-sm flex-1">
				<HugeiconsIcon
					className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Search01Icon}
				/>
				<Input
					className="h-9 pl-9"
					defaultValue={onChange ? undefined : value}
					onChange={onChange ? (e) => onChange(e.target.value) : undefined}
					placeholder={placeholder}
					value={onChange ? value : undefined}
				/>
			</div>
			{trailing}
		</div>
	);
}

export interface ModelListRowData {
	fit: ModelFit;
	fitLabel: string;
	gated?: boolean;
	installed: boolean;
	quant: string;
	repo: string;
	size: string;
}

/** A model master-list row (repo, install/gated badge, fit + size). */
export function ModelListRow({
	model,
	selected,
	onSelect,
}: {
	model: ModelListRowData;
	selected?: boolean;
	onSelect?: () => void;
}) {
	return (
		<button
			className={`flex w-full flex-col gap-1 border-border border-b px-4 py-3 text-left transition-colors ${
				selected ? "bg-muted" : "hover:bg-accent/50"
			}`}
			onClick={onSelect}
			type="button"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="truncate font-medium text-sm">{model.repo}</span>
				{model.installed ? (
					<Badge variant="secondary">Installed</Badge>
				) : model.gated ? (
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-amber-500"
						icon={Search01Icon}
					/>
				) : null}
			</div>
			<div className="flex items-center gap-2 text-xs">
				<ModelFitIndicator fit={model.fit} label={model.fitLabel} />
				<span className="text-muted-foreground">
					{model.quant} · {model.size}
				</span>
			</div>
		</button>
	);
}

export interface QuantFileData {
	fit: ModelFit;
	fitLabel: string;
	progressLabel?: string;
	quant: string;
	size: string;
	state?: "available" | "installing" | "installed";
}

/** A single quant-file row in the model detail panel. */
export function QuantFileRow({
	file,
	onInstall,
}: {
	file: QuantFileData;
	onInstall?: () => void;
}) {
	const tooBig = file.fit === "too_big";
	let action: React.ReactNode;
	if (file.state === "installing") {
		action = (
			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<Spinner className="size-3.5" /> {file.progressLabel ?? "Installing…"}
			</span>
		);
	} else if (file.state === "installed") {
		action = (
			<Badge variant="secondary">
				<HugeiconsIcon className="size-3.5" icon={CheckmarkCircle02Icon} />
				Installed
			</Badge>
		);
	} else {
		action = (
			<Button disabled={tooBig} onClick={onInstall} size="sm" variant="ghost">
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				Install
			</Button>
		);
	}

	return (
		<div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
			<span className="font-mono">{file.quant}</span>
			<span className="text-muted-foreground">{file.size}</span>
			<ModelFitIndicator
				className="ml-2"
				fit={file.fit}
				label={file.fitLabel}
			/>
			<div className="ml-auto">{action}</div>
		</div>
	);
}
