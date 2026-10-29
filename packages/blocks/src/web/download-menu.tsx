"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { buttonGroupVariants } from "@ryu/ui/components/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import {
	type ComponentType,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	archLabel,
	type DownloadArch,
	type DownloadOS,
	detectDownloadArch,
	detectDownloadArchAsync,
	detectDownloadOS,
	loadReleases,
	osName,
	RELEASES_PAGE,
	type Release,
	resolveDownloadState,
	stableReleases,
} from "./download-assets.ts";
import styles from "./download-menu.module.css";
import { useSendDownloadLink } from "./send-download-link.tsx";
import { OS_SVGL, SvglIcon } from "./svgl-icon.tsx";
import { whenBrowserIdle } from "./when-browser-idle.ts";

// The menu body (every platform row, the channel submenus and the page-level
// `download.tsx` module it reads from) is only needed once a visitor reaches for
// the chevron, but every public page mounts this button in its header. Load it
// on that intent instead of with the page.
type DropdownContentAlign = "center" | "end" | "start";

/**
 * Stands in when the menu chunk cannot load (offline, or a deploy replaced it).
 * A rejected `lazy` import would otherwise throw through the page's error
 * boundary; this keeps the chevron useful with the same releases-page fallback
 * the primary button uses.
 */
function DownloadDropdownFallback({ align }: { align?: DropdownContentAlign }) {
	return (
		<DropdownMenuContent align={align} className="min-w-56">
			<DropdownMenuItem
				render={
					<a href={RELEASES_PAGE} rel="noopener noreferrer" target="_blank" />
				}
			>
				All downloads
			</DropdownMenuItem>
		</DropdownMenuContent>
	);
}

const loadDropdownContent = () => import("./download-dropdown-content.tsx");
const LazyDownloadDropdownContent = lazy<
	ComponentType<{ align?: DropdownContentAlign; siteOrigin?: string }>
>(() =>
	loadDropdownContent().then(
		(module) => ({ default: module.DownloadDropdownContent }),
		() => ({ default: DownloadDropdownFallback })
	)
);

export function DownloadMenu({
	className,
	contentAlign = "start",
	label = "Download",
	showChevron = true,
	showPlatform = false,
	showSeparator = false,
	separatorClassName,
	siteOrigin,
	size = "default",
	transparentBackground = false,
	variant = "mono",
}: {
	className?: string;
	contentAlign?: "center" | "end" | "start";
	label?: string;
	showChevron?: boolean;
	/** Use the longer OS-aware label reserved for the dedicated download page. */
	showPlatform?: boolean;
	showSeparator?: boolean;
	separatorClassName?: string;
	/** Forwarded to the dropdown for site-relative links; see DownloadDropdownContent. */
	siteOrigin?: string;
	size?: "default" | "lg" | "sm";
	transparentBackground?: boolean;
	/** Public pages default to the neutral `mono` fill; `default` keeps the
	 * themed fill for callers that still opt into it. */
	variant?: "default" | "ghost" | "mono" | "outline";
}) {
	const tl = useLiteralMessages();
	const [os, setOs] = useState<DownloadOS>("macos");
	const [arch, setArch] = useState<DownloadArch | null>(null);
	const [releases, setReleases] = useState<Release[]>([]);

	// Mounting the (closed) content renders nothing until the menu opens, so
	// it is mounted on the first sign of intent to have its chunk ready.
	const [menuRequested, setMenuRequested] = useState(false);

	// On a phone the installer is no use: both segments open the drawer that
	// sends the download page to the visitor's computer instead (desktop is
	// unchanged, and the server HTML is the desktop markup).
	const sendLink = useSendDownloadLink(siteOrigin);

	const active = useRef(true);
	const releasesRequested = useRef(false);

	// The header and hero menus resolve the direct installer link without
	// competing with the page load: GitHub is asked once the browser is idle, or
	// right away when the visitor points at or focuses the button. Either way it
	// is one shared request per document (`loadReleases`).
	const requestReleases = useCallback(() => {
		if (releasesRequested.current) {
			return;
		}
		releasesRequested.current = true;
		loadReleases()
			.then((data) => {
				if (active.current) {
					setReleases(stableReleases(data).slice(0, 8));
				}
			})
			.catch(() => {
				// The main action falls back to the releases page when GitHub is unavailable.
			});
	}, []);

	const requestMenu = useCallback(() => {
		requestReleases();
		setMenuRequested(true);
	}, [requestReleases]);

	const handleMenuOpenChange = useCallback((open: boolean) => {
		if (open) {
			setMenuRequested(true);
		}
	}, []);

	useEffect(() => {
		active.current = true;
		setOs(detectDownloadOS());
		const synchronousArch = detectDownloadArch();

		void detectDownloadArchAsync().then((detectedArch) => {
			if (active.current) {
				setArch(detectedArch ?? synchronousArch);
			}
		});
		const cancelIdleRequest = whenBrowserIdle(requestReleases);
		return () => {
			active.current = false;
			cancelIdleRequest();
		};
	}, [requestReleases]);

	const resolvedArch = arch ?? "intel";
	const state = resolveDownloadState(releases, os, resolvedArch);
	const ready = arch !== null && state.kind === "ready";
	const href = ready ? state.asset.browser_download_url : RELEASES_PAGE;
	const primaryLabel = showPlatform
		? arch
			? tl("Download for {osName} ({archLabel})", {
					osName: osName(os),
					archLabel: archLabel(os, arch),
				})
			: "Download"
		: label;
	const iconSize = size === "lg" ? 18 : 16;
	// Public pages draw outline buttons as borderless text, so a split control
	// would leave the label and chevron floating apart. As a secondary CTA the
	// outline variant is one plain "Download" link with no menu. Beam-wrapped
	// (transparent) buttons keep their border, so they keep the menu.
	const showMenu = variant !== "outline" || transparentBackground;
	const separatorVisible = showSeparator && showMenu;
	// A mono split button needs a divider drawn on its own fill. A translucent
	// tone would let the page show through in dark mode, so mix an opaque one
	// and run it the full height so no strip of page shows between segments.
	const separatorTone =
		variant === "mono"
			? "my-0 bg-[color-mix(in_oklch,var(--background)_25%,var(--foreground))]"
			: "my-px bg-input";
	const chevron = showChevron ? <ChevronDown className="size-4" /> : null;
	return (
		<>
			<div
				className={cn(buttonGroupVariants(), styles.group)}
				data-slot="button-group"
				data-transparent={transparentBackground || undefined}
				role="group"
			>
				<Button
					appearance={
						transparentBackground
							? "download-primary-transparent"
							: "download-primary"
					}
					aria-haspopup={sendLink.mobile ? "dialog" : undefined}
					className={className}
					// The button base draws a transparent, padding-clipped border; on a mono
					// split it would leave a strip of page beside the divider, so join it.
					edge={
						(separatorVisible && variant !== "mono") || !showMenu
							? undefined
							: "joined"
					}
					nativeButton={false}
					onClick={sendLink.intercept}
					onFocus={requestReleases}
					onPointerEnter={requestReleases}
					render={
						<a
							download={ready ? state.asset.name : undefined}
							href={href}
							rel="noopener noreferrer"
							{...(ready ? {} : { target: "_blank" })}
						/>
					}
					size={size}
					variant={variant}
				>
					{showPlatform ? (
						<SvglIcon
							className={
								variant === "mono"
									? "brightness-0 invert dark:invert-0"
									: "brightness-0 invert"
							}
							size={iconSize}
							spec={OS_SVGL[os]}
						/>
					) : null}
					{primaryLabel}
				</Button>
				{separatorVisible ? (
					<span
						aria-orientation="vertical"
						className={cn(
							"relative h-auto w-px shrink-0 self-stretch",
							separatorTone,
							separatorClassName
						)}
						data-slot="button-group-separator"
						data-vertical=""
						role="separator"
					/>
				) : null}
				{showMenu && sendLink.mobile ? (
					<Button
						appearance={
							transparentBackground
								? "download-trigger-transparent"
								: "download-trigger"
						}
						aria-haspopup="dialog"
						aria-label="Send the download link to yourself"
						// Same slot as the menu trigger it stands in for, so the split
						// control keeps its pill ends (download-menu.module.css).
						data-slot="dropdown-menu-trigger"
						onClick={sendLink.intercept}
						size={size}
						type="button"
						variant={variant}
					>
						{chevron}
					</Button>
				) : null}
				{showMenu && !sendLink.mobile ? (
					<DropdownMenu onOpenChange={handleMenuOpenChange}>
						<DropdownMenuTrigger
							render={
								<Button
									appearance={
										transparentBackground
											? "download-trigger-transparent"
											: "download-trigger"
									}
									aria-label="More download options"
									onFocus={requestMenu}
									onPointerEnter={requestMenu}
									size={size}
									variant={variant}
								>
									{chevron}
								</Button>
							}
						/>
						{menuRequested ? (
							<Suspense fallback={null}>
								<LazyDownloadDropdownContent
									align={contentAlign}
									{...(siteOrigin ? { siteOrigin } : {})}
								/>
							</Suspense>
						) : null}
					</DropdownMenu>
				) : null}
			</div>
			{sendLink.drawer}
		</>
	);
}
