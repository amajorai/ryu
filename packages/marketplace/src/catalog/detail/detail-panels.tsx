import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
// packages/marketplace/src/catalog/detail/detail-panels.tsx
//
// The remaining detail tabs — README, Versions, Dependencies — plus the metadata
// strip that sits under the listing's name.
//
// These are deliberately small and data-shaped. Each renders exactly what the
// catalog reported and says so plainly when a source reported nothing, rather
// than fabricating a plausible-looking blank ("0 downloads" for a source that
// does not count downloads is a lie, "not reported" is not).

import {
	Calendar01Icon,
	ComputerIcon,
	Download01Icon,
	Link01Icon,
	SquareLock01Icon,
	Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";
import type { ComponentType } from "react";
import { useState } from "react";
import { grantDescription, grantLabel } from "../grant-labels.ts";
import { safeHttpUrl } from "../safe-url.ts";
import { versionStabilityLabel } from "../stability.ts";
import { surfaceLabel } from "../surface-labels.ts";
import type {
	CatalogEntry,
	CatalogVersion,
	PluginCatalogDetail,
	VersionSnapshot,
} from "../types.ts";
import { catalogLayerLabel } from "../types.ts";
import { RequiredPluginsSection } from "./dependency-graph.tsx";

/** Render an ISO timestamp as a short absolute date. Absolute rather than
 *  relative on purpose: "2 years ago" is the health tab's job, a version table
 *  wants the date it actually shipped. */
export function formatDate(iso?: string | null): string | null {
	if (!iso) {
		return null;
	}
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** Shared count policy for store metadata and version rows. */
export function formatCount(value: number): string {
	return formatSharedCount(value) ?? "—";
}

/** One item in the strip under the listing name. */
function MetaItem({
	icon,
	label,
	value,
}: {
	icon: typeof Tag01Icon;
	label: string;
	value: string;
}) {
	return (
		<span
			className="inline-flex items-center gap-1.5 text-muted-foreground text-xs"
			title={label}
		>
			<HugeiconsIcon className="size-3.5" icon={icon} />
			{value}
		</span>
	);
}

/**
 * The metadata strip: current version, when it last changed, how many times it
 * has been downloaded, and which surfaces it runs on.
 *
 * Every item is conditional. A listing that reports none of them renders nothing
 * at all rather than a row of dashes.
 */
/** NOT MOUNTED ANY MORE. The listing detail's meta facts are now the divided
 *  cells of `listing-detail-shell.tsx`'s {@link ListingStatStrip}, which is what
 *  a wide dialog needs — this inline flex-wrap row read as a single ribbon of
 *  grey text where the store's headline facts belong. Kept because it is still
 *  the right shape for a NARROW, non-dialog surface (a card back, a hover
 *  preview); if you are adding facts to the listing dialog, add a stat cell
 *  instead, and delete this once something proves it has no such caller. */
export function DetailMetaStrip({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}) {
	const version = detail?.version ?? entry.version ?? null;
	const updated = formatDate(detail?.updatedAt);
	const created = formatDate(detail?.createdAt);
	const downloads = detail?.downloads ?? null;
	// Fall back to the CARD's surfaces when the detail fetch has not landed (or the
	// source serves no detail at all). This is load-bearing now that the card no
	// longer shows the badges itself: without the fallback, "which platforms does
	// this run on?" would be unanswerable anywhere for a descriptor-only listing.
	const surfaces = detail?.surfaces ?? entry.surfaces ?? [];

	const items = [
		version
			? {
					icon: Tag01Icon,
					label: "Current version",
					value: `v${version.replace(/^v/, "")}`,
				}
			: null,
		updated
			? {
					icon: Calendar01Icon,
					label: "Last updated",
					value: `Updated ${updated}`,
				}
			: null,
		created
			? {
					icon: Calendar01Icon,
					label: "First published",
					value: `Created ${created}`,
				}
			: null,
		isNativeNumber(downloads)
			? {
					icon: Download01Icon,
					label: "Downloads",
					value: `${formatCount(downloads)} downloads`,
				}
			: null,
	].filter((item): item is Exclude<typeof item, null> => Boolean(item));

	if (items.length === 0 && surfaces.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
			{items.map((item) => (
				<MetaItem
					icon={item.icon}
					key={item.label}
					label={item.label}
					value={item.value}
				/>
			))}
			{surfaces.length > 0 ? (
				<span className="inline-flex items-center gap-1.5">
					<HugeiconsIcon
						className="size-3.5 text-muted-foreground"
						icon={ComputerIcon}
					/>
					{surfaces.map((surface) => (
						<Badge key={surface} variant="outline">
							{surfaceLabel(surface)}
						</Badge>
					))}
				</span>
			) : null}
		</div>
	);
}

/** The README tab. Markdown rendering crosses the host seam (desktop renders
 *  with Streamdown, web with react-markdown), so the component is passed in. */
export function ReadmePanel({
	Markdown,
	readme,
	readmeUrl,
}: {
	Markdown: ComponentType<{ className?: string; content: string }>;
	readme: string;
	readmeUrl?: string | null;
}) {
	const href = safeHttpUrl(readmeUrl);
	return (
		<div className="flex flex-col gap-3">
			<Markdown
				className="prose prose-sm dark:prose-invert max-w-none"
				content={readme}
			/>
			{href ? (
				<a
					className="inline-flex items-center gap-1.5 text-muted-foreground text-xs hover:underline"
					href={href}
					rel="noopener noreferrer"
					target="_blank"
				>
					<HugeiconsIcon className="size-3.5" icon={Link01Icon} />
					Read the original
				</a>
			) : null}
		</div>
	);
}

/** The Versions tab: published version history, newest first. */
/** One version row's expandable "as published" snapshot.
 *
 *  Fetched lazily on expand, never up front: a listing can carry 20 versions and
 *  eagerly reading each one's manifest and README would be 40 network round-trips
 *  to render a tab nobody may open. */
function VersionSnapshotRow({
	tag,
	fetchVersionDetail,
}: {
	tag: string;
	fetchVersionDetail: (tag: string) => Promise<VersionSnapshot | null>;
}) {
	const [state, setState] = useState<
		| { status: "idle" }
		| { status: "loading" }
		| { status: "empty" }
		| { status: "ready"; snapshot: VersionSnapshot }
	>({ status: "idle" });

	const load = async () => {
		if (state.status !== "idle") {
			return;
		}
		setState({ status: "loading" });
		try {
			const snapshot = await fetchVersionDetail(tag);
			setState(snapshot ? { snapshot, status: "ready" } : { status: "empty" });
		} catch {
			// A tag with no readable manifest is the NORMAL case for tags predating
			// the listing being packaged — not an error worth shouting about.
			setState({ status: "empty" });
		}
	};

	if (state.status === "idle") {
		return (
			<button
				className="mt-1 text-muted-foreground text-xs hover:underline"
				onClick={load}
				type="button"
			>
				Show what shipped in this version
			</button>
		);
	}
	if (state.status === "loading") {
		return <p className="mt-1 text-muted-foreground text-xs">Reading tag…</p>;
	}
	if (state.status === "empty") {
		return (
			<p className="mt-1 text-muted-foreground text-xs">
				No manifest published at this tag.
			</p>
		);
	}

	const { snapshot } = state;
	const facts = [
		snapshot.description ? `“${snapshot.description}”` : null,
		`Stability: ${versionStabilityLabel(
			snapshot.stability,
			snapshot.stabilityKnown === true,
			false
		)}`,
		snapshot.license ? `Licence: ${snapshot.license}` : null,
		snapshot.engines?.ryu ? `Requires Ryu ${snapshot.engines.ryu}` : null,
		snapshot.surfaceSupport?.length
			? `Support: ${snapshot.surfaceSupport
					.map((surface) => surfaceLabel(surface.surface))
					.join(", ")}`
			: null,
		snapshot.readme
			? `README: ${Math.round(snapshot.readme.length / 100) / 10}k chars`
			: "No README at this tag",
	].filter((fact): fact is string => Boolean(fact));

	return (
		<div className="mt-2 flex flex-col gap-1 rounded-md bg-muted/40 px-2.5 py-2">
			{facts.map((fact) => (
				<p className="text-muted-foreground text-xs leading-relaxed" key={fact}>
					{fact}
				</p>
			))}
			{/* The honesty line. Only repo-resident signals are historical; stars,
			    issues and the archived flag are reported as of NOW and cannot be
			    reconstructed for a past tag, so this panel must never imply it is
			    showing a full health grade for that version. */}
			<p className="type-caption text-muted-foreground/70 leading-relaxed">
				Read from the repository at this tag. Repository stats (stars, issues,
				activity) always reflect today, not this release.
			</p>
		</div>
	);
}

function HistoricalVersionInstallAction({
	isCurrent,
	onInstall,
	version,
}: {
	isCurrent: boolean;
	onInstall: (version: CatalogVersion) => Promise<void>;
	version: CatalogVersion;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [state, setState] = useState<
		"idle" | "installing" | "installed" | "error"
	>("idle");
	const [error, setError] = useState<string | null>(null);
	const older = !isCurrent;

	const install = async () => {
		setConfirmOpen(false);
		setState("installing");
		setError(null);
		try {
			await onInstall(version);
			setState("installed");
		} catch (cause) {
			setState("error");
			setError(cause instanceof Error ? cause.message : "Install failed");
		}
	};

	if (state === "installed") {
		return (
			<span className="text-status-success text-xs" role="status">
				Installed {version.version}
			</span>
		);
	}

	const button = (
		<Button
			aria-label={`Install ${version.version}`}
			loading={state === "installing"}
			onClick={() => {
				if (older) {
					setConfirmOpen(true);
					return;
				}
				install().catch(() => undefined);
			}}
			size="sm"
			variant="ghost"
		>
			<HugeiconsIcon className="size-3.5" icon={Download01Icon} />
			Install this version
		</Button>
	);

	return (
		<div className="flex flex-col items-end gap-1">
			{button}
			{error ? (
				<p className="max-w-56 text-right text-status-destructive text-xs">
					{error}
				</p>
			) : null}
			<AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Install {version.version}?</AlertDialogTitle>
						<AlertDialogDescription>
							This is an older Marketplace release. Ryu will verify and install
							this exact version; it will not silently substitute the latest
							build.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={() => install().catch(() => undefined)}>
							Install version
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

export function VersionsPanel({
	versions,
	fetchVersionDetail,
	installVersion,
}: {
	versions: NonNullable<PluginCatalogDetail["versions"]>;
	/** Host-supplied reader for one version's snapshot. Injected because this
	 *  package is host-agnostic — the desktop talks to Core, the web host has no
	 *  such endpoint and simply omits it, which hides the affordance entirely. */
	fetchVersionDetail?: (tag: string) => Promise<VersionSnapshot | null>;
	/** Exact-version install/update action. Omitted for read-only or browse-only
	 *  surfaces. */
	installVersion?: (version: CatalogVersion) => Promise<void>;
}) {
	return (
		<ul className="flex flex-col gap-1.5">
			{versions.map((version, index) => {
				const href = safeHttpUrl(version.url);
				const published = formatDate(version.publishedAt);
				return (
					<li className="rounded-md bg-muted px-3 py-2" key={version.version}>
						<div className="flex flex-wrap items-baseline gap-2">
							<span className="font-medium font-mono text-sm">
								{version.version}
							</span>
							{index === 0 ? <Badge variant="secondary">Current</Badge> : null}
							{version.prerelease ||
							version.stability ||
							version.stabilityKnown !== undefined ? (
								<Badge variant="outline">
									{versionStabilityLabel(
										version.stability,
										version.stabilityKnown === true,
										version.prerelease === true
									)}
								</Badge>
							) : null}
							{version.tagOnly ? (
								<Badge variant="outline">Tag only</Badge>
							) : null}
							<span className="ml-auto flex items-center gap-3 text-muted-foreground text-xs">
								{isNativeNumber(version.downloads) && version.downloads > 0 ? (
									<span>{formatCount(version.downloads)} downloads</span>
								) : null}
								{published ? <span>{published}</span> : null}
							</span>
						</div>
						{installVersion &&
						!version.tagOnly &&
						version.installable !== false ? (
							<HistoricalVersionInstallAction
								isCurrent={index === 0}
								onInstall={installVersion}
								version={version}
							/>
						) : null}
						{version.notes ? (
							<p className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed">
								{version.notes}
							</p>
						) : null}
						{href ? (
							<a
								className="mt-1 inline-block text-muted-foreground text-xs hover:underline"
								href={href}
								rel="noopener noreferrer"
								target="_blank"
							>
								View release
							</a>
						) : null}
						{fetchVersionDetail ? (
							<div>
								<VersionSnapshotRow
									fetchVersionDetail={fetchVersionDetail}
									tag={version.version}
								/>
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/** True when there is anything to put on a Dependencies tab. */
export function hasDependencies(
	detail: PluginCatalogDetail | null,
	entry: CatalogEntry
): boolean {
	const requires = detail?.requires ?? entry.requires ?? null;
	const layers = detail?.layers?.length ? detail.layers : (entry.layers ?? []);
	return Boolean(
		requires?.apps?.length ||
			requires?.grants?.length ||
			detail?.permissionGrants?.length ||
			detail?.engines?.ryu ||
			detail?.apiSurface?.provides?.length ||
			layers.length
	);
}

/**
 * The Dependencies tab: what must be present for this plugin to work.
 *
 * Three different kinds of dependency live here on purpose — other plugins, the
 * permissions it needs granted, and the Core version it needs — because from the
 * reader's side they are the same question: what else does installing this drag
 * in?
 */
export function DependenciesPanel({
	detail,
	entry,
	showTechnical = true,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
	/** Show the machine-readable half: the raw grant id beside its label, the
	 *  engine semver range, the capability strings this plugin publishes.
	 *
	 *  The plain-English grant LABEL and DESCRIPTION are never gated by this.
	 *  `grant-labels.ts` exists so a non-technical user understands what they are
	 *  approving, and hiding that from the least-technical audience would be a
	 *  security regression dressed as simplification — only the identifier goes. */
	showTechnical?: boolean;
}) {
	const requires = detail?.requires ?? entry.requires ?? null;
	const apps = requires?.apps ?? [];
	const grants = detail?.permissionGrants?.length
		? detail.permissionGrants
		: (requires?.grants ?? []);
	const engineReq = detail?.engines?.ryu ?? null;
	const layers = detail?.layers?.length ? detail.layers : (entry.layers ?? []);

	return (
		<div className="flex flex-col gap-6">
			{/* Resolves the declared ids into the tree Core walks, with each entry's
			    live install/enable state when the host can supply it — see
			    dependency-graph.tsx. Renders nothing when nothing is declared. */}
			<RequiredPluginsSection
				apps={apps}
				showTechnical={showTechnical}
				subjectId={entry.id}
				subjectName={entry.name}
			/>

			{grants.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="flex items-center gap-1.5 font-medium text-sm">
						<HugeiconsIcon
							className="size-4 text-muted-foreground"
							icon={SquareLock01Icon}
						/>
						Requires these permissions
					</h3>
					<ul className="flex flex-col gap-1.5">
						{grants.map((grant) => (
							<li className="rounded-md bg-muted px-3 py-2" key={grant}>
								<div className="flex items-baseline justify-between gap-3">
									<span className="min-w-0 truncate text-sm">
										{grantLabel(grant)}
									</span>
									{showTechnical ? (
										<code className="shrink-0 truncate font-mono text-muted-foreground text-xs">
											{grant}
										</code>
									) : null}
								</div>
								<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
									{grantDescription(grant)}
								</p>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{engineReq && showTechnical ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Requires Ryu</h3>
					<p className="text-muted-foreground text-sm">
						This plugin declares it needs Ryu{" "}
						<code className="font-mono">{engineReq}</code>. An incompatible node
						refuses to load it rather than failing at runtime.
					</p>
				</section>
			) : null}

			{layers.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Swappable layer</h3>
					<ul className="flex flex-col gap-1.5">
						{layers.map((layer) => (
							<li
								className="rounded-md bg-muted px-3 py-2"
								key={layer.capability}
							>
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="outline">{catalogLayerLabel(layer)}</Badge>
									{layer.target ? (
										<span className="text-muted-foreground text-xs">
											{layer.target === "remote-desktop"
												? "Hosted provider"
												: "Local provider"}
										</span>
									) : null}
								</div>
								{showTechnical && layer.verbs?.length ? (
									<p className="mt-1 text-muted-foreground text-xs">
										Verbs: {layer.verbs.join(", ")}
									</p>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{detail?.apiSurface?.provides?.length && showTechnical ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Provides to other plugins</h3>
					<ul className="flex flex-col gap-1.5">
						{detail.apiSurface.provides.map((entryProvides) => (
							<li
								className="rounded-md bg-muted px-3 py-2 text-sm"
								key={entryProvides.capability}
							>
								<code className="font-mono">{entryProvides.capability}</code>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}
