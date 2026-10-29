"use client";

import { PreviewCard } from "@base-ui/react/preview-card";
import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { HoverCard, HoverCardTrigger } from "@ryu/ui/components/hover-card";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import styles from "./elements-one.module.css";
import { FileTypeIcon } from "./file-type-icon.tsx";

/** This preview owns its clipped, unpadded chrome; the shared popup variants
 * provide different inset treatments. The underlying PreviewCard interaction,
 * portal and positioner remain native. */
function LinkPreviewPopup({ children }: { children: React.ReactNode }) {
	const direction = useDirection();
	return (
		<PreviewCard.Portal data-slot="hover-card-portal">
			<PreviewCard.Positioner
				align="start"
				alignOffset={4}
				className="isolate z-50"
				side="top"
				sideOffset={8}
			>
				<PreviewCard.Popup
					className={cn(
						styles.previewPopup,
						"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 corner-squircle before:corner-squircle relative z-50 w-80 max-w-[min(20rem,calc(100vw-2rem))] origin-(--transform-origin) overflow-hidden rounded-2xl border border-border/50 bg-popover/70 p-0 text-popover-foreground text-sm outline-hidden backdrop-blur-2xl backdrop-saturate-150 duration-(--dropdown-open-dur) ease-(--dropdown-ease) before:pointer-events-none before:absolute before:inset-0 before:-z-1 data-closed:animate-out data-open:animate-in data-closed:duration-(--dropdown-close-dur)"
					)}
					data-slot="hover-card-content"
					dir={direction}
				>
					{children}
				</PreviewCard.Popup>
			</PreviewCard.Positioner>
		</PreviewCard.Portal>
	);
}

export interface WebsiteLinkPreview {
	description?: string | null;
	image?: string | null;
	siteName?: string | null;
	title?: string | null;
	url: string;
}

export interface FileLinkPreview {
	name: string;
	path: string;
	snippet: string;
}

export interface LinkPreviewResolvers {
	previewFile?: (path: string) => Promise<FileLinkPreview | null>;
	previewWebsite?: (url: string) => Promise<WebsiteLinkPreview | null>;
}

// Private read ports preserve all fields of both authored resolver outputs.
// A changed target can retain the preceding preview until its next request, so
// the render branch does not itself establish which cached shape is present.
type LinkPreviewReadFields = Partial<FileLinkPreview & WebsiteLinkPreview>;

type LinkTarget =
	| { kind: "file"; value: string }
	| { kind: "website"; value: string };

const websiteCache = new Map<string, WebsiteLinkPreview | null>();
const fileCache = new Map<string, FileLinkPreview | null>();

function WebsitePreviewCard({
	data,
	url,
}: {
	data: LinkPreviewReadFields | null | undefined;
	url: string;
}) {
	const safeImage = safeMediaUrl(data?.image);
	const hostname = (() => {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	})();
	return (
		<div className="overflow-hidden rounded-2xl">
			{safeImage ? (
				<img
					alt=""
					className="aspect-[1.91/1] w-full bg-muted object-cover"
					src={safeImage}
				/>
			) : (
				<div className="flex h-20 items-center justify-center bg-muted/60">
					<HugeiconsIcon
						className="size-6 text-muted-foreground"
						icon={Globe02Icon}
					/>
				</div>
			)}
			<div className="space-y-1 p-3">
				<p className="type-compact flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
					{data?.siteName || hostname}
				</p>
				<p className="line-clamp-2 font-medium text-sm leading-5">
					{data?.title || hostname}
				</p>
				{data?.description ? (
					<p className="line-clamp-3 text-muted-foreground text-xs leading-4">
						{data.description}
					</p>
				) : null}
				<p
					className="type-compact truncate pt-0.5 text-muted-foreground/70"
					title={url}
				>
					{url}
				</p>
			</div>
		</div>
	);
}

function FilePreviewCard({
	data,
	path,
}: {
	data: LinkPreviewReadFields | null | undefined;
	path: string;
}) {
	const name = data?.name ?? path.split(/[\\/]/).at(-1) ?? path;
	return (
		<div className="overflow-hidden rounded-2xl">
			<div className="flex items-center gap-2 border-border/60 border-b px-3 py-2.5">
				<FileTypeIcon className="size-5" path={path} />
				<div className="min-w-0">
					<p className="truncate font-medium text-sm" title={name}>
						{name}
					</p>
					<p
						className="type-compact truncate text-muted-foreground"
						title={path}
					>
						{path}
					</p>
				</div>
			</div>
			<div className="relative max-h-48 overflow-hidden bg-muted/35">
				<pre className="type-compact overflow-hidden whitespace-pre-wrap p-3 font-mono text-foreground/75 leading-4">
					{data?.snippet || "Preview unavailable"}
				</pre>
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-popover" />
			</div>
		</div>
	);
}

/** Hover/focus preview shared by Markdown links and plaintext user-message links. */
export function LinkPreview({
	children,
	resolvers,
	target,
}: {
	children: ReactElement;
	resolvers?: LinkPreviewResolvers;
	target: LinkTarget;
}) {
	const [open, setOpen] = useState(false);
	const cache = target.kind === "file" ? fileCache : websiteCache;
	const [preview, setPreview] = useState(() => cache.get(target.value));

	useEffect(() => {
		if (!open || cache.has(target.value)) {
			return;
		}
		let cancelled = false;
		if (target.kind === "file") {
			const request = resolvers?.previewFile?.(target.value);
			request
				?.then((value) => {
					if (!cancelled) {
						fileCache.set(target.value, value);
						setPreview(value);
					}
				})
				.catch(() => {
					if (!cancelled) {
						fileCache.set(target.value, null);
						setPreview(null);
					}
				});
		} else {
			const request = resolvers?.previewWebsite?.(target.value);
			request
				?.then((value) => {
					if (!cancelled) {
						websiteCache.set(target.value, value);
						setPreview(value);
					}
				})
				.catch(() => {
					if (!cancelled) {
						websiteCache.set(target.value, null);
						setPreview(null);
					}
				});
		}
		return () => {
			cancelled = true;
		};
	}, [cache, open, resolvers, target.kind, target.value]);

	return (
		<HoverCard onOpenChange={setOpen} open={open}>
			<HoverCardTrigger closeDelay={80} delay={220} render={children} />
			<LinkPreviewPopup>
				{target.kind === "file" ? (
					<FilePreviewCard data={preview} path={target.value} />
				) : (
					<WebsitePreviewCard data={preview} url={target.value} />
				)}
			</LinkPreviewPopup>
		</HoverCard>
	);
}
