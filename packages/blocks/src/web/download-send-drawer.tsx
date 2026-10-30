"use client";

import { Button } from "@ryu/ui/components/button";
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
} from "@ryu/ui/components/drawer.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Copy, Mail, MessageCircle, Share } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { WEBAPP_URL } from "./download-catalog.tsx";
import {
	DOWNLOAD_PAGE_PATH,
	DOWNLOAD_SHARE_TEXT,
	DOWNLOAD_SHARE_TITLE,
	downloadPageUrl,
	emailShareUrl,
	readMobileVisitorEnv,
	smsPlatformFor,
	smsShareUrl,
	telegramShareUrl,
	whatsappShareUrl,
} from "./download-share-links.ts";

export interface DownloadSendDrawerProps {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	/** Absolute origin of the marketing site when rendered on another host. */
	siteOrigin?: string;
}

type CopyState = "copied" | "failed" | "idle";

const COPY_STATUS: Record<CopyState, string> = {
	copied: "Link copied",
	failed:
		"Couldn't copy the link. It's selected above, so you can copy it yourself.",
	idle: "",
};

interface ShareTarget {
	external: boolean;
	href: string;
	icon: ReactNode;
	label: string;
}

const FOOTER_LINK_CLASS = cn(
	"rounded-full px-3 py-1.5 text-muted-foreground text-sm underline-offset-4 outline-none",
	"hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
);

const SHARE_ICON_CLASS =
	"flex size-12 items-center justify-center rounded-full bg-muted text-foreground [&_svg]:size-5";

function BrandMark({ origin, slug }: { origin: string; slug: string }) {
	// Brand marks live in the web app's public `/logos`; prefix the site origin
	// so the docs site (which has no copy of these) still shows them.
	return (
		<img
			alt=""
			aria-hidden="true"
			className="size-6 object-contain"
			draggable={false}
			height={24}
			src={`${origin}/logos/${slug}.svg`}
			width={24}
		/>
	);
}

function shareTargets(siteOrigin: string, url: string): ShareTarget[] {
	const smsPlatform = smsPlatformFor(readMobileVisitorEnv());
	return [
		{
			external: true,
			href: whatsappShareUrl(DOWNLOAD_SHARE_TEXT, url),
			icon: <BrandMark origin={siteOrigin} slug="whatsapp" />,
			label: "WhatsApp",
		},
		{
			external: true,
			href: telegramShareUrl(DOWNLOAD_SHARE_TEXT, url),
			icon: <BrandMark origin={siteOrigin} slug="telegram" />,
			label: "Telegram",
		},
		{
			external: false,
			href: smsShareUrl(DOWNLOAD_SHARE_TEXT, url, smsPlatform),
			icon: <MessageCircle aria-hidden="true" />,
			label: "Messages",
		},
		{
			external: false,
			href: emailShareUrl(DOWNLOAD_SHARE_TITLE, DOWNLOAD_SHARE_TEXT, url),
			icon: <Mail aria-hidden="true" />,
			label: "Email",
		},
	];
}

/**
 * Radix skips links when it picks what to focus on open, which would land on
 * the read-only link field and select it. Start on the first way to send the
 * link instead: the share button when there is one, else the first app.
 */
function focusFirstAction(event: Event) {
	const content = event.target;
	if (!(content instanceof HTMLElement)) {
		return;
	}
	const first = content.querySelector<HTMLElement>(
		"[data-send-action], [data-share-target]"
	);
	if (first) {
		event.preventDefault();
		first.focus();
	}
}

/**
 * What a phone visitor sees when they tap Download: Ryu installs on a
 * computer, so the drawer helps them send the download page to themselves
 * (the system share sheet, a messaging app, or email), copy the link, or open
 * the full download page anyway.
 */
export function DownloadSendDrawer({
	onOpenChange,
	open,
	siteOrigin = "",
}: DownloadSendDrawerProps) {
	// Rendered only after a tap on the client, so `window` is always there.
	const [url] = useState(() =>
		downloadPageUrl(siteOrigin || window.location.origin)
	);
	const [canShare, setCanShare] = useState(false);
	const [copyState, setCopyState] = useState<CopyState>("idle");
	const urlFieldRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setCanShare(typeof navigator.share === "function");
	}, []);

	useEffect(() => {
		if (copyState !== "copied") {
			return;
		}
		const timer = window.setTimeout(() => setCopyState("idle"), 2000);
		return () => window.clearTimeout(timer);
	}, [copyState]);

	// `navigator.share` must be the first thing the tap does: anything awaited
	// before it spends the user activation and Safari refuses the share.
	const share = () => {
		navigator
			.share({ text: DOWNLOAD_SHARE_TEXT, title: DOWNLOAD_SHARE_TITLE, url })
			.catch(() => {
				// Closing the share sheet rejects with AbortError; nothing to report.
			});
	};

	// When the browser refuses the clipboard, select the link so the visitor
	// can copy it with the system menu instead.
	const copyFailed = () => {
		setCopyState("failed");
		urlFieldRef.current?.focus();
		urlFieldRef.current?.select();
	};

	const copy = () => {
		if (!navigator.clipboard) {
			copyFailed();
			return;
		}
		navigator.clipboard
			.writeText(url)
			.then(() => {
				setCopyState("copied");
				toast.success("Link copied");
			})
			.catch(copyFailed);
	};

	const copied = copyState === "copied";

	return (
		// vaul cancels the dialog's open auto-focus unless `autoFocus` is set,
		// which would leave focus on the (now aria-hidden) Download trigger.
		// The content sits above the cookie banner (z-[60]), which would
		// otherwise cover the share row for every first-time visitor.
		<Drawer autoFocus onOpenChange={onOpenChange} open={open}>
			<DrawerContent
				className="z-[70]"
				data-testid="download-send-drawer"
				onOpenAutoFocus={focusFirstAction}
			>
				<DrawerHeader>
					<DrawerTitle>Ryu runs on your computer</DrawerTitle>
					<DrawerDescription>
						Send yourself the link and open it on your Mac, Windows or Linux
						machine.
					</DrawerDescription>
				</DrawerHeader>
				<div className="grid gap-4 px-4">
					{canShare ? (
						<Button
							className="w-full"
							data-send-action=""
							onClick={share}
							radius="pill"
							size="lg"
							type="button"
							variant="mono"
						>
							<Share aria-hidden="true" />
							Send link to yourself
						</Button>
					) : null}
					<ul
						aria-label="Send the link with"
						className="grid grid-cols-4 gap-2"
					>
						{shareTargets(siteOrigin, url).map((target) => (
							<li key={target.label}>
								<a
									className="flex flex-col items-center gap-1.5 rounded-2xl py-2 font-medium text-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
									data-share-target={target.label.toLowerCase()}
									href={target.href}
									{...(target.external
										? { rel: "noopener noreferrer", target: "_blank" }
										: {})}
								>
									<span className={SHARE_ICON_CLASS}>{target.icon}</span>
									{target.label}
								</a>
							</li>
						))}
					</ul>
					<div className="flex items-center gap-2 rounded-full border border-border bg-background/60 p-1 ps-4">
						<input
							aria-label="Download link"
							className="min-w-0 flex-1 truncate bg-transparent text-muted-foreground outline-none"
							onFocus={(event) => event.currentTarget.select()}
							readOnly
							ref={urlFieldRef}
							type="url"
							value={url}
						/>
						<Button
							onClick={copy}
							radius="pill"
							size="sm"
							type="button"
							variant="secondary"
						>
							{copied ? (
								<Check aria-hidden="true" />
							) : (
								<Copy aria-hidden="true" />
							)}
							{copied ? "Copied" : "Copy link"}
						</Button>
					</div>
					<p
						aria-live="polite"
						className={cn(
							"text-center text-muted-foreground text-xs",
							copyState === "failed" ? null : "sr-only"
						)}
					>
						{COPY_STATUS[copyState]}
					</p>
				</div>
				<DrawerFooter className="flex-row flex-wrap justify-center gap-x-2 gap-y-1 pb-[calc(1rem+env(safe-area-inset-bottom))]">
					<a
						className={FOOTER_LINK_CLASS}
						href={WEBAPP_URL}
						rel="noopener noreferrer"
					>
						Open the web app
					</a>
					<a
						className={FOOTER_LINK_CLASS}
						href={`${siteOrigin}${DOWNLOAD_PAGE_PATH}`}
						onClick={() => onOpenChange(false)}
					>
						See all download options
					</a>
				</DrawerFooter>
			</DrawerContent>
		</Drawer>
	);
}
