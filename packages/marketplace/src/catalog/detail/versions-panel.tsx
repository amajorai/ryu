import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { safeHttpUrl } from "../safe-url.ts";
import { versionStabilityLabel } from "../stability.ts";
import { surfaceLabel } from "../surface-labels.ts";
import type {
	CatalogVersion,
	PluginCatalogDetail,
	VersionSnapshot,
} from "../types.ts";
import { formatCount, formatDate } from "./detail-format.ts";

/** The Versions tab: published version history, newest first. */
/** One version row's expandable "as published" snapshot.
 *
 *  Fetched lazily on expand, never up front: a listing can carry 20 versions and
 *  eagerly reading each one's manifest and README would be 40 network round-trips
 *  to render a tab nobody may open. */
export function VersionSnapshotRow({
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
		<div className="mt-2 flex flex-col gap-1 rounded-lg bg-muted px-3 py-2">
			{facts.map((fact) => (
				<p className="text-muted-foreground text-xs leading-relaxed" key={fact}>
					{fact}
				</p>
			))}
			{/* The honesty line. Only repo-resident signals are historical; stars,
			    issues and the archived flag are reported as of NOW and cannot be
			    reconstructed for a past tag, so this panel must never imply it is
			    showing a full health grade for that version. */}
			<p className="text-muted-foreground/70 text-xs">
				Read from the repository at this tag. Repository stats (stars, issues,
				activity) always reflect today, not this release.
			</p>
		</div>
	);
}

export function HistoricalVersionInstallAction({
	isCurrent,
	onInstall,
	version,
}: {
	isCurrent: boolean;
	onInstall: (version: CatalogVersion) => Promise<void>;
	version: CatalogVersion;
}) {
	const tl = useLiteralMessages();
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
				{tl("Installed {version}", { version: version.version })}
			</span>
		);
	}

	const button = (
		<Button
			aria-label={tl("Install {version}", { version: version.version })}
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
						<AlertDialogTitle>
							{tl("Install {version}?", { version: version.version })}
						</AlertDialogTitle>
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
	const tl = useLiteralMessages();
	return (
		<ul className="flex flex-col gap-1.5">
			{versions.map((version, index) => {
				const href = safeHttpUrl(version.url);
				const published = formatDate(version.publishedAt);
				return (
					<li className="rounded-lg bg-muted px-3 py-2" key={version.version}>
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
									<span>
										{tl("{count} downloads", {
											count: formatCount(version.downloads),
										})}
									</span>
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
