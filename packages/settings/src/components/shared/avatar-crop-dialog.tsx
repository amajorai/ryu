import {
	ArrowLeft01Icon,
	SearchAddIcon,
	SearchMinusIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Slider } from "@ryu/ui/components/slider.tsx";
import type { CSSProperties } from "react";
import type { Area } from "./avatar-crop-image.ts";

interface CropPreviewStyle extends CSSProperties {
	"--crop-image": string;
	"--crop-zoom": number;
}
interface CropAreaStyle extends CSSProperties {
	"--crop-height": string;
	"--crop-left": string;
	"--crop-top": string;
	"--crop-width": string;
}

export interface AvatarCropDialogProps {
	croppedAreaPixels: Area | null;
	onApply: () => void;
	onCancel: () => void;
	onOpenChange: (open: boolean) => void;
	onZoomChange: (zoom: number) => void;
	open: boolean;
	previewUrl: string | null;
	zoom: number;
}

/** The crop step of `AvatarUploadCropper`: preview, crop frame and zoom. */
export function AvatarCropDialog({
	croppedAreaPixels,
	onApply,
	onCancel,
	onOpenChange,
	onZoomChange,
	open,
	previewUrl,
	zoom,
}: AvatarCropDialogProps) {
	const cropPreviewStyle: CropPreviewStyle = {
		"--crop-image": `url(${previewUrl})`,
		"--crop-zoom": zoom,
	};
	const cropAreaStyle: CropAreaStyle | undefined = croppedAreaPixels
		? {
				"--crop-left": `${croppedAreaPixels.x}px`,
				"--crop-top": `${croppedAreaPixels.y}px`,
				"--crop-width": `${croppedAreaPixels.width}px`,
				"--crop-height": `${croppedAreaPixels.height}px`,
			}
		: undefined;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-140" showCloseButton={false}>
				<DialogDescription className="sr-only">
					Crop image dialog
				</DialogDescription>
				<DialogHeader className="contents text-left">
					<DialogTitle className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<Button
								aria-label="Cancel"
								className="-my-1"
								onClick={onCancel}
								size="icon-sm"
								type="button"
								variant="ghost-muted"
							>
								<HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
							</Button>
							<span>Crop image</span>
						</div>
						<Button
							autoFocus
							disabled={!(previewUrl && croppedAreaPixels)}
							onClick={onApply}
							size="sm"
							variant="mono"
						>
							Apply
						</Button>
					</DialogTitle>
				</DialogHeader>
				{previewUrl && (
					<div className="relative flex h-96 items-center justify-center overflow-hidden sm:h-120">
						<div
							aria-label="Crop preview"
							className="bg-(image:--crop-image) size-full scale-(--crop-zoom) bg-center bg-contain bg-no-repeat"
							role="img"
							style={cropPreviewStyle}
						/>
						{croppedAreaPixels && (
							<div
								className="pointer-events-none absolute top-(--crop-top) left-(--crop-left) h-(--crop-height) w-(--crop-width) border-2 border-primary bg-primary/10"
								style={cropAreaStyle}
							/>
						)}
					</div>
				)}
				<DialogFooter>
					<div className="mx-auto flex w-full max-w-80 items-center gap-4">
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={SearchMinusIcon}
							size={16}
						/>
						<Slider
							aria-label="Zoom slider"
							defaultValue={[1]}
							max={3}
							min={1}
							onValueChange={(value) =>
								onZoomChange(Array.isArray(value) ? value[0] : value)
							}
							step={0.1}
							value={[zoom]}
						/>
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={SearchAddIcon}
							size={16}
						/>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
