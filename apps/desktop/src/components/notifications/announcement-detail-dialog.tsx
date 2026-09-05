import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { AnnouncementVisual } from "@ryu/ui/components/announcement-visual.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import type { Announcement } from "@/src/lib/api/announcements.ts";

interface AnnouncementDetailDialogProps {
	announcement: Announcement | null;
	onOpenChange: (open: boolean) => void;
	onOpenLink: (announcement: Announcement) => void;
	open: boolean;
}

/** The only surface that mounts announcement artwork and admin-authored scenes. */
export function AnnouncementDetailDialog({
	announcement,
	onOpenChange,
	onOpenLink,
	open,
}: AnnouncementDetailDialogProps) {
	if (!announcement) {
		return null;
	}

	const usesAppIconTile = Boolean(
		announcement.visualIconBackground || announcement.visualIconDither
	);
	const appIcon = usesAppIconTile ? (
		<div data-slot="announcement-visual-app-icon">
			<AppIcon
				className="size-32"
				dither={announcement.visualIconDither}
				iconBackground={announcement.visualIconBackground}
				iconId={announcement.visualIcon}
				iconUrl={announcement.visualIconUrl}
				name={announcement.title}
				seedId={announcement.id}
				size={96}
				variant="hero"
			/>
		</div>
	) : null;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				className="max-h-[min(90vh,48rem)] max-w-2xl overflow-y-auto p-0 sm:max-w-2xl"
				data-testid="announcement-detail-dialog"
				overlayClassName="bg-black/55 backdrop-blur-sm"
			>
				<AnnouncementVisual
					accent={announcement.color}
					backgroundColors={announcement.blobColors}
					className="min-h-[17rem] rounded-none sm:min-h-[20rem] sm:rounded-t-4xl"
					iconContent={appIcon}
					iconId={usesAppIconTile ? null : announcement.visualIcon}
					iconImageUrl={usesAppIconTile ? null : announcement.visualIconUrl}
					imageUrl={announcement.iconUrl}
					seed={announcement.id}
					visualCode={announcement.visualCode}
				/>
				<div className="flex flex-col gap-6 p-6 sm:p-8">
					<DialogHeader className="gap-2 pr-8">
						<p className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
							Product update
						</p>
						<DialogTitle className="font-medium text-2xl tracking-tight sm:text-3xl">
							{announcement.title}
						</DialogTitle>
						{announcement.body ? (
							<DialogDescription className="max-w-xl text-sm leading-6">
								{announcement.body}
							</DialogDescription>
						) : null}
					</DialogHeader>

					<DialogFooter className="flex-col-reverse justify-between gap-3 sm:flex-row sm:items-center">
						<p className="text-muted-foreground text-xs">
							The latest updates from the Ryu team.
						</p>
						<div className="flex items-center gap-2">
							{announcement.linkUrl ? (
								<Button
									onClick={() => {
										onOpenLink(announcement);
										onOpenChange(false);
									}}
									type="button"
								>
									{announcement.linkLabel || "Learn more"}
									<HugeiconsIcon
										className="size-3.5"
										icon={ArrowUpRight01Icon}
									/>
								</Button>
							) : null}
							<DialogClose
								render={<Button type="button" variant="secondary" />}
							>
								Done
							</DialogClose>
						</div>
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}
