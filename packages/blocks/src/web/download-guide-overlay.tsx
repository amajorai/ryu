"use client";

// The post-download guide: "Your download has started", where the browser put
// the file, and how to install it. Every Download button mounts a
// `DownloadGuideHost`, so this module is in every public page's header chunk
// and stays tiny: the subscription, a singleton claim, and a lazy door to the
// dialog body (download-guide-panel.tsx), which loads on the first sign of
// intent (`preloadDownloadGuide`) or when a download actually starts.

import {
	type ComponentType,
	lazy,
	Suspense,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import {
	isMobileVisitor,
	readMobileVisitorEnv,
} from "./download-share-links.ts";
import {
	type DownloadStartedDetail,
	subscribeDownloadStarted,
} from "./download-started.ts";

export interface DownloadGuideOverlayProps {
	detail: DownloadStartedDetail;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

const loadPanel = () => import("./download-guide-panel.tsx");

/** Nothing to show when the chunk cannot load: the download itself still runs. */
function NoGuide(_props: DownloadGuideOverlayProps) {
	return null;
}

const LazyDownloadGuidePanel = lazy<ComponentType<DownloadGuideOverlayProps>>(
	() =>
		loadPanel().then(
			(module) => ({ default: module.DownloadGuidePanel }),
			() => ({ default: NoGuide })
		)
);

/** Warm the guide's chunk when a visitor reaches for a Download button. */
export function preloadDownloadGuide(): void {
	loadPanel().catch(() => {
		// Retried by React.lazy when a download starts; nothing to report here.
	});
}

/** The presentational dialog; its body loads on demand. */
export function DownloadGuideOverlay(props: DownloadGuideOverlayProps) {
	return (
		<Suspense fallback={null}>
			<LazyDownloadGuidePanel {...props} />
		</Suspense>
	);
}

// A page can carry several Download buttons (header, hero, footer), each with
// its own host. Only the earliest mounted host still on the page renders the
// guide, so one download never stacks several dialogs; when it unmounts the
// next one takes over.
const hostTokens: symbol[] = [];
const ownerListeners = new Set<() => void>();

function notifyOwnerChange() {
	for (const listener of ownerListeners) {
		listener();
	}
}

function claimHost(token: symbol): () => void {
	hostTokens.push(token);
	notifyOwnerChange();
	return () => {
		const index = hostTokens.indexOf(token);
		if (index !== -1) {
			hostTokens.splice(index, 1);
		}
		notifyOwnerChange();
	};
}

function subscribeOwner(listener: () => void): () => void {
	ownerListeners.add(listener);
	return () => ownerListeners.delete(listener);
}

function currentOwner(): symbol | null {
	return hostTokens[0] ?? null;
}

function serverOwner(): symbol | null {
	return null;
}

/**
 * Opens the guide when a download is announced. Safe to mount many times; only
 * one instance on the page renders it. Phones never see it: a phone's
 * Download button sends the link to a computer instead.
 */
export function DownloadGuideHost() {
	const [token] = useState(() => Symbol("download-guide-host"));
	const owner = useSyncExternalStore(subscribeOwner, currentOwner, serverOwner);
	const isOwner = owner === token;
	const [detail, setDetail] = useState<DownloadStartedDetail | null>(null);
	const [open, setOpen] = useState(false);

	useEffect(() => claimHost(token), [token]);

	useEffect(() => {
		if (!isOwner) {
			return;
		}
		return subscribeDownloadStarted((started) => {
			if (isMobileVisitor(readMobileVisitorEnv())) {
				return;
			}
			setDetail(started);
			setOpen(true);
		});
	}, [isOwner]);

	if (!(isOwner && detail)) {
		return null;
	}
	return (
		<DownloadGuideOverlay detail={detail} onOpenChange={setOpen} open={open} />
	);
}
