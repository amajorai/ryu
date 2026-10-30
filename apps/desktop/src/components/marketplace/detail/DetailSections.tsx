import {
	ArrowDown01Icon,
	LegalDocument01Icon,
	LinkSquare02Icon,
	MoreHorizontalIcon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useState } from "react";
import type {
	MarketplaceDetail,
	MarketplaceKind,
} from "@/src/lib/api/marketplace.ts";
import {
	InformationBlock,
	RunnablesSection,
	ScreenshotGallery,
	SetupSection,
} from "./DetailMedia.tsx";
import { ReviewsSection } from "./DetailReviews.tsx";

export function BundleContents({
	detail,
	onInstall,
	installing,
}: {
	detail: MarketplaceDetail;
	onInstall?: () => void;
	installing: boolean;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Bundle contents</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						These existing Marketplace items install through their own trusted
						kind-specific paths.
					</p>
					{detail.bundleSourceUrl ? (
						<a
							className="mt-2 inline-block text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground"
							href={detail.bundleSourceUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							View topic source
						</a>
					) : null}
				</div>
				{onInstall ? (
					<Button
						loading={installing}
						onClick={onInstall}
						size="sm"
						variant="outline"
					>
						Install bundle
					</Button>
				) : null}
			</div>
			{detail.bundleMembers.length > 0 ? (
				<ul className="flex flex-col">
					{detail.bundleMembers.map((member) => (
						<li
							className="flex min-h-12 min-w-0 items-center justify-between gap-3 border-border border-b py-2 last:border-b-0"
							key={`${member.kind}:${member.id}`}
						>
							<div className="min-w-0">
								<p className="truncate font-medium text-sm">
									{member.name ?? member.id}
								</p>
								<p className="truncate text-muted-foreground text-xs">
									{member.kind} · {member.id}
								</p>
							</div>
							<Badge variant={member.required ? "secondary" : "outline"}>
								{member.required ? "Required" : "Optional"}
							</Badge>
						</li>
					))}
				</ul>
			) : (
				<p className="text-muted-foreground text-sm">
					No installable members are declared for this bundle.
				</p>
			)}
		</section>
	);
}

/** Progressive disclosure for listing metadata, setup, bundled skills, and
 * reviews. The preview answers "what is this?" first; operators can still open
 * the complete trust/install context without making every listing a long form. */
export function MarketplacePreviewDetails({
	detail,
	id,
	kind,
	onScreenshotOpenChange,
}: {
	detail: MarketplaceDetail;
	id: string;
	kind: MarketplaceKind;
	onScreenshotOpenChange: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	// Every listing has a reviews surface, even when optional metadata is absent.

	return (
		<section className="border-border border-t pt-4">
			<button
				aria-expanded={open}
				className="flex w-full items-center justify-between gap-3 text-left text-muted-foreground text-sm transition-colors hover:text-foreground"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<span>More details</span>
				<HugeiconsIcon
					className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
					icon={ArrowDown01Icon}
				/>
			</button>
			{open ? (
				<div className="mt-4 flex flex-col gap-6">
					{detail.screenshots.length > 0 ? (
						<ScreenshotGallery
							name={detail.name}
							onOpenChange={onScreenshotOpenChange}
							screenshots={detail.screenshots}
						/>
					) : null}
					{detail.setup.length > 0 ? (
						<SetupSection steps={detail.setup} />
					) : null}
					{detail.runnables.length > 0 ? (
						<RunnablesSection runnables={detail.runnables} />
					) : null}
					<InformationBlock detail={detail} />
					<ReviewsSection id={id} kind={kind} />
				</div>
			) : null}
		</section>
	);
}

/** Overflow (...) menu holding the listing's external links. Renders nothing when
 *  the listing carries no links. */
export function OverflowMenu({ detail }: { detail: MarketplaceDetail }) {
	const links = externalLinks(detail);
	if (links.length === 0) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button aria-label="More options" size="icon-sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{links.map((link) => (
					<DropdownMenuItem
						key={link.href}
						render={
							<a href={link.href} rel="noopener noreferrer" target="_blank">
								<HugeiconsIcon className="size-4" icon={link.icon} />
								{link.label}
							</a>
						}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export interface ExternalLink {
	href: string;
	icon: IconSvgElement;
	label: string;
}

/** The listing's external links (website / privacy / terms), in display order,
 *  filtered to those actually present. */
export function externalLinks(detail: MarketplaceDetail): ExternalLink[] {
	const links: ExternalLink[] = [];
	if (detail.website) {
		links.push({
			href: detail.website,
			icon: LinkSquare02Icon,
			label: "Website",
		});
	}
	if (detail.privacyPolicyUrl) {
		links.push({
			href: detail.privacyPolicyUrl,
			icon: Shield01Icon,
			label: "Privacy Policy",
		});
	}
	if (detail.termsOfServiceUrl) {
		links.push({
			href: detail.termsOfServiceUrl,
			icon: LegalDocument01Icon,
			label: "Terms of Service",
		});
	}
	return links;
}

export function DetailLogo({
	iconUrl,
	name,
}: {
	iconUrl: string | null;
	name: string;
}) {
	const tl = useLiteralMessages();
	const safeIconUrl = safeMediaUrl(iconUrl);
	// Fills the hero's icon tile rather than sizing itself: the tile owns the box,
	// the radius and the ring, so every realm's hero art is the same square.
	if (safeIconUrl) {
		return (
			<img
				alt={tl("{name} logo", { name })}
				className="size-full object-cover"
				src={safeIconUrl}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="font-medium text-2xl text-foreground uppercase"
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}
