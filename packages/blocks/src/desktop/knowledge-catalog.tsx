"use client";

// Presentational leaf components shared by the desktop Knowledge catalog. A
// "knowledge bundle" is an Open Knowledge Format (OKF) directory of markdown
// concepts shipped from a git source; this catalog browses and installs those
// bundles into the retrieval index. As with the Skills catalog, the live section
// (`apps/desktop/src/components/store/KnowledgeCatalogSection.tsx`) owns the
// hook-coupled master-detail orchestration (fetch, infinite scroll, install
// progress) — this block extracts the genuinely presentational pieces that BOTH
// the real section and the storyboard render: the bundle master-list row, the
// install/active status affordance, and a grid card for non-master-detail layouts.
//
// Pure and props-driven — no data hooks, no Core fetch logic. The live percent is
// computed at the call site (via the desktop `useInstallProgress` hook) and passed
// into the shared InstallProgressButton.

import {
	Book02Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Switch } from "@ryu/ui/components/switch";
import { useId } from "react";
import { InstallProgressButton } from "./install-button.tsx";

/** Cap on how many tag chips render inline before collapsing to a "+N" count. */
const MAX_INLINE_TAGS = 3;

export interface KnowledgeListRowData {
	/** Whether the installed bundle is indexed/active for retrieval. Only
	 *  meaningful when installed; null hides the active badge. */
	active?: boolean | null;
	id: string;
	installed: boolean;
	/** Source/owner line, e.g. a repo slug or host like "github.com/acme/kb". */
	source: string;
	/** OKF tags drawn from the bundle's concepts; rendered as chips. */
	tags?: string[];
	/** Display title of the bundle. */
	title: string;
}

/** Render up to {@link MAX_INLINE_TAGS} tag chips, collapsing the rest to "+N". */
function TagChips({ tags }: { tags: string[] }) {
	if (tags.length === 0) {
		return null;
	}
	const inline = tags.slice(0, MAX_INLINE_TAGS);
	const overflow = tags.length - inline.length;
	return (
		<div className="mt-1 flex flex-wrap items-center gap-1">
			{inline.map((tag) => (
				<Badge className="gap-1 font-normal" key={tag} variant="outline">
					<HugeiconsIcon className="size-2.5" icon={Tag01Icon} />
					{tag}
				</Badge>
			))}
			{overflow > 0 ? (
				<span className="text-muted-foreground text-xs">+{overflow}</span>
			) : null}
		</div>
	);
}

/**
 * The compact install/active indicator shown at the end of a master-list row.
 * Returns nothing until installed; once installed, an explicit active flag picks
 * the "Indexed"/"Installed" badge, while a null flag degrades to a check icon.
 */
function RowStatus({
	installed,
	active,
}: {
	installed: boolean;
	active?: boolean | null;
}) {
	if (!installed) {
		return null;
	}
	if (active === true) {
		return <Badge variant="secondary">Indexed</Badge>;
	}
	if (active === false) {
		return <Badge variant="outline">Installed</Badge>;
	}
	return (
		<HugeiconsIcon
			aria-label="Installed"
			className="size-3.5 shrink-0 text-emerald-500"
			icon={CheckmarkCircle02Icon}
		/>
	);
}

/** A knowledge-bundle master-list row: title, install state, source, tags. */
export function KnowledgeListRow({
	bundle,
	selected,
	onSelect,
}: {
	bundle: KnowledgeListRowData;
	selected?: boolean;
	onSelect?: () => void;
}) {
	return (
		<button
			className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
				selected ? "bg-accent" : "hover:bg-accent/50"
			}`}
			onClick={onSelect}
			type="button"
		>
			<div className="flex items-center gap-1.5">
				<HugeiconsIcon
					className="size-3.5 shrink-0 text-muted-foreground"
					icon={Book02Icon}
				/>
				<span className="flex-1 truncate font-medium text-sm">
					{bundle.title}
				</span>
				<RowStatus active={bundle.active} installed={bundle.installed} />
			</div>
			<p className="truncate text-muted-foreground text-xs">{bundle.source}</p>
			{bundle.tags && bundle.tags.length > 0 ? (
				<TagChips tags={bundle.tags} />
			) : null}
		</button>
	);
}

/** The install / active-toggle affordance in the bundle detail header. */
export function KnowledgeInstallControl({
	installed,
	installing,
	percent = null,
	active = false,
	onInstall,
	onToggleActive,
}: {
	installed: boolean;
	installing?: boolean;
	/** Live completion 0–100 while installing, or null when size is unknown. */
	percent?: number | null;
	active?: boolean;
	onInstall?: () => void;
	onToggleActive?: (next: boolean) => void;
}) {
	const switchId = useId();
	if (!installed) {
		return (
			<InstallProgressButton
				installing={Boolean(installing)}
				onClick={onInstall}
				percent={percent}
			>
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				Install bundle
			</InstallProgressButton>
		);
	}
	return (
		<div className="flex shrink-0 items-center gap-3">
			<Badge className="gap-1" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-emerald-500"
					icon={CheckmarkCircle02Icon}
				/>
				Installed
			</Badge>
			<Switch
				aria-label={
					active ? "Remove from retrieval index" : "Index for retrieval"
				}
				checked={active}
				id={switchId}
				onCheckedChange={(v) => onToggleActive?.(v)}
			/>
			<label
				className="cursor-pointer text-muted-foreground text-xs"
				htmlFor={switchId}
			>
				{active ? "Indexed" : "Not indexed"}
			</label>
		</div>
	);
}

export interface KnowledgeCardData {
	active?: boolean | null;
	description: string;
	id: string;
	installed: boolean;
	/** Source/owner line for the bundle. */
	source: string;
	tags?: string[];
	title: string;
}

/**
 * A grid card for the Knowledge catalog when a master-detail layout is overkill:
 * title, source, description, tags, and an install affordance. Mirrors the Store
 * shell's StoreCatalogCard, specialized for OKF bundle metadata.
 */
export function KnowledgeCard({
	bundle,
	installing,
	percent = null,
	onInstall,
	onToggleActive,
}: {
	bundle: KnowledgeCardData;
	installing?: boolean;
	percent?: number | null;
	onInstall?: () => void;
	onToggleActive?: (next: boolean) => void;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
			<div className="flex items-center justify-between gap-2">
				<span className="flex min-w-0 items-center gap-1.5 font-medium">
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={Book02Icon}
					/>
					<span className="truncate">{bundle.title}</span>
				</span>
				<Badge variant="outline">OKF</Badge>
			</div>
			<p className="truncate text-muted-foreground text-xs">{bundle.source}</p>
			<p className="line-clamp-2 flex-1 text-muted-foreground text-sm">
				{bundle.description}
			</p>
			{bundle.tags && bundle.tags.length > 0 ? (
				<TagChips tags={bundle.tags} />
			) : null}
			<div className="mt-1 flex items-center gap-2">
				{bundle.installed ? (
					<>
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-emerald-500"
								icon={CheckmarkCircle02Icon}
							/>
							Installed
						</Badge>
						<Button
							className="ml-auto"
							onClick={() => onToggleActive?.(!bundle.active)}
							size="sm"
							variant="ghost"
						>
							{bundle.active ? "Unindex" : "Index"}
						</Button>
					</>
				) : (
					<InstallProgressButton
						className="self-start"
						installing={Boolean(installing)}
						onClick={onInstall}
						percent={percent}
					>
						{installing ? null : (
							<HugeiconsIcon className="size-4" icon={Download01Icon} />
						)}
						Install
					</InstallProgressButton>
				)}
			</div>
		</div>
	);
}
