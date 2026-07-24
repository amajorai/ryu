import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@ryu/ui/components/accordion";
import { Button, buttonVariants } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { cn } from "@ryu/ui/lib/utils";
import { Download } from "lucide-react";
import type { SVGProps } from "react";
import { Reveal } from "./reveal.tsx";
import { Highlights } from "./sections.tsx";

export type DownloadOS = "macos" | "windows" | "linux";
export type DownloadArch = "intel" | "arm";

export interface ReleaseAsset {
	browser_download_url: string;
	name: string;
}

export interface Release {
	assets: ReleaseAsset[];
	draft?: boolean;
	html_url: string;
	id: number;
	name: string;
	prerelease?: boolean;
	published_at: string;
	tag_name: string;
}

export const GITHUB_RELEASES_REPO = "amajorai/ryu";
export const RELEASES_PAGE = `https://github.com/${GITHUB_RELEASES_REPO}/releases`;
export const RELEASES_API = `https://api.github.com/repos/${GITHUB_RELEASES_REPO}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_RELEASES_REPO}/releases/latest`;
export const GITHUB_REPO = `https://github.com/${GITHUB_RELEASES_REPO}`;

/** Browser build of the desktop app (apps/webapp). Default :5175 in local dev. */
export const WEBAPP_URL =
	process.env.NEXT_PUBLIC_WEBAPP_URL ?? "http://localhost:5175";

export type DownloadBrowser = "chrome" | "firefox" | "edge";

export const BROWSERS: { id: DownloadBrowser; name: string }[] = [
	{ id: "chrome", name: "Chrome" },
	{ id: "firefox", name: "Firefox" },
	{ id: "edge", name: "Edge" },
];

const CHROME_EXTENSION_ID =
	process.env.NEXT_PUBLIC_EXTENSION_ID ?? "eahmgoelihpjlbejliklmfcohjhpgeml";

export function extensionStoreUrl(browser: DownloadBrowser): string {
	if (browser === "chrome") {
		return `https://chromewebstore.google.com/detail/ryu/${CHROME_EXTENSION_ID}`;
	}
	if (browser === "firefox") {
		const slug = process.env.NEXT_PUBLIC_FIREFOX_EXTENSION_SLUG;
		return slug
			? `https://addons.mozilla.org/en-US/firefox/addon/${slug}/`
			: "https://addons.mozilla.org/en-US/firefox/search/?q=ryu";
	}
	const edgeId = process.env.NEXT_PUBLIC_EDGE_EXTENSION_ID;
	return edgeId
		? `https://microsoftedge.microsoft.com/addons/detail/${edgeId}`
		: "https://microsoftedge.microsoft.com/addons/search/ryu";
}

export function browserName(browser: DownloadBrowser): string {
	return (
		BROWSERS.find((candidate) => candidate.id === browser)?.name ?? "Chrome"
	);
}

const EDG_UA_RE = /edg\//i;
const FIREFOX_UA_RE = /firefox/i;

export function detectBrowser(): DownloadBrowser {
	if (typeof window === "undefined") {
		return "chrome";
	}
	const ua = window.navigator.userAgent;
	if (EDG_UA_RE.test(ua)) {
		return "edge";
	}
	if (FIREFOX_UA_RE.test(ua)) {
		return "firefox";
	}
	return "chrome";
}

const AppleLogo = (props: SVGProps<SVGSVGElement>) => (
	<svg
		aria-hidden="true"
		focusable="false"
		viewBox="0 0 814 1000"
		xmlSpace="preserve"
		{...props}
	>
		<path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
	</svg>
);

const WindowsLogo = (props: SVGProps<SVGSVGElement>) => (
	<svg aria-hidden="true" focusable="false" viewBox="0 0 88 88" {...props}>
		<path
			d="m0 12.402 35.687-4.86.016 34.423-35.67.203zm35.67 33.529.028 34.453L.028 75.48.026 45.7zm4.326-39.025L87.314 0v41.527l-47.318.376zm47.329 39.349-.011 41.34-47.318-6.678-.066-34.739z"
			fill="#00adef"
		/>
	</svg>
);

const LinuxLogo = (props: SVGProps<SVGSVGElement>) => (
	<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" {...props}>
		<path
			d="M12.504 0c-.155 0-.315.008-.480.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489.117.804.49 1.543 1.17 2.046.61.45 1.336.602 2.04.602.36 0 .714-.04 1.045-.108.41.21.873.32 1.355.32.452 0 .892-.094 1.293-.27.41.197.85.297 1.293.297.493 0 .974-.123 1.394-.355.32.064.66.1 1.005.1.704 0 1.43-.152 2.04-.602.68-.503 1.053-1.242 1.17-2.046.123-.805-.009-1.657-.287-2.489-.589-1.771-1.831-3.47-2.716-4.521-.75-1.067-.974-1.928-1.05-3.02-.065-1.491 1.056-5.965-3.17-6.298A6.176 6.176 0 0 0 12.504 0zm.696 5.71c.319 0 .574.255.574.574 0 .318-.255.574-.574.574a.572.572 0 0 1-.574-.574c0-.319.256-.574.574-.574zm-2.32.011c.318 0 .573.256.573.574a.572.572 0 0 1-.574.574.572.572 0 0 1-.573-.574c0-.318.256-.574.574-.574z"
			fill="currentColor"
		/>
	</svg>
);

interface Platform {
	archPatterns: Record<DownloadArch, RegExp[]>;
	description: string;
	icon: React.ReactNode;
	id: DownloadOS;
	name: string;
}

export const PLATFORMS: Platform[] = [
	{
		id: "macos",
		name: "macOS",
		description: "Requires macOS 12.0 or later",
		icon: <AppleLogo className="size-6 fill-current text-foreground" />,
		archPatterns: {
			arm: [/aarch64\.dmg$/i, /_aarch64\.dmg$/i],
			intel: [/x64\.dmg$/i, /_x64\.dmg$/i],
		},
	},
	{
		id: "windows",
		name: "Windows",
		description: "Windows 10 or 11 (64-bit)",
		icon: <WindowsLogo className="size-6 [&_path]:fill-[#00adef]" />,
		archPatterns: {
			arm: [/arm64.*setup\.exe$/i],
			intel: [/x64-setup\.exe$/i, /x64_en-US\.msi$/i],
		},
	},
	{
		id: "linux",
		name: "Linux",
		description: "Debian, Ubuntu, Fedora, and more",
		icon: <LinuxLogo className="size-6 text-foreground" />,
		archPatterns: {
			arm: [/aarch64\.AppImage$/i, /arm64\.AppImage$/i, /arm64\.deb$/i],
			intel: [/amd64\.AppImage$/i, /amd64\.deb$/i, /x86_64\.rpm$/i],
		},
	},
];

const DOWNLOAD_HIGHLIGHTS = [
	{
		title: "Runs offline",
		description:
			"Local models run entirely on your machine. The internet is optional, only needed for cloud models or sync.",
	},
	{
		title: "Free during beta",
		description:
			"The full desktop app is free while in beta. Bring your own keys, no markup, keep everything you build.",
	},
	{
		title: "Every platform",
		description:
			"Native builds for macOS (Apple Silicon & Intel), Windows, and Linux, as easy as installing an app.",
	},
	{
		title: "Auto-updates",
		description:
			"Ship installs once, then quietly keeps itself current so you're always on the latest release.",
	},
];

export function findReleaseAsset(
	release: Release,
	platformId: string,
	arch: DownloadArch
): ReleaseAsset | null {
	if (!release.assets?.length) {
		return null;
	}
	const platform = PLATFORMS.find((p) => p.id === platformId);
	if (!platform) {
		return null;
	}
	for (const pattern of platform.archPatterns[arch]) {
		const asset = release.assets.find((a) => pattern.test(a.name));
		if (asset) {
			return asset;
		}
	}
	return null;
}

/**
 * Newest release that actually CARRIES the asset for this platform/arch.
 *
 * A GitHub release exists the moment it is tagged, but its binaries are uploaded
 * by a build that can take many minutes — so "latest release" is routinely a
 * release with no desktop assets yet, and linking to it hands the user a dead
 * download. Walk newest-to-oldest and return the first release that really has
 * the file, so a still-building version transparently falls back to the last
 * good one. Returns null only when no release in the list has it.
 */
export function findReleaseWithAsset(
	releases: Release[],
	platformId: string,
	arch: DownloadArch
): { release: Release; asset: ReleaseAsset } | null {
	for (const release of releases) {
		if (release.draft) {
			continue;
		}
		const asset = findReleaseAsset(release, platformId, arch);
		if (asset) {
			return { release, asset };
		}
	}
	return null;
}

export function getAssetUrl(
	release: Release,
	platformId: string,
	arch: DownloadArch
) {
	return (
		findReleaseAsset(release, platformId, arch)?.browser_download_url ??
		release.html_url
	);
}

export function archLabel(platformId: string, arch: DownloadArch) {
	if (platformId === "macos") {
		return arch === "arm" ? "Apple Silicon" : "Intel";
	}
	return arch === "arm" ? "ARM64" : "x64";
}

export function osName(os: DownloadOS) {
	if (os === "windows") {
		return "Windows";
	}
	if (os === "linux") {
		return "Linux";
	}
	return "macOS";
}

function formatDate(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "long",
				day: "numeric",
			});
}

function ArchButtons({
	release,
	platformId,
}: {
	release: Release;
	platformId: string;
}) {
	return (
		<div className="flex w-full flex-col gap-2">
			{(["arm", "intel"] as const).map((arch) => {
				const asset = findReleaseAsset(release, platformId, arch);
				return (
					<Button
						className="w-full justify-between"
						key={arch}
						nativeButton={false}
						render={
							<a
								download={asset?.name}
								href={asset?.browser_download_url ?? release.html_url}
								rel="noopener noreferrer"
							/>
						}
						variant="outline"
					>
						<span className="flex flex-col items-start text-left">
							<span className="font-medium text-sm">
								{archLabel(platformId, arch)}
							</span>
							<span className="text-muted-foreground text-xs">
								{arch === "arm" ? "ARM processors" : "Intel / AMD"}
							</span>
						</span>
						<Download className="size-4 text-muted-foreground" />
					</Button>
				);
			})}
		</div>
	);
}

const EMPTY_RELEASE: Release = {
	id: 0,
	tag_name: "",
	name: "",
	published_at: new Date(0).toISOString(),
	assets: [],
	html_url: RELEASES_PAGE,
};

function PlatformCard({
	platform,
	release,
}: {
	platform: Platform;
	release: Release;
}) {
	return (
		<div className="flex h-full flex-col gap-5 rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-sm transition-colors hover:bg-muted/60">
			<div className="flex items-center gap-4">
				<span className="inline-flex size-12 items-center justify-center rounded-2xl bg-foreground/10">
					{platform.icon}
				</span>
				<div>
					<h3 className="font-semibold text-foreground text-lg">
						{platform.name}
					</h3>
					<p className="text-muted-foreground text-sm">
						{platform.description}
					</p>
				</div>
			</div>
			<div className="mt-auto">
				<ArchButtons platformId={platform.id} release={release} />
			</div>
		</div>
	);
}

export interface DownloadProps {
	/** Detected architecture preference; the live page derives it from the user agent. */
	arch?: DownloadArch;
	/** Mobile gate; the live page derives it from the viewport. */
	isMobile?: boolean;
	/** Detected OS; the live page derives it from the user agent. */
	os?: DownloadOS;
	/** Releases fetched from GitHub; the live page fetches them, the storyboard passes static ones. */
	releases?: Release[];
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
	arch = "intel",
	os = "macos",
	isMobile = false,
}: DownloadProps) {
	const latestRelease = releases[0];
	const previousReleases = releases.slice(1);
	// The newest release that actually HAS this platform's binary. A freshly
	// tagged release has no assets until its build finishes, so pointing the CTA
	// at `releases[0]` hands the user a dead link during every release window.
	const downloadable = findReleaseWithAsset(releases, os, arch);

	return (
		<div className="pb-8">
			<section className="container mx-auto px-4 pt-20 pb-12 text-center md:pt-28">
				<div className="mx-auto max-w-3xl space-y-6">
					<span className="inline-flex items-center gap-2 rounded-full bg-muted/60 px-3 py-1 font-medium text-muted-foreground text-xs">
						<Download className="size-3.5" strokeWidth={1.5} />
						Download
					</span>
					<h1 className="text-balance font-medium text-4xl text-foreground leading-[1.1] tracking-tight md:text-6xl">
						Powerful agents, as easy as installing an app.
					</h1>
					<p className="mx-auto max-w-xl text-balance text-muted-foreground md:text-lg">
						Run local models on your own machine, no terminal or API keys
						required. Available for macOS, Windows, and Linux, and free while
						we're in beta.
					</p>
					{!isMobile && latestRelease && (
						<div className="flex flex-col items-center gap-3">
							<div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
								<Button
									nativeButton={false}
									render={
										<a
											download={downloadable?.asset.name}
											href={
												downloadable?.asset.browser_download_url ??
												latestRelease.html_url
											}
											rel="noopener noreferrer"
										/>
									}
								>
									<Download className="mr-2 size-5" />
									Download for {osName(os)} ({archLabel(os, arch)})
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
							<p className="text-muted-foreground/60 text-xs">
								{/* Show the version actually being downloaded — during a
								    release window that is the last one with binaries, not
								    the just-tagged one still building. */}
								{(downloadable?.release ?? latestRelease).tag_name} · Free and
								open to use locally
							</p>
						</div>
					)}
				</div>
			</section>

			{isMobile ? (
				<section className="container mx-auto px-4 pb-12">
					<div className="mx-auto w-full max-w-md text-center">
						<Card>
							<CardHeader>
								<CardTitle>Desktop only, for now</CardTitle>
								<CardDescription>Mobile is coming soon.</CardDescription>
							</CardHeader>
							<CardContent>
								<p className="text-muted-foreground text-sm">
									Open this page on your computer to download Ryu, or grab a
									build straight from GitHub.
								</p>
								<Button
									className="mt-4"
									nativeButton={false}
									render={
										<a
											href={RELEASES_PAGE}
											rel="noopener noreferrer"
											target="_blank"
										/>
									}
									variant="outline"
								>
									View releases on GitHub
								</Button>
							</CardContent>
						</Card>
					</div>
				</section>
			) : (
				<section className="container mx-auto px-4 py-12">
					<div className="mx-auto max-w-6xl">
						<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
							{PLATFORMS.map((platform, i) => (
								<Reveal delay={i * 0.06} key={platform.id}>
									<PlatformCard
										platform={platform}
										release={latestRelease ?? { ...EMPTY_RELEASE }}
									/>
								</Reveal>
							))}
						</div>

						{previousReleases.length > 0 && (
							<div className="mt-16">
								<h2 className="mb-6 text-center font-medium text-foreground text-xl">
									Previous releases
								</h2>
								<Accordion multiple={false}>
									{previousReleases.map((release) => (
										<AccordionItem
											key={release.id}
											value={release.id.toString()}
										>
											<AccordionTrigger className="hover:no-underline">
												<div className="flex flex-col items-start text-left">
													<span className="font-semibold">
														{release.tag_name}
													</span>
													<span className="text-muted-foreground text-xs">
														{formatDate(release.published_at)}
													</span>
												</div>
											</AccordionTrigger>
											<AccordionContent>
												<div className="grid grid-cols-1 gap-4 pt-4 md:grid-cols-3">
													{PLATFORMS.map((platform) => (
														<PlatformCard
															key={platform.id}
															platform={platform}
															release={release}
														/>
													))}
												</div>
											</AccordionContent>
										</AccordionItem>
									))}
								</Accordion>
							</div>
						)}
					</div>
				</section>
			)}

			<div className="py-12">
				<Highlights items={DOWNLOAD_HIGHLIGHTS} />
			</div>
		</div>
	);
}
