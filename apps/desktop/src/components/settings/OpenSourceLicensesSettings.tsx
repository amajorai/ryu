import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useState } from "react";
import { SettingsCard } from "./shared/settings-items.tsx";

/**
 * The license artifact is intentionally loaded only when the reader opens. It
 * is several megabytes of legal text and should not slow down the normal
 * settings bundle or the first paint of the app.
 */
export function OpenSourceLicensesSettings() {
	const [open, setOpen] = useState(false);
	const [noticeText, setNoticeText] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);

	const loadNotices = () => {
		if (noticeText || loading) {
			return;
		}
		setLoading(true);
		setError(false);
		void import("@/src/lib/desktop-licenses.generated.ts")
			.then(({ DESKTOP_LICENSE_NOTICE_TEXT }) => {
				setNoticeText(DESKTOP_LICENSE_NOTICE_TEXT);
			})
			.catch(() => {
				setError(true);
			})
			.finally(() => {
				setLoading(false);
			});
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (next) {
			loadNotices();
		}
	};

	return (
		<>
			<div data-testid="open-source-licenses-row">
				<SettingsCard className="flex items-center justify-between gap-4">
					<div className="min-w-0 space-y-0.5">
						<p className="font-medium text-sm">Open source licenses</p>
						<p className="text-muted-foreground text-xs leading-relaxed">
							Third-party notices for bundled dependencies
						</p>
					</div>
					<Button
						aria-label="View open source licenses"
						onClick={() => handleOpenChange(true)}
						size="sm"
						variant="secondary"
					>
						View
					</Button>
				</SettingsCard>
			</div>

			<Dialog onOpenChange={handleOpenChange} open={open}>
				<DialogContent
					className="!w-[min(70rem,calc(100vw-2rem))] !max-w-none flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0"
					mobileFullPage
				>
					<DialogHeader className="shrink-0 border-border/60 border-b px-6 py-5 pr-14">
						<DialogTitle>Open source licenses</DialogTitle>
						<DialogDescription>
							Third-party notices for dependencies included in this app
						</DialogDescription>
					</DialogHeader>
					<ScrollArea className="min-h-0 flex-1 bg-muted/10">
						{loading ? (
							<div
								aria-live="polite"
								className="flex h-full min-h-48 items-center justify-center gap-2 p-6 text-muted-foreground text-sm"
							>
								<Spinner />
								Loading notices…
							</div>
						) : error ? (
							<div className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
								<p className="text-muted-foreground text-sm">
									The license notices could not be loaded.
								</p>
								<Button onClick={loadNotices} size="sm" variant="secondary">
									Try again
								</Button>
							</div>
						) : (
							<pre className="select-text whitespace-pre-wrap break-words p-6 font-mono text-[11px] text-foreground/90 leading-relaxed md:text-xs">
								{noticeText}
							</pre>
						)}
					</ScrollArea>
				</DialogContent>
			</Dialog>
		</>
	);
}
