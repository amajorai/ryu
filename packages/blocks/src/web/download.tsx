import { useLiteralMessages } from "@ryu/i18n/react";
import { Button, buttonVariants } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import PageHeader from "@ryu/ui/components/page-header";
import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowUpRight,
	BookOpen,
	Cloud,
	Download,
	FlaskConical,
	Globe,
	History,
	Moon,
} from "lucide-react";
import { DOCS_URL } from "./data/resources.tsx";
import {
	archLabel,
	type DownloadArch,
	type DownloadOS,
	type DownloadState,
	findChannelRelease,
	GITHUB_REPO,
	osName,
	PRERELEASE_CHANNELS,
	type PrereleaseChannel,
	RELEASES_PAGE,
	type Release,
	resolveDownloadState,
} from "./download-assets.ts";
import {
	DOWNLOAD_HIGHLIGHTS,
	type DownloadPlatform,
	PLATFORMS,
	WEBAPP_URL,
} from "./download-catalog.tsx";
import { DownloadHero } from "./download-hero.tsx";
import { Reveal } from "./reveal.tsx";
import { Highlights } from "./sections.tsx";

// Asset resolution (which file a given machine gets, and where releases are
// fetched from) lives in the JSX-free ./download-assets.ts so it can be unit
// tested; re-exported here because every consumer imports from this module.

export * from "./download-assets.ts";

export {
	BROWSERS,
	browserName,
	buildDownloadUrl,
	type DownloadBrowser,
	type DownloadMobilePlatform,
	detectBrowser,
	EXTENSION_STORE_LISTINGS,
	extensionStoreUrl,
	hasExtensionListing,
	mobileStoreUrl,
	PLATFORMS,
	verifyDownloadUrl,
	WEBAPP_URL,
} from "./download-catalog.tsx";

/** The sub-label under an arch name, explaining what that row can offer. */
function archHintFor(state: DownloadState, arch: DownloadArch): string {
	if (state.kind === "building") {
		return `${state.version} is still building`;
	}
	if (state.kind === "unavailable") {
		return "Not available";
	}
	if (state.kind === "unknown") {
		return "Browse releases on GitHub";
	}
	const processors = arch === "arm" ? "ARM processors" : "Intel / AMD";
	// During a release window the newest tag has no binaries yet, so name the
	// version this button really hands over rather than implying it is the newest.
	return state.supersededByBuilding
		? `${processors} · ${state.servedVersion}`
		: processors;
}

function DownloadSettingRow({
	ariaLabel,
	downloadName,
	href,
	icon,
	label,
	meta,
	openInNewTab = false,
	status,
}: {
	ariaLabel?: string;
	downloadName?: string;
	href?: string;
	icon: React.ReactNode;
	label: string;
	meta?: string;
	openInNewTab?: boolean;
	status?: "building" | "disabled" | "ready" | "unavailable";
}) {
	const disabled =
		status === "building" ||
		status === "disabled" ||
		status === "unavailable" ||
		!href;
	const content = (
		<span className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
				{icon}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-sm" title={label}>
					{label}
				</span>
				{meta ? (
					<span className="mt-0.5 block truncate text-muted-foreground text-xs">
						{meta}
					</span>
				) : null}
			</span>
			{disabled ? (
				<span className="shrink-0 text-muted-foreground text-xs">
					{status === "building" ? "Building" : "Not available"}
				</span>
			) : openInNewTab ? (
				<ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
			) : (
				<Download className="size-4 shrink-0 text-muted-foreground" />
			)}
		</span>
	);

	if (disabled) {
		return (
			<div aria-disabled="true" className="mx-2">
				{content}
			</div>
		);
	}

	return (
		<a
			aria-label={ariaLabel}
			className="mx-2 block rounded-md outline-none transition-colors last:border-b-0 hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
			download={downloadName}
			href={href}
			rel={openInNewTab ? "noopener noreferrer" : undefined}
			target={openInNewTab ? "_blank" : undefined}
		>
			{content}
		</a>
	);
}

function PlatformCard({
	platform,
	releases,
}: {
	platform: DownloadPlatform;
	releases: Release[];
}) {
	return (
		<Card className="h-full" elevation="flat">
			<CardHeader>
				<div className="flex items-center gap-3">
					<span className="inline-flex size-10 items-center justify-center rounded-xl bg-muted">
						{platform.icon}
					</span>
					<div className="min-w-0">
						<CardTitle>{platform.name}</CardTitle>
						<CardDescription>{platform.description}</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent inset="none">
				{(["arm", "intel"] as const).map((arch) => {
					const state = resolveDownloadState(releases, platform.id, arch);
					const href =
						state.kind === "ready" || state.kind === "unknown"
							? state.kind === "ready"
								? state.asset.browser_download_url
								: state.href
							: undefined;
					return (
						<DownloadSettingRow
							downloadName={
								state.kind === "ready" ? state.asset.name : undefined
							}
							href={href}
							icon={<Download className="size-4" />}
							key={arch}
							label={archLabel(platform.id, arch)}
							meta={archHintFor(state, arch)}
							openInNewTab={state.kind === "unknown"}
							status={
								state.kind === "ready" || state.kind === "unknown"
									? "ready"
									: state.kind
							}
						/>
					);
				})}
			</CardContent>
		</Card>
	);
}

function SettingsSection({
	children,
	title,
}: {
	children: React.ReactNode;
	title: string;
}) {
	return (
		<section className="space-y-4">
			<PageHeader as="h2" title={title} />
			{children}
		</section>
	);
}

function PrereleaseSettingRows({
	channel,
	releases,
}: {
	channel: PrereleaseChannel;
	releases: Release[];
}) {
	const release = findChannelRelease(releases, channel);
	const scopedReleases = release ? [release] : [];

	return PLATFORMS.flatMap((platform) =>
		(["arm", "intel"] as const).map((arch) => {
			const state = resolveDownloadState(scopedReleases, platform.id, arch);
			const href =
				state.kind === "ready" || state.kind === "unknown"
					? state.kind === "ready"
						? state.asset.browser_download_url
						: state.href
					: undefined;
			return (
				<DownloadSettingRow
					downloadName={state.kind === "ready" ? state.asset.name : undefined}
					href={href}
					icon={platform.icon}
					key={`${channel}-${platform.id}-${arch}`}
					label={platform.name}
					meta={archLabel(platform.id, arch)}
					openInNewTab={state.kind === "unknown"}
					status={
						state.kind === "ready" || state.kind === "unknown"
							? "ready"
							: state.kind
					}
				/>
			);
		})
	);
}

export interface DownloadProps {
	/** All fetched releases, including rolling prerelease channels. */
	allReleases?: Release[];
	/** Detected architecture preference; the live page derives it from the user agent. */
	arch?: DownloadArch;
	/** Mobile gate; the live page derives it from the viewport. */
	isMobile?: boolean;
	/** Detected OS; the live page derives it from the user agent. */
	os?: DownloadOS;
	/** Releases fetched from GitHub; the live page fetches them, the storyboard passes static ones. */
	releases?: Release[];
	/**
	 * False while the releases fetch is still in flight.
	 *
	 * An empty `releases` means two different things — "not asked yet" and "asked
	 * and failed" — and the page must not announce the second while it is in the
	 * first. Without this the hero server-renders "Couldn't reach GitHub" on
	 * every load (crawlers included) and then flips once the fetch lands.
	 * Defaults to true so static callers like the storyboard are unaffected.
	 */
	releasesLoaded?: boolean;
}

/**
 * The real download page body, presentational. The live route
 * (apps/web/src/app/download/page-client.tsx) owns the releases fetch and the
 * useOS/useIsMobile hooks and passes the resolved values in; the storyboard
 * renders it with a static release list.
 *
 * The layout mirrors the marketing pages (centered hero with an eyebrow pill,
 * a primary CTA, Reveal-staggered cards, then a Highlights strip) so the
 * download surface reads as part of the same site, not a bolted-on page.
 */
export default function DownloadBlock({
	releases = [],
	allReleases = releases,
	arch = "intel",
	os = "macos",
	isMobile = false,
	releasesLoaded = true,
}: DownloadProps) {
	const tl = useLiteralMessages();
	// Nothing to say yet — not "GitHub is down". Hold the CTA back until we know,
	// exactly as an unresolved fetch used to.
	const pendingReleases = !releasesLoaded && releases.length === 0;
	// The newest release that actually HAS this platform's binary. A freshly
	// tagged release has no assets until its build finishes, so pointing the CTA
	// at `releases[0]` hands the user a dead link during every release window.
	const hero = resolveDownloadState(releases, os, arch);
	// The hero CTA always leads somewhere: a real installer when we have one, the
	// releases page otherwise. It is never rendered as a dead or missing button —
	// this is the page whose entire job is handing over the app.
	const heroHref =
		hero.kind === "ready" ? hero.asset.browser_download_url : RELEASES_PAGE;

	return (
		<div className="pb-8">
			<section className="container mx-auto px-4 pt-20 pb-12 md:pt-28">
				<DownloadHero />
				<div className="mx-auto mt-7 max-w-xl">
					{!(isMobile || pendingReleases) && (
						<div className="flex flex-col items-center gap-3">
							<div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
								<Button
									nativeButton={false}
									render={
										<a
											href={heroHref}
											rel="noopener noreferrer"
											{...(hero.kind === "ready"
												? { download: hero.asset.name }
												: { target: "_blank" })}
										/>
									}
									variant="mono"
								>
									<Download className="mr-2 size-5" />
									{hero.kind === "ready"
										? tl("Download for {osName} ({archLabel})", {
												archLabel: archLabel(os, arch),
												osName: osName(os),
											})
										: "View releases on GitHub"}
								</Button>
								<a
									className={cn(buttonVariants({ variant: "ghost" }))}
									href={RELEASES_PAGE}
									rel="noopener noreferrer"
									target="_blank"
								>
									All releases
								</a>
							</div>
						</div>
					)}
				</div>
			</section>

			<section className="container mx-auto px-4 py-12">
				<div className="mx-auto max-w-6xl space-y-12">
					{isMobile ? (
						<Card elevation="flat">
							<CardHeader>
								<CardTitle>Desktop only, for now</CardTitle>
								<CardDescription>Mobile is coming soon.</CardDescription>
							</CardHeader>
							<CardContent>
								<p className="text-muted-foreground text-sm">
									Open this page on your computer to install Ryu, or browse the
									release options below.
								</p>
							</CardContent>
						</Card>
					) : null}
					<SettingsSection title="Desktop app">
						<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
							{/* The whole list, not just the newest release: a platform whose
								    build is still uploading falls back to the last release that
								    really has it instead of showing a dead row. */}
							{PLATFORMS.map((platform, i) => (
								<Reveal delay={i * 0.06} key={platform.id}>
									<PlatformCard platform={platform} releases={releases} />
								</Reveal>
							))}
						</div>
					</SettingsSection>

					<SettingsSection title="Open in browser">
						<Card elevation="flat">
							<CardContent inset="none">
								<DownloadSettingRow
									href={WEBAPP_URL}
									icon={<Globe className="size-4" />}
									label="Open Web App"
									meta={WEBAPP_URL}
									openInNewTab
									status="ready"
								/>
							</CardContent>
						</Card>
					</SettingsSection>

					<SettingsSection title="Other versions">
						<Card elevation="flat">
							<CardContent inset="none">
								<DownloadSettingRow
									href={RELEASES_PAGE}
									icon={<History className="size-4" />}
									label="All versions"
									meta="Stable releases on GitHub"
									openInNewTab
									status="ready"
								/>
							</CardContent>
						</Card>
					</SettingsSection>

					<SettingsSection title="Developers">
						<div className="grid gap-4 lg:grid-cols-2">
							<Card elevation="flat">
								<CardContent inset="none">
									<DownloadSettingRow
										href={GITHUB_REPO}
										icon={<Globe className="size-4" />}
										label="Self-host"
										meta="Ryu on your own infrastructure"
										openInNewTab
										status="ready"
									/>
									<DownloadSettingRow
										href={DOCS_URL}
										icon={<BookOpen className="size-4" />}
										label="Documentation"
										meta={DOCS_URL}
										openInNewTab
										status="ready"
									/>
								</CardContent>
							</Card>
							<div className="space-y-4">
								{PRERELEASE_CHANNELS.map(({ id, label }) => (
									<Card elevation="flat" key={id}>
										<CardHeader>
											<div className="flex items-center gap-3">
												<span className="flex size-9 items-center justify-center rounded-xl bg-muted">
													{id === "nightly" ? (
														<Moon className="size-4" />
													) : (
														<FlaskConical className="size-4" />
													)}
												</span>
												<div>
													<CardTitle>{label}</CardTitle>
													<CardDescription>
														Rolling desktop builds
													</CardDescription>
												</div>
											</div>
										</CardHeader>
										<CardContent inset="none">
											<PrereleaseSettingRows
												channel={id}
												releases={allReleases}
											/>
										</CardContent>
									</Card>
								))}
							</div>
						</div>
					</SettingsSection>

					<SettingsSection title="Cloud">
						<Card elevation="flat">
							<CardContent inset="none">
								<DownloadSettingRow
									href="/login?view=signup"
									icon={<Cloud className="size-4" />}
									label="Join waitlist"
									meta="Hosted agents and sync"
									status="ready"
								/>
							</CardContent>
						</Card>
					</SettingsSection>
				</div>
			</section>

			<div className="py-12">
				<Highlights items={DOWNLOAD_HIGHLIGHTS} />
			</div>
		</div>
	);
}
