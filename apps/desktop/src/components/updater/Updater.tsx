import {
	AlertCircleIcon,
	CheckmarkCircle01Icon,
	Download01Icon,
	Loading01Icon,
	Refresh01Icon,
	Share08Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { ScrollArea } from "@ryu/ui/components/scroll-area";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";

type UpdateState =
	| "checking"
	| "available"
	| "downloading"
	| "installing"
	| "ready"
	| "error"
	| "uptodate"
	| "failed";

interface DownloadProgress {
	contentLength: number;
	downloaded: number;
	percentage: number;
}

export function Updater() {
	const [updateState, setUpdateState] = useState<UpdateState>("uptodate");
	const [update, setUpdate] = useState<Update | null>(null);
	const [progress, setProgress] = useState<DownloadProgress>({
		downloaded: 0,
		contentLength: 0,
		percentage: 0,
	});

	const [isPopoverOpen, setIsPopoverOpen] = useState(false);
	const [manualClose, setManualClose] = useState(false);

	const checkForUpdates = useCallback(async () => {
		try {
			setUpdateState("checking");

			const foundUpdate = await check();
			if (foundUpdate) {
				setUpdate(foundUpdate);
				setUpdateState("available");
			} else {
				setUpdateState("uptodate");
			}
		} catch (err) {
			console.error("Failed to check for updates:", err);
			setUpdateState("error");
			setIsPopoverOpen(false);
		}
	}, []);

	const downloadAndInstall = async () => {
		if (!update) {
			return;
		}

		try {
			setUpdateState("downloading");
			setProgress({ downloaded: 0, contentLength: 0, percentage: 0 });

			await update.downloadAndInstall((event) => {
				switch (event.event) {
					case "Started":
						setProgress((prev) => ({
							...prev,
							contentLength: event.data.contentLength || 0,
						}));
						break;

					case "Progress":
						setProgress((prev) => {
							const downloaded = prev.downloaded + event.data.chunkLength;
							const percentage =
								prev.contentLength > 0
									? Math.round((downloaded / prev.contentLength) * 100)
									: 0;

							return {
								downloaded,
								contentLength: prev.contentLength,
								percentage,
							};
						});
						break;

					case "Finished":
						setUpdateState("installing");
						break;

					default:
						break;
				}
			});

			setUpdateState("ready");

			// Auto-relaunch after a short delay to show success state
			setTimeout(async () => {
				await relaunch();
			}, 2000);
		} catch (err) {
			console.error("Failed to download/install update:", err);
			setUpdateState("failed");
			// Keep the popover open so user can try again
			setIsPopoverOpen(true);
		}
	};

	// Check for updates on component mount
	useEffect(() => {
		checkForUpdates();
	}, [checkForUpdates]);

	// Helper functions for button state
	const getButtonContent = () => {
		switch (updateState) {
			case "downloading":
				return (
					<>
						<HugeiconsIcon
							className="mr-2 h-4 w-4 animate-spin"
							icon={Refresh01Icon}
						/>
						Downloading... {progress.percentage}%
					</>
				);
			case "installing":
				return (
					<>
						<HugeiconsIcon
							className="mr-2 h-4 w-4 animate-spin"
							icon={Refresh01Icon}
						/>
						Installing...
					</>
				);
			case "ready":
				return (
					<>
						<HugeiconsIcon
							className="mr-2 h-4 w-4"
							icon={CheckmarkCircle01Icon}
						/>
						Ready - Restarting...
					</>
				);
			case "error":
				return (
					<>
						<HugeiconsIcon className="mr-2 h-4 w-4" icon={AlertCircleIcon} />
						Try Again
					</>
				);
			default:
				return (
					<>
						<HugeiconsIcon className="mr-2 h-4 w-4" icon={Download01Icon} />
						Download & Install Update
					</>
				);
		}
	};

	const getButtonDisabled = () =>
		["downloading", "installing", "ready"].includes(updateState);

	const getButtonOnClick = () =>
		updateState === "error" ? checkForUpdates : downloadAndInstall;

	// Handle popover open/close with manual control
	const handlePopoverOpenChange = (open: boolean) => {
		// Prevent closing during active operations unless manually triggered
		const isActiveOperation = ["downloading", "installing", "ready"].includes(
			updateState
		);

		if (open) {
			setIsPopoverOpen(true);
			setManualClose(false);
		} else if (!isActiveOperation || manualClose) {
			setIsPopoverOpen(false);
			setManualClose(false);
		}
	};

	// Handle manual trigger click
	const handleTriggerClick = () => {
		setManualClose(!isPopoverOpen);
		setIsPopoverOpen(!isPopoverOpen);
	};

	// Only show updater when there's an update available or during active operations
	if (updateState === "uptodate" || updateState === "error") {
		return null;
	}

	return (
		<Popover onOpenChange={handlePopoverOpenChange} open={isPopoverOpen}>
			<PopoverTrigger
				render={
					<Button
						aria-label={`Update available: ${update?.version}`}
						className="cursor-pointer"
						disabled={updateState === "checking"}
						onClick={handleTriggerClick}
						size="icon"
						title={`Update available: ${update?.version}`}
					/>
				}
			>
				{updateState === "checking" ? (
					<HugeiconsIcon
						className="h-4 w-4 animate-spin"
						icon={Loading01Icon}
					/>
				) : (
					<HugeiconsIcon className="h-4 w-4" icon={Download01Icon} />
				)}
			</PopoverTrigger>

			<PopoverContent
				align="end"
				className="w-screen select-none overflow-hidden border border-input/50 p-0"
				side="bottom"
				sideOffset={8}
			>
				<ScrollArea className="h-[calc(100vh-10rem)]">
					<div className="space-y-4 p-6">
						{/* Update Header */}
						<div className="border-input/50 border-b pb-2">
							<h1 className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text font-medium text-lg text-transparent">
								Update Available
							</h1>
							<p className="text-muted-foreground text-xs leading-relaxed">
								A new version ({update?.version}) is available. Here's what's
								new:
							</p>
						</div>

						{/* Release Notes */}
						<div className="prose prose-sm dark:prose-invert max-w-none">
							{update?.body ? (
								<div className="whitespace-pre-wrap">{update.body}</div>
							) : (
								<p className="text-muted-foreground text-sm">
									Release notes not available for this version.
								</p>
							)}
						</div>
					</div>
				</ScrollArea>

				{/* Fixed Download Section */}
				<div className="space-y-3 border-input/50 border-t p-4">
					<Button
						className="w-full"
						disabled={getButtonDisabled()}
						onClick={getButtonOnClick()}
						variant={updateState === "failed" ? "destructive" : "default"}
					>
						{getButtonContent()}
					</Button>

					<div className="text-center">
						<p className="text-muted-foreground text-xs">
							Having trouble downloading?{" "}
							<a
								className="inline-flex items-center gap-1 text-info underline hover:text-info"
								href={"https://ryu.com/downloads?ref=ryu-app"}
								rel="noopener noreferrer"
								target="_blank"
							>
								Download manually
								<HugeiconsIcon className="h-3 w-3" icon={Share08Icon} />
							</a>
						</p>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
