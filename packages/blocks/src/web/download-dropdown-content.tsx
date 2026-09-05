"use client";

import { InternetIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { toast } from "@ryu/ui/components/sileo";
import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowUpRight,
	Blocks,
	BookOpen,
	Cloud,
	FlaskConical,
	History,
	Moon,
	Plug,
	Sparkles,
	Terminal,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DOCS_URL } from "./data/resources.tsx";
import {
	archLabel,
	type DownloadArch,
	type DownloadOS,
	type DownloadState,
	detectDownloadArch,
	detectDownloadOS,
	findChannelRelease,
	GITHUB_REPO,
	loadReleases,
	osName,
	PLATFORMS,
	PRERELEASE_CHANNELS,
	type PrereleaseChannel,
	RELEASES_PAGE,
	type Release,
	resolveDownloadState,
	stableReleases,
	WEBAPP_URL,
} from "./download.tsx";
import { GITHUB_SVGL, OS_SVGL, SvglIcon } from "./svgl-icon.tsx";

const SETUP_SKILL_PATH = "/api/skills/setup-ryu";

const AGENT_LINKS = [
	{ href: "/products/cli", label: "CLI", Icon: Terminal },
	{ href: "/products/sdk", label: "SDK", Icon: Blocks },
	{ href: "/products/mcp", label: "MCP", Icon: Plug },
	{ href: "/products/skills", label: "Skills", Icon: Sparkles },
] as const;

async function copySetupSkill() {
	try {
		const response = await fetch(SETUP_SKILL_PATH);
		if (!response.ok) {
			throw new Error("Skill unavailable");
		}
		const text = await response.text();
		await navigator.clipboard.writeText(text);
		toast.success("Setup skill copied — paste it into your agent");
	} catch {
		toast.error("Could not copy the setup skill. Try again.");
	}
}

/**
 * Trailing text for a row, keeping the arch visible when the label doesn't
 * already carry it — a greyed row reads "Windows — ARM64 · Not available"
 * rather than leaving the visitor to guess which build is missing.
 */
function rowMeta(state: DownloadState, meta?: string): string {
	const withNote = (note: string) => [meta, note].filter(Boolean).join(" · ");
	if (state.kind === "unavailable") {
		return withNote("Not available");
	}
	if (state.kind === "building") {
		return withNote("Building");
	}
	// Name the version during a release window, when what you get is the last
	// release with binaries rather than the newest tag.
	if (state.kind === "ready" && state.supersededByBuilding) {
		return withNote(state.servedVersion);
	}
	return meta ?? "";
}

/**
 * One installer row. A build we don't ship — or one whose upload hasn't landed
 * yet — renders disabled and says which, the same shape the "Coming soon" rows
 * use. A release list we could not read never disables anything: those rows
 * link to the releases page so the menu still works when GitHub does not.
 */
function DownloadItem({
	arch,
	icon,
	label,
	meta,
	platformId,
	releases,
}: {
	arch: DownloadArch;
	icon?: React.ReactNode;
	label: string;
	meta?: string;
	platformId: DownloadOS;
	releases: Release[];
}) {
	const state = resolveDownloadState(releases, platformId, arch);
	const trailing = rowMeta(state, meta);
	const body = (
		<>
			{icon}
			{label}
			{trailing ? (
				<span className="ml-auto text-muted-foreground text-xs">
					{trailing}
				</span>
			) : null}
		</>
	);

	if (state.kind === "unavailable" || state.kind === "building") {
		return <DropdownMenuItem disabled>{body}</DropdownMenuItem>;
	}
	return (
		<DropdownMenuItem
			render={
				<a
					href={
						state.kind === "ready"
							? state.asset.browser_download_url
							: state.href
					}
					rel="noopener noreferrer"
					{...(state.kind === "ready" ? { download: state.asset.name } : {})}
				/>
			}
		>
			{body}
		</DropdownMenuItem>
	);
}

function PlatformArchItems({
	platformId,
	releases,
}: {
	platformId: DownloadOS;
	releases: Release[];
}) {
	return (
		<>
			{(["arm", "intel"] as const).map((arch) => (
				<DownloadItem
					arch={arch}
					key={arch}
					label={archLabel(platformId, arch)}
					platformId={platformId}
					releases={releases}
				/>
			))}
		</>
	);
}

/**
 * Every platform+arch for one rolling prerelease channel, flat.
 *
 * Flat rather than a platform submenu inside a channel submenu: three levels of
 * nesting is miserable to hit with a mouse, and a channel only ever builds a
 * handful of targets — the ones it skipped read "Not available", which is the
 * useful information here.
 */
function ChannelItems({
	channel,
	releases,
}: {
	channel: PrereleaseChannel;
	releases: Release[];
}) {
	const release = findChannelRelease(releases, channel);
	// Scope resolution to this channel's release so it can never fall back onto a
	// stable build and quietly hand out a non-prerelease binary.
	const scoped = release ? [release] : [];
	return (
		<>
			{PLATFORMS.map((platform) =>
				(["arm", "intel"] as const).map((arch) => (
					<DownloadItem
						arch={arch}
						icon={<SvglIcon spec={OS_SVGL[platform.id]} />}
						key={`${platform.id}-${arch}`}
						label={platform.name}
						meta={archLabel(platform.id, arch)}
						platformId={platform.id}
						releases={scoped}
					/>
				))
			)}
		</>
	);
}

/** What the "Desktop App" header says after the section name. */
function sectionNote(state: DownloadState): string {
	if (state.kind === "ready") {
		return state.servedVersion;
	}
	if (state.kind === "building") {
		return `${state.version} building`;
	}
	// "unavailable" and "unknown" are already spelled out on the row itself;
	// repeating them in the header would just be noise.
	return "";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<DropdownMenuLabel className="select-none font-medium text-muted-foreground text-xs">
			{children}
		</DropdownMenuLabel>
	);
}

export function DownloadDropdownContent({
	align = "start",
	className,
	side = "bottom",
}: {
	align?: "center" | "end" | "start";
	className?: string;
	side?: "bottom" | "left" | "right" | "top";
}) {
	const [os, setOs] = useState<DownloadOS>("macos");
	const [arch, setArch] = useState<DownloadArch>("intel");
	const [allReleases, setAllReleases] = useState<Release[]>([]);

	useEffect(() => {
		setOs(detectDownloadOS());
		setArch(detectDownloadArch());
	}, []);

	useEffect(() => {
		let active = true;
		// Shared across every download menu on the page — see loadReleases().
		loadReleases()
			.then((data) => {
				if (active) {
					setAllReleases(data);
				}
			})
			.catch(() => {
				// Best-effort; menu still links to GitHub releases.
			});
		return () => {
			active = false;
		};
	}, []);

	// Keep several: the newest release often has no binaries yet (they upload
	// when its build finishes), so we need older ones to fall back to instead of
	// linking the user at a dead download.
	const releases = useMemo(
		() => stableReleases(allReleases).slice(0, 8),
		[allReleases]
	);

	const otherPlatforms = useMemo(
		() => PLATFORMS.filter((platform) => platform.id !== os),
		[os]
	);
	const otherArches = useMemo(
		() => (["arm", "intel"] as const).filter((candidate) => candidate !== arch),
		[arch]
	);

	// The header states what this visitor's machine would actually get: the tag
	// of the release carrying the binary (never `releases[0]`'s — during a release
	// window those differ), or why there is nothing to hand over yet.
	const primary = resolveDownloadState(releases, os, arch);
	const primaryNote = sectionNote(primary);

	return (
		<DropdownMenuContent
			align={align}
			className={cn("min-w-72 max-w-sm", className)}
			side={side}
		>
			<DropdownMenuGroup>
				<DropdownMenuItem
					render={<a href={WEBAPP_URL} rel="noopener noreferrer" />}
				>
					<HugeiconsIcon className="size-4" icon={InternetIcon} />
					Open Web App
				</DropdownMenuItem>
			</DropdownMenuGroup>

			<DropdownMenuSeparator />

			<DropdownMenuGroup>
				<SectionLabel>
					Desktop App
					{primaryNote ? (
						<span className="ml-1 font-normal tabular-nums">
							· {primaryNote}
						</span>
					) : null}
				</SectionLabel>
				<DownloadItem
					arch={arch}
					icon={<SvglIcon spec={OS_SVGL[os]} />}
					label={osName(os)}
					meta={archLabel(os, arch)}
					platformId={os}
					releases={releases}
				/>
			</DropdownMenuGroup>

			{/* <DropdownMenuSeparator />

			<DropdownMenuGroup>
				<SectionLabel>Extensions</SectionLabel>
				{BROWSERS.map(({ id, name }) => (
					<DropdownMenuItem disabled key={id}>
						<SvglIcon spec={BROWSER_SVGL[id]} />
						{name}
						<span className="ml-auto text-muted-foreground text-xs">
							Coming soon
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuGroup>

			<DropdownMenuSeparator />

			<DropdownMenuGroup>
				<SectionLabel>Agents</SectionLabel>
				<DropdownMenuItem
					onClick={() => {
						copySetupSkill().catch(() => undefined);
					}}
				>
					<Bot className="size-4" />
					Ask agent to set it up
				</DropdownMenuItem>
				{AGENT_LINKS.map(({ href, label, Icon }) => (
					<DropdownMenuItem key={href} render={<Link href={href as Route} />}>
						<Icon className="size-4" />
						{label}
					</DropdownMenuItem>
				))}
			</DropdownMenuGroup>

			<DropdownMenuSeparator /> */}

			<DropdownMenuGroup>
				<SectionLabel>Others</SectionLabel>
				{otherArches.map((altArch) => (
					<DownloadItem
						arch={altArch}
						icon={<SvglIcon spec={OS_SVGL[os]} />}
						key={`${os}-${altArch}`}
						label={osName(os)}
						meta={archLabel(os, altArch)}
						platformId={os}
						releases={releases}
					/>
				))}
				{otherPlatforms.map((platform) => (
					<DropdownMenuSub key={platform.id}>
						<DropdownMenuSubTrigger>
							<SvglIcon spec={OS_SVGL[platform.id]} />
							{platform.name}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<PlatformArchItems platformId={platform.id} releases={releases} />
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				))}
				<DropdownMenuItem
					render={
						<a href={RELEASES_PAGE} rel="noopener noreferrer" target="_blank" />
					}
				>
					<History className="size-4" />
					All versions
					<ArrowUpRight className="ml-auto size-3.5 text-muted-foreground" />
				</DropdownMenuItem>
			</DropdownMenuGroup>

			<DropdownMenuGroup>
				<SectionLabel>Developers</SectionLabel>
				<DropdownMenuItem
					render={
						<a href={GITHUB_REPO} rel="noopener noreferrer" target="_blank" />
					}
				>
					<SvglIcon spec={GITHUB_SVGL} />
					Self-host
					<ArrowUpRight className="ml-auto size-3.5 text-muted-foreground" />
				</DropdownMenuItem>
				<DropdownMenuItem
					render={
						<a href={DOCS_URL} rel="noopener noreferrer" target="_blank" />
					}
				>
					<BookOpen className="size-4" />
					Documentation
					<ArrowUpRight className="ml-auto size-3.5 text-muted-foreground" />
				</DropdownMenuItem>
				{PRERELEASE_CHANNELS.map(({ id, label }) => (
					<DropdownMenuSub key={id}>
						<DropdownMenuSubTrigger>
							{id === "nightly" ? (
								<Moon className="size-4" />
							) : (
								<FlaskConical className="size-4" />
							)}
							{label}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<ChannelItems channel={id} releases={allReleases} />
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				))}
			</DropdownMenuGroup>

			{/* <DropdownMenuSeparator />

			<DropdownMenuGroup>
				<SectionLabel>Mobile</SectionLabel>
				<DropdownMenuItem disabled>
					<SvglIcon spec={MOBILE_SVGL.ios} />
					iOS
					<span className="ml-auto text-muted-foreground text-xs">
						Coming soon
					</span>
				</DropdownMenuItem>
				<DropdownMenuItem disabled>
					<SvglIcon spec={MOBILE_SVGL.android} />
					Android
					<span className="ml-auto text-muted-foreground text-xs">
						Coming soon
					</span>
				</DropdownMenuItem>
			</DropdownMenuGroup>

			<DropdownMenuSeparator /> */}

			<DropdownMenuGroup>
				<SectionLabel>Cloud</SectionLabel>
				<DropdownMenuItem
					render={<Link href={"/login?view=signup" as Route} />}
				>
					<Cloud className="size-4" />
					Join waitlist
				</DropdownMenuItem>
			</DropdownMenuGroup>
		</DropdownMenuContent>
	);
}
