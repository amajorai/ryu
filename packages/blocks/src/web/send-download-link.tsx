"use client";

import {
	type ComponentType,
	lazy,
	type MouseEvent,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useState,
} from "react";
import type { DownloadSendDrawerProps } from "./download-send-drawer.tsx";
import {
	DOWNLOAD_PAGE_PATH,
	isMobileVisitor,
	readMobileVisitorEnv,
} from "./download-share-links.ts";
import { whenBrowserIdle } from "./when-browser-idle.ts";

// The drawer (and vaul with it) is only for phone visitors, and every public
// page mounts a Download button, so it loads once a phone is detected and the
// browser is idle, not with the page. If its chunk cannot load, tapping
// Download goes to the download page instead of doing nothing.
const loadDrawer = () => import("./download-send-drawer.tsx");

function OpenDownloadPage({ siteOrigin = "" }: DownloadSendDrawerProps) {
	useEffect(() => {
		window.location.assign(`${siteOrigin}${DOWNLOAD_PAGE_PATH}`);
	}, [siteOrigin]);
	return null;
}

const LazyDownloadSendDrawer = lazy<ComponentType<DownloadSendDrawerProps>>(
	() =>
		loadDrawer().then(
			(module) => ({ default: module.DownloadSendDrawer }),
			() => ({ default: OpenDownloadPage })
		)
);

/**
 * Whether this visitor is on a phone or tablet. False on the server and on the
 * first client render, so the server HTML and hydration are the desktop markup.
 */
export function useMobileVisitor(): boolean {
	const [mobile, setMobile] = useState(false);
	useEffect(() => {
		setMobile(isMobileVisitor(readMobileVisitorEnv()));
	}, []);
	return mobile;
}

/**
 * On a phone, a Download control opens the "send the link to yourself" drawer
 * instead of fetching a desktop installer. `intercept` is the click handler to
 * put on that control: it does nothing off a phone, so desktop behaves as
 * before. `drawer` is the element to render next to the control.
 */
export function useSendDownloadLink(siteOrigin?: string): {
	drawer: ReactNode;
	intercept: (event: MouseEvent<HTMLElement>) => void;
	mobile: boolean;
} {
	const mobile = useMobileVisitor();
	const [open, setOpen] = useState(false);
	const [requested, setRequested] = useState(false);

	useEffect(() => {
		if (!mobile) {
			return;
		}
		return whenBrowserIdle(() => {
			loadDrawer().catch(() => {
				// The tap falls back to the download page (OpenDownloadPage).
			});
		});
	}, [mobile]);

	const intercept = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			if (!mobile) {
				return;
			}
			event.preventDefault();
			setRequested(true);
			setOpen(true);
		},
		[mobile]
	);

	const drawer =
		mobile && requested ? (
			<Suspense fallback={null}>
				<LazyDownloadSendDrawer
					onOpenChange={setOpen}
					open={open}
					{...(siteOrigin ? { siteOrigin } : {})}
				/>
			</Suspense>
		) : null;

	return { drawer, intercept, mobile };
}
