"use client";

// The post-download guide's dialog body, loaded on demand by
// download-guide-overlay.tsx. It reads the visitor's browser once, then lays
// out: where the file went (with a mock of that browser's toolbar and its
// downloads shortcut), how to install it, and a way out if nothing happened.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { BookOpen, CircleCheck, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { docsHref } from "./data/resources.tsx";
import {
	browserDownloadHint,
	DEFAULT_INSTALLER_FORMAT,
	detectGuideBrowser,
	type GuideBrowser,
	installerFormatOf,
	installGuide,
} from "./download-guide.ts";
import {
	BrowserToolbarMock,
	DownloadCornerPointer,
	ShortcutKeys,
} from "./download-guide-browser.tsx";
import { browserChromeDirection } from "./download-guide-direction.ts";
import type { DownloadGuideOverlayProps } from "./download-guide-overlay.tsx";
import { InstallSteps } from "./download-guide-steps.tsx";
import { archLabel, detectDownloadOS, osName } from "./download-platform.ts";
import { OS_SVGL, SvglIcon } from "./svgl-icon.tsx";

export const INSTALL_DOCS_PATH = "/docs/start-here/getting-started/install";

const FOOTER_LINK_CLASS =
	"inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-muted-foreground text-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

export function DownloadGuidePanel({
	browser: browserOverride,
	detail,
	onOpenChange,
	open,
}: DownloadGuideOverlayProps & {
	/** Tests pin the browser; the page detects it. */
	browser?: GuideBrowser;
}) {
	const tl = useLiteralMessages();
	const [detected] = useState(() => detectGuideBrowser());
	// The shortcut and window controls belong to the machine the visitor is
	// browsing on, which can differ from the installer they picked (a Mac
	// visitor downloading the Linux .deb still presses ⌘J in Firefox).
	const [visitorOs] = useState(() => detectDownloadOS());
	// The browser's own UI direction: an RTL browser moves its download
	// control to the top-left, whatever language Ryu is shown in.
	const [chromeDir] = useState(() => browserChromeDirection());
	// Focus lands on the heading, not a control: the first link re-triggers the
	// download, and focusing the footer would scroll a tall dialog past its
	// own header on short windows.
	const titleRef = useRef<HTMLHeadingElement>(null);
	const browser = browserOverride ?? detected;
	const hint = browserDownloadHint(browser, visitorOs);
	const format =
		(detail.assetName ? installerFormatOf(detail.assetName) : null) ??
		DEFAULT_INSTALLER_FORMAT[detail.os];
	const guide = installGuide(detail.os, format, detail.assetName ?? undefined);
	const fileName = detail.assetName ?? "Ryu installer";
	const platform = detail.arch
		? `${osName(detail.os)} · ${archLabel(detail.os, detail.arch)}`
		: osName(detail.os);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			{open && hint.pointsTopRight ? (
				<DownloadCornerPointer dir={chromeDir} name={hint.name} />
			) : null}
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] gap-0 overflow-y-auto bg-popover/95 p-0 sm:max-w-5xl"
				data-testid="download-guide"
				initialFocus={titleRef}
				overlayClassName="bg-background/60 backdrop-blur-md"
				showCloseButton={false}
			>
				<div className="grid gap-6 p-6 sm:p-8">
					<div className="flex flex-col items-center gap-3 text-center">
						<span className="relative flex size-11 items-center justify-center rounded-full bg-primary/12 text-primary">
							<CircleCheck aria-hidden="true" className="size-6" />
						</span>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
							Thanks for downloading Ryu
						</p>
						<DialogTitle
							className="text-balance font-heading font-medium text-3xl leading-tight tracking-[-0.02em] outline-none sm:text-4xl"
							ref={titleRef}
							tabIndex={-1}
						>
							Your download has started
						</DialogTitle>
						<DialogDescription className="flex max-w-xl flex-wrap items-center justify-center gap-x-2 gap-y-1 text-base">
							<span className="inline-flex items-center gap-1.5">
								<SvglIcon size={16} spec={OS_SVGL[detail.os]} />
								{platform}
							</span>
							<span aria-hidden="true">·</span>
							<span className="break-all font-mono text-foreground text-sm">
								{fileName}
							</span>
						</DialogDescription>
					</div>

					<section
						aria-labelledby="download-guide-find"
						className="grid items-center gap-6 rounded-3xl bg-muted/40 p-5 sm:p-6 md:grid-cols-[1.1fr_1fr]"
					>
						<BrowserToolbarMock
							dir={chromeDir}
							fileName={fileName}
							hint={hint}
							os={visitorOs}
						/>
						<div className="flex flex-col gap-3">
							<h3
								className="font-heading font-medium text-foreground text-xl"
								id="download-guide-find"
							>
								{hint.pointsTopRight
									? tl("Find it in {browser}", { browser: hint.name })
									: "Find the installer"}
							</h3>
							<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
								{hint.where}
							</p>
							{hint.shortcut ? (
								<p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
									Or press
									<ShortcutKeys shortcut={hint.shortcut} />
									to open your downloads.
								</p>
							) : null}
						</div>
					</section>

					<section aria-labelledby="download-guide-install">
						<h3
							className="mb-4 font-heading font-medium text-foreground text-xl"
							id="download-guide-install"
						>
							{tl("Install Ryu on {osName}", { osName: osName(detail.os) })}
						</h3>
						<InstallSteps guide={guide} />
					</section>
				</div>

				<div className="flex flex-col items-center justify-between gap-3 border-border/60 border-t px-6 py-4 sm:flex-row sm:px-10">
					<div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
						<a
							className={FOOTER_LINK_CLASS}
							download={detail.assetName ?? ""}
							href={detail.href}
						>
							<RotateCcw aria-hidden="true" className="size-3.5" />
							Download didn't start? Try again
						</a>
						<a
							className={FOOTER_LINK_CLASS}
							href={docsHref(INSTALL_DOCS_PATH)}
							rel="noopener noreferrer"
							target="_blank"
						>
							<BookOpen aria-hidden="true" className="size-3.5" />
							Need help? Read the install guide
						</a>
					</div>
					<DialogClose render={<Button size="sm" variant="secondary" />}>
						Close
					</DialogClose>
				</div>
			</DialogContent>
		</Dialog>
	);
}
