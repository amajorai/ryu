import {
	CheckmarkCircle02Icon,
	InformationCircleIcon,
	Layers01Icon,
	LinkSquare02Icon,
	Rocket01Icon,
	SourceCodeIcon,
	UserIcon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageLightbox } from "@ryu/blocks/desktop/agent-elements/image-lightbox.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingInfoGrid,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { type ReactNode, useMemo, useRef, useState } from "react";
import type {
	DetailRunnable,
	DetailSetupStep,
	MarketplaceDetail,
} from "@/src/lib/api/marketplace.ts";
import { externalLinks } from "./DetailSections.tsx";

export function ScreenshotGallery({
	screenshots,
	name,
	onOpenChange,
}: {
	screenshots: string[];
	name: string;
	onOpenChange: (open: boolean) => void;
}) {
	const tl = useLiteralMessages();
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
	const lightboxOriginRef = useRef<HTMLElement | null>(null);
	const safeScreenshots = useMemo(
		() =>
			screenshots
				.map((url) => safeMediaUrl(url))
				.filter((url): url is string => Boolean(url)),
		[screenshots]
	);
	const images = useMemo(
		() =>
			safeScreenshots.map((url, i) => ({
				id: `${i}`,
				url,
				filename: `${name} screenshot ${i + 1}`,
			})),
		[safeScreenshots, name]
	);

	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Screenshots</h3>
			<div className="scroll-fade-x flex gap-3 overflow-x-auto pb-2">
				{safeScreenshots.map((url, i) => (
					<button
						className="shrink-0 overflow-hidden rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						key={url}
						onClick={(event) => {
							lightboxOriginRef.current = event.currentTarget;
							setLightboxIndex(i);
							onOpenChange(true);
						}}
						type="button"
					>
						<img
							alt={tl("{name} screenshot {number}", {
								name,
								number: String(i + 1),
							})}
							className="h-40 w-auto object-cover"
							loading="lazy"
							src={url}
						/>
					</button>
				))}
			</div>
			<ImageLightbox
				images={images}
				initialIndex={lightboxIndex ?? 0}
				onClose={() => {
					setLightboxIndex(null);
					onOpenChange(false);
				}}
				open={lightboxIndex !== null}
				originRef={lightboxOriginRef}
			/>
		</section>
	);
}

/** The "Setup" section: one card per companion/config step, each with an optional
 *  external action button. */
export function SetupSection({ steps }: { steps: DetailSetupStep[] }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Rocket01Icon}
				/>
				Setup
			</h3>
			<ul className="flex flex-col gap-2">
				{steps.map((step, i) => (
					<li
						className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3"
						key={step.title ?? step.actionUrl ?? `step-${i}`}
					>
						<div className="min-w-0 flex-1">
							{step.title ? (
								<p className="font-medium text-sm">{step.title}</p>
							) : null}
							{step.description ? (
								<p className="mt-0.5 text-muted-foreground text-sm">
									{step.description}
								</p>
							) : null}
						</div>
						{step.actionUrl ? (
							// Base UI: `render=`, not an `asChild` child (same rule as the
							// header CTA above) — otherwise this is an <a> inside a <button>.
							<Button
								nativeButton={false}
								render={
									<a
										href={step.actionUrl}
										rel="noopener noreferrer"
										target="_blank"
									/>
								}
								size="sm"
								variant="ghost"
							>
								{step.actionLabel || "Open"}
								<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
							</Button>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}

/** Icon for a bundled runnable, keyed by its `kind`. */
export function runnableIcon(kind: string): IconSvgElement {
	switch (kind.toLowerCase()) {
		case "skill":
			return SourceCodeIcon;
		case "tool":
			return Wrench01Icon;
		case "agent":
			return Rocket01Icon;
		default:
			return Layers01Icon;
	}
}

/** The "Skills N" section: bundled runnables with a name, description, and a
 *  toggle reflecting their enable state. The toggle is a read-only preview
 *  affordance (disabled) but is labelled for screen readers. */
export function RunnablesSection({
	runnables,
}: {
	runnables: DetailRunnable[];
}) {
	const tl = useLiteralMessages();
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Layers01Icon}
				/>
				{tl("Skills {count}", {
					count: formatCount(runnables.length) ?? "—",
				})}
			</h3>
			<ul className="flex flex-col gap-2">
				{runnables.map((r) => (
					<li
						className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3"
						key={r.id}
					>
						<div className="flex min-w-0 flex-1 items-start gap-2.5">
							<HugeiconsIcon
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								icon={runnableIcon(r.kind)}
							/>
							<div className="min-w-0">
								<p className="truncate font-medium text-sm" title={r.name}>
									{r.name}
								</p>
								{r.description ? (
									<p className="mt-0.5 text-muted-foreground text-xs">
										{r.description}
									</p>
								) : null}
							</div>
						</div>
						<Switch
							aria-label={tl("{name} enabled", { name: r.name })}
							checked={r.enabled}
							disabled
						/>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The "Information" block: a two-column key/value list of capabilities,
 *  developer, category, and version, followed by the listing's external links
 *  rendered as external-link icons. Each row renders only when its value exists. */
export function InformationBlock({ detail }: { detail: MarketplaceDetail }) {
	const rows: { label: string; icon: IconSvgElement; value: ReactNode }[] = [];
	if (detail.capabilities.length > 0) {
		rows.push({
			label: "Capabilities",
			icon: CheckmarkCircle02Icon,
			value: (
				<span className="flex flex-wrap justify-end gap-1">
					{detail.capabilities.map((c) => (
						<Badge key={c} typography="caption" variant="secondary">
							{c}
						</Badge>
					))}
				</span>
			),
		});
	}
	if (detail.developer) {
		rows.push({
			label: "Developer",
			icon: UserIcon,
			value: detail.developer,
		});
	}
	if (detail.category) {
		rows.push({
			label: "Category",
			icon: Layers01Icon,
			value: detail.category,
		});
	}
	if (detail.version) {
		rows.push({
			label: "Version",
			icon: InformationCircleIcon,
			value: detail.version,
		});
	}
	if (detail.languagePack) {
		rows.push({
			label: "Language",
			icon: InformationCircleIcon,
			value: `${detail.languagePack.locale} · ${detail.languagePack.baseLocale} · ${detail.languagePack.direction.toUpperCase()} · ${detail.languagePack.messageCount} strings`,
		});
	}

	const links = externalLinks(detail);
	if (rows.length === 0 && links.length === 0) {
		return null;
	}

	// Rendered inside the collapsed preview's advanced section. The information
	// stays available for trust/install decisions without leading every listing
	// with a long metadata rail.
	return (
		<ListingAsideCard title="Information">
			<ListingInfoGrid
				rows={[
					...rows.map((row) => ({ label: row.label, value: row.value })),
					...(links.length > 0
						? [
								{
									label: "Links",
									value: (
										<span className="flex items-center justify-end gap-1">
											{links.map((link) => (
												<a
													aria-label={link.label}
													className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
													href={link.href}
													key={link.href}
													rel="noopener noreferrer"
													target="_blank"
													title={link.label}
												>
													<HugeiconsIcon className="size-4" icon={link.icon} />
												</a>
											))}
										</span>
									),
								},
							]
						: []),
				]}
			/>
		</ListingAsideCard>
	);
}
