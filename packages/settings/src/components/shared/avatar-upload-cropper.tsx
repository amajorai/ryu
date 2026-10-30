import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { sileo } from "sileo";
import { z } from "zod";
import { useFileUpload } from "../../hooks/useFileUpload.ts";
import { settingsApi } from "../../utils/api-client.ts";
import { AvatarCropDialog } from "./avatar-crop-dialog.tsx";
import { type Area, createImage, getCroppedImg } from "./avatar-crop-image.ts";

interface AvatarImageStyle extends CSSProperties {
	"--avatar-image": string;
}

interface AvatarUploadCropperProps {
	className?: string;
	currentAvatarUrl?: string | null;
	disabled?: boolean;
	onUploadComplete?: () => void;
	/** Removes the image for the owner that `upload` targets. When `upload` is
	 *  retargeted without a matching `remove`, the remove button is hidden so it
	 *  can never fall through to deleting the signed-in user's own avatar. */
	remove?: () => Promise<void>;
	/** Retarget the upload at a different owner (org / team). Defaults to the
	 *  signed-in user. The cropping, validation, and toasts are identical. */
	upload?: (file: File) => Promise<{ message?: string }>;
	userName?: string | null;
}

export function AvatarUploadCropper({
	currentAvatarUrl,
	userName = "User",
	onUploadComplete,
	className,
	disabled = false,
	upload,
	remove,
}: AvatarUploadCropperProps) {
	const removeImage = upload
		? remove
		: (remove ?? (() => settingsApi.profile.deleteAvatar()));
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	// Reselecting the same file may produce an identical data URL but needs fresh crop bounds.
	const [previewRevision, setPreviewRevision] = useState(0);
	const [finalImageUrl, setFinalImageUrl] = useState<string | null>(null);
	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
	const [zoom, setZoom] = useState(1);
	const [isDragging, setIsDragging] = useState(false);
	const [isRemoving, setIsRemoving] = useState(false);

	const { uploadAvatar, isUploading, validateFile } = useFileUpload();

	// Update finalImageUrl when currentAvatarUrl changes
	useEffect(() => {
		setFinalImageUrl(currentAvatarUrl || null);
	}, [currentAvatarUrl]);

	const handleFileSelect = useCallback(
		(file: File) => {
			const error = validateFile(file);
			if (error) {
				sileo.error({ title: error });
				return;
			}

			const reader = new FileReader();
			reader.onload = (e) => {
				const result = z.string().safeParse(e.target?.result);
				if (!result.success) {
					sileo.error({ title: "Failed to read file" });
					return;
				}
				setPreviewUrl(result.data);
				setPreviewRevision((revision) => revision + 1);
				setIsDialogOpen(true);
				setCroppedAreaPixels(null);
				setZoom(1);
			};
			reader.onerror = () => {
				sileo.error({ title: "Failed to read file" });
			};
			reader.readAsDataURL(file);
		},
		[validateFile]
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setIsDragging(false);

			const file = e.dataTransfer.files[0];
			if (file) {
				handleFileSelect(file);
			}
		},
		[handleFileSelect]
	);

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(true);
	};

	const handleDragLeave = () => {
		setIsDragging(false);
	};

	const handleApply = async () => {
		if (!(previewUrl && croppedAreaPixels)) {
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
				setPreviewUrl(null);
			}
			return;
		}

		try {
			// Get the cropped image blob
			const croppedBlob = await getCroppedImg(
				previewUrl,
				croppedAreaPixels,
				256,
				256
			);

			if (!croppedBlob) {
				throw new Error("Failed to generate cropped image blob.");
			}

			// Create object URL for preview
			const newFinalUrl = URL.createObjectURL(croppedBlob);

			// Revoke old finalImageUrl if it exists
			if (finalImageUrl && finalImageUrl !== currentAvatarUrl) {
				URL.revokeObjectURL(finalImageUrl);
			}

			// Update preview
			setFinalImageUrl(newFinalUrl);
			setIsDialogOpen(false);

			// Upload the cropped image
			const uploadFile = new File([croppedBlob], "avatar.jpg", {
				type: "image/jpeg",
			});
			await uploadAvatar(uploadFile, upload);

			// Call the success callback
			onUploadComplete?.();

			// Clean up
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
			}
			setPreviewUrl(null);
			setCroppedAreaPixels(null);
			setZoom(1);
		} catch (error) {
			console.error("Error during apply:", error);
			sileo.error({ title: "Failed to process image. Please try again." });
			setIsDialogOpen(false);
		}
	};

	const handleRemoveFinalImage = async () => {
		if (!(finalImageUrl && removeImage) || isRemoving || isUploading) {
			return;
		}

		setIsRemoving(true);
		try {
			await removeImage();
			if (
				finalImageUrl !== currentAvatarUrl &&
				finalImageUrl.startsWith("blob:")
			) {
				URL.revokeObjectURL(finalImageUrl);
			}
			setFinalImageUrl(null);
			onUploadComplete?.();
			sileo.success({
				title: upload ? "Image removed" : "Avatar deleted successfully",
			});
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: "Failed to delete avatar from server",
			});
		} finally {
			setIsRemoving(false);
		}
	};

	useEffect(() => {
		const currentFinalUrl = finalImageUrl;
		return () => {
			if (
				currentFinalUrl &&
				currentFinalUrl !== currentAvatarUrl &&
				currentFinalUrl.startsWith("blob:")
			) {
				URL.revokeObjectURL(currentFinalUrl);
			}
		};
	}, [finalImageUrl, currentAvatarUrl]);

	useEffect(() => {
		if (!previewUrl) {
			return;
		}
		let cancelled = false;
		createImage(previewUrl)
			.then((image) => {
				if (cancelled) {
					return;
				}
				const minDimension = Math.min(image.width, image.height);
				setCroppedAreaPixels({
					x: (image.width - minDimension) / 2,
					y: (image.height - minDimension) / 2,
					width: minDimension,
					height: minDimension,
				});
			})
			.catch(() => {
				if (!cancelled) {
					sileo.error({ title: "Failed to read image dimensions" });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [previewUrl, previewRevision]);

	const avatarImageStyle: AvatarImageStyle = {
		"--avatar-image": `url(${finalImageUrl})`,
	};

	return (
		<div className={cn("flex flex-col items-center gap-2", className)}>
			<div className="relative inline-flex">
				{/* Drop area */}
				<button
					aria-label={finalImageUrl ? "Change image" : "Upload image"}
					className="relative flex size-16 items-center justify-center overflow-hidden rounded-full border border-input border-dashed outline-none transition-colors hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 has-disabled:pointer-events-none has-disabled:opacity-50 data-[dragging=true]:bg-accent/50"
					data-dragging={isDragging || undefined}
					disabled={disabled || isUploading || isRemoving}
					onClick={() => fileInputRef.current?.click()}
					onDragEnter={(e) => {
						e.preventDefault();
						setIsDragging(true);
					}}
					onDragLeave={handleDragLeave}
					onDragOver={handleDragOver}
					onDrop={handleDrop}
					type="button"
				>
					{isUploading ? (
						<Skeleton className="absolute inset-0" radius="pill" />
					) : null}
					{finalImageUrl ? (
						<div
							aria-label={`${userName ?? "User"} avatar`}
							className="bg-(image:--avatar-image) size-full bg-center bg-cover"
							role="img"
							style={avatarImageStyle}
						/>
					) : (
						<div className="flex size-full items-center justify-center bg-muted font-semibold text-foreground">
							{(userName ?? "U").slice(0, 2).toUpperCase()}
						</div>
					)}
				</button>
				{/* Remove button */}
				{finalImageUrl && removeImage && (
					<Button
						aria-label="Remove image"
						className="absolute -top-1 -right-1 rounded-full"
						disabled={disabled || isUploading || isRemoving}
						onClick={handleRemoveFinalImage}
						size="icon-xs"
						type="button"
						variant="secondary"
					>
						<HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
					</Button>
				)}
				<input
					accept="image/jpeg,image/png,image/webp"
					aria-label="Upload image file"
					className="sr-only"
					disabled={disabled || isUploading || isRemoving}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) {
							handleFileSelect(file);
							e.target.value = "";
						}
					}}
					ref={fileInputRef}
					type="file"
				/>
			</div>

			<AvatarCropDialog
				croppedAreaPixels={croppedAreaPixels}
				onApply={handleApply}
				onCancel={() => setIsDialogOpen(false)}
				onOpenChange={(open) => {
					setIsDialogOpen(open);
					if (!open && previewUrl) {
						URL.revokeObjectURL(previewUrl);
						setPreviewUrl(null);
					}
				}}
				onZoomChange={setZoom}
				open={isDialogOpen}
				previewUrl={previewUrl}
				zoom={zoom}
			/>

			{/* Upload progress indicator */}
			{isUploading && (
				<div className="text-detail text-muted-foreground" role="status">
					Uploading avatar…
				</div>
			)}
		</div>
	);
}
