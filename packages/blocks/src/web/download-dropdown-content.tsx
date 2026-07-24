"use client";

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
	AppWindow,
	ArrowUpRight,
	Blocks,
	BookOpen,
	Bot,
	Cloud,
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
	BROWSERS,
	type DownloadArch,
	type DownloadOS,
	findReleaseWithAsset,
	GITHUB_REPO,
	osName,
	PLATFORMS,
	RELEASES_API,
	RELEASES_PAGE,
	type Release,
	WEBAPP_URL,
} from "./download.tsx";
import {
	BROWSER_SVGL,
	GITHUB_SVGL,
	MOBILE_SVGL,
	OS_SVGL,
	SvglIcon,
} from "./svgl-icon.tsx";

const SETUP_SKILL_PATH = "/api/skills/setup-ryu";

const AGENT_LINKS = [
	{ href: "/products/cli", label: "CLI", Icon: Terminal },
	{ href: "/products/sdk", label: "SDK", Icon: Blocks },
	{ href: "/products/mcp", label: "MCP", Icon: Plug },
	{ href: "/products/skills", label: "Skills", Icon: Sparkles },
] as const;

function detectOs(): DownloadOS {
	if (typeof window === "undefined") {
		return "macos";
	}
	const userAgent = window.navigator.userAgent.toLowerCase();
	const platform = window.navigator.platform.toLowerCase();
	if (
		userAgent.includes("mac") ||
		userAgent.includes("iphone") ||
		userAgent.includes("ipad") ||
		platform.includes("mac")
	) {
		return "macos";
	}
	if (userAgent.includes("win") || platform.includes("win")) {
		return "windows";
	}
	if (
		userAgent.includes("linux") ||
		platform.includes("linux") ||
		userAgent.includes("x11")
	) {
		return "linux";
	}
	return "macos";
}

function detectArch(): DownloadArch {
	if (typeof window === "undefined") {
		return "intel";
	}
	const ua = window.navigator.userAgent.toLowerCase();
	return ua.includes("arm") || ua.includes("aarch64") ? "arm" : "intel";
}

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

function downloadAnchorProps(
	releases: Release[],
	platformId: DownloadOS,
	arch: DownloadArch
) {
	// Resolve per platform+arch: a release window can have macOS arm published
	// while Windows is still building, so each row independently falls back to
	// the newest release that actually carries ITS binary.
	const found = findReleaseWithAsset(releases, platformId, arch);
	if (!found) {
		return { href: releases[0]?.html_url ?? RELEASES_PAGE };
	}
	return {
		href: found.asset.browser_download_url,
		download: found.asset.name,
	};
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
				<DropdownMenuItem
					key={arch}
					render={
						<a
							{...downloadAnchorProps(releases, platformId, arch)}
							rel="noopener noreferrer"
						/>
					}
				>
					{archLabel(platformId, arch)}
				</DropdownMenuItem>
			))}
		</>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<DropdownMenuLabel className="select-none font-semibold text-muted-foreground text-xs">
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
	const [releases, setReleases] = useState<Release[]>([]);

	useEffect(() => {
		setOs(detectOs());
		setArch(detectArch());
	}, []);

	useEffect(() => {
		fetch(RELEASES_API)
			.then((res) => res.json())
			.then((data) => {
				if (Array.isArray(data)) {
					// Keep several: the newest release often has no binaries yet (they
					// upload when its build finishes), so we need older ones to fall
					// back to instead of linking the user at a dead download.
					setReleases(data.filter((r: Release) => !r.draft).slice(0, 8));
				}
			})
			.catch(() => {
				// Best-effort; menu still links to GitHub releases.
			});
	}, []);

	const latestRelease = releases[0];
	const otherPlatforms = useMemo(
		() => PLATFORMS.filter((platform) => platform.id !== os),
		[os]
	);
	const otherArches = useMemo(
		() => (["arm", "intel"] as const).filter((candidate) => candidate !== arch),
		[arch]
	);

	// Newest release that actually carries this platform's binary (falls back past
	// a just-tagged, still-building release rather than linking to nothing).
	const downloadable = findReleaseWithAsset(releases, os, arch);
	const desktopAsset = downloadable?.asset ?? null;

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
					<AppWindow className="size-4" />
					Open Web App
				</DropdownMenuItem>
			</DropdownMenuGroup>

			<DropdownMenuSeparator />

			<DropdownMenuGroup>
				<SectionLabel>Desktop App</SectionLabel>
				<DropdownMenuItem
					render={
						<a
							{...(desktopAsset
								? {
										href: desktopAsset.browser_download_url,
										download: desktopAsset.name,
									}
								: { href: latestRelease?.html_url ?? RELEASES_PAGE })}
							rel="noopener noreferrer"
						/>
					}
				>
					<SvglIcon spec={OS_SVGL[os]} />
					{osName(os)}
					<span className="ml-auto text-muted-foreground text-xs">
						{archLabel(os, arch)}
					</span>
				</DropdownMenuItem>
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
					<DropdownMenuItem
						key={`${os}-${altArch}`}
						render={
							<a
								{...downloadAnchorProps(releases, os, altArch)}
								rel="noopener noreferrer"
							/>
						}
					>
						<SvglIcon spec={OS_SVGL[os]} />
						{osName(os)}
						<span className="ml-auto text-muted-foreground text-xs">
							{archLabel(os, altArch)}
						</span>
					</DropdownMenuItem>
				))}
				{otherPlatforms.map((platform) => (
					<DropdownMenuSub key={platform.id}>
						<DropdownMenuSubTrigger>
							<SvglIcon spec={OS_SVGL[platform.id]} />
							{platform.name}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<PlatformArchItems
								platformId={platform.id}
								releases={releases}
							/>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				))}
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
