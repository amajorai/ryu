"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { useSendDownloadLink } from "./send-download-link.tsx";

/**
 * The raised Download action in the mobile bottom bar. It links to the
 * download page, and on a phone it opens the drawer that sends that page to
 * the visitor's computer instead (Ryu installs there, not on the phone).
 */
export function MobileNavDownloadAction({
	active,
	onOpen,
}: {
	active: boolean;
	/** Runs before the drawer opens, e.g. to close an open nav sheet. */
	onOpen?: () => void;
}) {
	const sendLink = useSendDownloadLink();
	const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (sendLink.mobile) {
			onOpen?.();
		}
		sendLink.intercept(event);
	};
	return (
		<>
			<Link
				aria-current={active ? "page" : undefined}
				className="absolute -top-5 flex size-14 items-center justify-center rounded-full bg-foreground text-background shadow-lg outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-95"
				href="/download"
				onClick={handleClick}
			>
				<Download aria-hidden="true" className="size-6" />
				<span className="sr-only">Download</span>
			</Link>
			{sendLink.drawer}
		</>
	);
}
