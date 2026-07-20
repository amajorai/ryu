"use client";

// Presentational layer of the desktop Store → Engines section. The live app
// (`apps/desktop/src/components/store/EnginesCatalogSection.tsx`) is a thin
// container that loads engines via `useEngines()` / `useVoiceEngines()` and
// renders this view with real handlers; the storyboard renders the same
// components with mock data and no-op handlers. One source of truth, so editing
// this block changes the real desktop too.
//
// The two interaction models (Text = swap the resident engine; Image / Speech /
// Embeddings = start/stop alongside) are captured purely in props: every card
// receives its current state plus the relevant callbacks, and all transient
// per-row state (pending / error / gatewayStale) is lifted to the container.

import {
	Alert01Icon,
	CircleArrowUp01Icon,
	CpuIcon,
	Delete01Icon,
	Download01Icon,
	Loading01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button";
import type { ViewMode } from "@ryu/blocks/desktop/view-toggle";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import type { ReactNode } from "react";

export type EngineInstallState =
	| "installed"
	| "installing"
	| "failed"
	| "not_installed";

export type EnginePendingKind = "install" | "uninstall" | "toggle";

const noop = () => {
	// Default no-op handler for the presentational layer.
};

export function installStateBadge(state: EngineInstallState) {
	switch (state) {
		case "installed":
			return <Badge variant="secondary">Installed</Badge>;
		case "installing":
			return <Badge variant="secondary">Installing…</Badge>;
		case "failed":
			return <Badge variant="destructive">Install failed</Badge>;
		default:
			return <Badge variant="secondary">Not installed</Badge>;
	}
}

/** A modality group: a header and a grid of engine cards. */
export function ModalityGroup({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-muted-foreground text-sm">{title}</h3>
			{children}
		</section>
	);
}

export function EngineGrid({
	children,
	view = "grid",
}: {
	children: ReactNode;
	view?: ViewMode;
}) {
	if (view === "list") {
		return <div className="flex flex-col gap-1.5">{children}</div>;
	}
	return (
		<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
			{children}
		</div>
	);
}

export function EmptyGroupHint({ label }: { label: string }) {
	return (
		<p className="text-muted-foreground text-sm">
			No {label.toLowerCase()} engines available yet.
		</p>
	);
}

export function EngineGroupSpinner() {
	return (
		<div className="flex items-center justify-center py-6">
			<Spinner />
		</div>
	);
}

/** Card body shared by both card variants. */
export function EngineCardShell({
	displayName,
	description,
	installState,
	toggle,
	statusBadge,
	action,
	footer,
	view = "grid",
}: {
	displayName: string;
	description: string;
	installState: EngineInstallState;
	toggle: ReactNode;
	statusBadge: ReactNode;
	action: ReactNode;
	footer?: ReactNode;
	view?: ViewMode;
}) {
	if (view === "list") {
		return (
			<div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
				<HugeiconsIcon className="size-4 shrink-0 opacity-70" icon={CpuIcon} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium text-sm">{displayName}</span>
						{installStateBadge(installState)}
						{statusBadge}
					</div>
					<p className="truncate text-muted-foreground text-xs">
						{description}
					</p>
					{footer}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{action}
					{toggle}
				</div>
			</div>
		);
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center justify-between gap-2">
					<span className="flex items-center gap-2">
						<HugeiconsIcon className="size-4 opacity-70" icon={CpuIcon} />
						{displayName}
					</span>
					{toggle}
				</CardTitle>
				<CardDescription className="flex items-center gap-2">
					{installStateBadge(installState)}
					{statusBadge}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<p className="line-clamp-2 text-muted-foreground text-sm">
					{description}
				</p>
				{action}
				{footer}
			</CardContent>
		</Card>
	);
}

/** Install / uninstall button shared by both card variants. When an installed
 *  engine is behind the registry's latest version, an "Update" button appears
 *  next to Uninstall — updating is just a re-install to latest (idempotent),
 *  mirroring the Fleet service-row pattern (`SidecarActions` in `fleet.tsx`). */
export function EngineInstallButton({
	installState,
	pending,
	busy,
	disabledUninstall,
	percent = null,
	hasUpdate = false,
	onInstall = noop,
	onUninstall = noop,
}: {
	installState: EngineInstallState;
	pending: EnginePendingKind | null;
	busy: boolean;
	disabledUninstall: boolean;
	/** Live download progress 0–100 while installing, or null when unknown. */
	percent?: number | null;
	/** Installed version is behind latest — offer an Update (re-install to latest). */
	hasUpdate?: boolean;
	onInstall?: () => void;
	onUninstall?: () => void;
}) {
	if (installState === "installed") {
		return (
			<div className="flex items-center gap-2">
				{hasUpdate ? (
					<Button
						className="text-primary hover:text-primary"
						disabled={busy}
						onClick={onInstall}
						size="sm"
						variant="ghost"
					>
						{pending === "install" ? (
							<HugeiconsIcon
								className="size-4 animate-spin"
								icon={Loading01Icon}
							/>
						) : (
							<HugeiconsIcon className="size-4" icon={CircleArrowUp01Icon} />
						)}
						Update
					</Button>
				) : null}
				<Button
					disabled={busy || disabledUninstall}
					onClick={onUninstall}
					size="sm"
					variant="ghost"
				>
					{pending === "uninstall" ? (
						<HugeiconsIcon
							className="size-4 animate-spin"
							icon={Loading01Icon}
						/>
					) : (
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
					)}
					Uninstall
				</Button>
			</div>
		);
	}
	return (
		<InstallProgressButton
			disabled={busy}
			idleVariant="ghost"
			installing={pending === "install"}
			onClick={onInstall}
			percent={percent}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			Install
		</InstallProgressButton>
	);
}

/** Inline alert/error footer line shared by the engine cards. */
export function EngineFootnote({
	tone = "muted",
	children,
}: {
	tone?: "muted" | "amber" | "destructive";
	children: ReactNode;
}) {
	if (tone === "destructive") {
		return <p className="text-destructive text-xs">{children}</p>;
	}
	const className =
		tone === "amber"
			? "flex items-center gap-1.5 text-amber-600 text-xs dark:text-amber-500"
			: "flex items-center gap-1.5 text-muted-foreground text-xs";
	return (
		<p className={className}>
			<HugeiconsIcon className="size-3.5 shrink-0" icon={Alert01Icon} />
			{children}
		</p>
	);
}

/** Outer error state when the whole engines section fails to load. */
export function EnginesErrorState({ message }: { message: string }) {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={CpuIcon} />
				</EmptyMedia>
				<EmptyTitle>Could not load engines</EmptyTitle>
				<EmptyDescription>{message}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

/** A run-alongside (start/stop) toggle. */
export function EngineToggle({
	ariaLabel,
	checked,
	disabled,
	onToggle = noop,
}: {
	ariaLabel: string;
	checked: boolean;
	disabled: boolean;
	onToggle?: () => void;
}) {
	return (
		<Switch
			aria-label={ariaLabel}
			checked={checked}
			disabled={disabled}
			onCheckedChange={onToggle}
		/>
	);
}

/** The structural frame of the Engines section: scroll container + the modality
 *  groups in order. Embeddings are served by the resident text engine, so they
 *  share the "Text and Embedding" group rather than getting their own section.
 *  The container passes already-rendered group bodies so it keeps the
 *  hook-driven card logic, while the storyboard passes mock card grids. */
export function EnginesScreenFrame({
	text,
	image,
	speech,
	sandboxes,
	toolbar,
}: {
	text: ReactNode;
	image: ReactNode;
	speech: ReactNode;
	/** Optional code-execution sandbox backends group (default + detection). */
	sandboxes?: ReactNode;
	/** Optional controls (e.g. a grid/list view toggle) shown above the groups. */
	toolbar?: ReactNode;
}) {
	return (
		<div className="scroll-fade-effect-y h-full overflow-auto p-4">
			<div className="flex flex-col gap-6">
				{toolbar ? (
					<div className="flex items-center justify-end">{toolbar}</div>
				) : null}
				<ModalityGroup title="Text and Embedding">{text}</ModalityGroup>
				<ModalityGroup title="Image">{image}</ModalityGroup>
				<ModalityGroup title="Speech">{speech}</ModalityGroup>
				{sandboxes ? (
					<ModalityGroup title="Sandboxes">{sandboxes}</ModalityGroup>
				) : null}
			</div>
		</div>
	);
}
