import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useRef, useState } from "react";
import licenseNoticesUrl from "@/src/lib/desktop-licenses.generated.txt?url";
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
	const request = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			const pending = request.current;
			request.current = null;
			pending?.abort();
		},
		[]
	);

	const loadNotices = () => {
		if (noticeText || loading || request.current) {
			return;
		}
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		setError(false);
		// Fetching the emitted text asset permits an explicit retry after delivery
		// failure; browser module loaders cache a rejected dynamic import.
		void fetch(licenseNoticesUrl, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) {
					throw new Error("License notices unavailable");
				}
				return response.text();
			})
			.then((text) => {
				if (request.current === controller && !controller.signal.aborted) {
					setNoticeText(text);
				}
			})
			.catch(() => {
				if (request.current === controller && !controller.signal.aborted) {
					setError(true);
				}
			})
			.finally(() => {
				if (request.current !== controller || controller.signal.aborted) {
					return;
				}
				request.current = null;
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
				<DialogContent appearance="license-browser" mobileFullPage>
					<DialogHeader className="shrink-0" purpose="license-browser">
						<DialogTitle>Open source licenses</DialogTitle>
						<DialogDescription>
							Third-party notices for dependencies included in this app
						</DialogDescription>
					</DialogHeader>
					<ScrollArea appearance="licenses" className="min-h-0 flex-1">
						{loading ? (
							<SkeletonRows
								label="Loading notices…"
								rows={6}
								spacing="library"
							/>
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
							<pre className="select-text whitespace-pre-wrap break-words p-6 font-mono text-foreground/90 text-xs leading-relaxed md:text-xs">
								{noticeText}
							</pre>
						)}
					</ScrollArea>
				</DialogContent>
			</Dialog>
		</>
	);
}
