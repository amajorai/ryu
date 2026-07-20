import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Slider } from "@ryu/ui/components/slider";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { sileo } from "sileo";
import { useFileUpload } from "../../hooks/useFileUpload.ts";

// Define type for pixel crop area
interface Area {
	height: number;
	width: number;
	x: number;
	y: number;
}

interface AvatarUploadCropperProps {
	className?: string;
	currentAvatarUrl?: string | null;
	disabled?: boolean;
	onUploadComplete?: () => void;
	/** Retarget the upload at a different owner (org / team). Defaults to the
	 *  signed-in user. The cropping, validation, and toasts are identical. */
	upload?: (file: File) => Promise<{ message?: string }>;
	userName?: string | null;
}

// Helper function to create a cropped image blob
const createImage = (url: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.addEventListener("load", () => resolve(image));
		image.addEventListener("error", (error) => reject(error));
		image.setAttribute("crossOrigin", "anonymous"); // Needed for canvas Tainted check
		image.src = url;
	});

async function getCroppedImg(
	imageSrc: string,
	pixelCrop: Area,
	outputWidth: number = pixelCrop.width,
	outputHeight: number = pixelCrop.height
): Promise<Blob | null> {
	try {
		const image = await createImage(imageSrc);
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");

		if (!ctx) {
			return null;
		}

		// Set canvas size to desired output size
		canvas.width = outputWidth;
		canvas.height = outputHeight;

		// Draw the cropped image onto the canvas
		ctx.drawImage(
			image,
			pixelCrop.x,
			pixelCrop.y,
			pixelCrop.width,
			pixelCrop.height,
			0,
			0,
			outputWidth,
			outputHeight
		);

		// Convert canvas to blob
		return new Promise((resolve) => {
			canvas.toBlob((blob) => {
				resolve(blob);
			}, "image/jpeg");
		});
	} catch (error) {
		console.error("Error in getCroppedImg:", error);
		return null;
	}
}

export function AvatarUploadCropper({
	currentAvatarUrl,
	userName = "User",
	onUploadComplete,
	className,
	disabled = false,
	upload,
}: AvatarUploadCropperProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [finalImageUrl, setFinalImageUrl] = useState<string | null>(null);
	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
	const [zoom, setZoom] = useState(1);
	const [isDragging, setIsDragging] = useState(false);

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
				const url = e.target?.result as string;
				setPreviewUrl(url);
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

	const handleRemoveFinalImage = () => {
		if (finalImageUrl) {
			// Only revoke if it's a blob URL (not the current avatar)
			if (
				finalImageUrl !== currentAvatarUrl &&
				finalImageUrl.startsWith("blob:")
			) {
				URL.revokeObjectURL(finalImageUrl);
			}
			setFinalImageUrl(null);

			// Delete from server if we had a custom avatar
			if (currentAvatarUrl) {
				try {
					// Call delete avatar endpoint
					sileo.success({ title: "Avatar deleted successfully" });
					onUploadComplete?.();
				} catch (error) {
					console.error("Failed to delete avatar:", error);
					sileo.error({ title: "Failed to delete avatar from server" });
				}
			}
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
	}, [previewUrl]);

	return (
		<div className={cn("flex flex-col items-center gap-2", className)}>
			<div className="relative inline-flex">
				{/* Drop area */}
				<button
					aria-label={finalImageUrl ? "Change image" : "Upload image"}
					className="corner-squircle relative flex size-16 items-center justify-center overflow-hidden rounded-full border border-input border-dashed outline-none transition-colors hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-disabled:pointer-events-none has-disabled:opacity-50 data-[dragging=true]:bg-accent/50"
					data-dragging={isDragging || undefined}
					disabled={disabled || isUploading}
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
					{finalImageUrl ? (
						<div
							aria-label={`${userName ?? "User"} avatar`}
							className="size-full bg-center bg-cover"
							role="img"
							style={{ backgroundImage: `url(${finalImageUrl})` }}
						/>
					) : (
						<div aria-hidden="true">
							<svg
								aria-hidden="true"
								className="size-4 opacity-60"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path
									d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
									fill="currentColor"
								/>
							</svg>
						</div>
					)}
				</button>
				{/* Remove button */}
				{finalImageUrl && (
					<Button
						aria-label="Remove image"
						className="absolute -top-1 -right-1 size-6 rounded-full border-2 border-background shadow-none focus-visible:border-background"
						disabled={disabled || isUploading}
						onClick={handleRemoveFinalImage}
						size="icon"
						type="button"
					>
						<svg
							aria-hidden="true"
							className="size-3.5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							xmlns="http://www.w3.org/2000/svg"
						>
							<path
								d="M6 18L18 6M6 6l12 12"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
							/>
						</svg>
					</Button>
				)}
				<input
					accept="image/jpeg,image/png,image/webp"
					aria-label="Upload image file"
					className="sr-only"
					disabled={disabled || isUploading}
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

			{/* Cropper Dialog */}
			<Dialog
				onOpenChange={(open) => {
					setIsDialogOpen(open);
					if (!open && previewUrl) {
						URL.revokeObjectURL(previewUrl);
						setPreviewUrl(null);
					}
				}}
				open={isDialogOpen}
			>
				<DialogContent className="gap-0 p-0 sm:max-w-140 *:[button]:hidden">
					<DialogDescription className="sr-only">
						Crop image dialog
					</DialogDescription>
					<DialogHeader className="contents space-y-0 text-left">
						<DialogTitle className="flex items-center justify-between border-b p-4 text-base">
							<div className="flex items-center gap-2">
								<Button
									aria-label="Cancel"
									className="-my-1 opacity-60"
									onClick={() => setIsDialogOpen(false)}
									size="icon"
									type="button"
									variant="ghost"
								>
									<svg
										aria-hidden="true"
										className="size-4"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
										xmlns="http://www.w3.org/2000/svg"
									>
										<path
											d="M19 12H5M12 19l-7-7 7-7"
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={2}
										/>
									</svg>
								</Button>
								<span>Crop image</span>
							</div>
							<Button autoFocus disabled={!previewUrl} onClick={handleApply}>
								Apply
							</Button>
						</DialogTitle>
					</DialogHeader>
					{previewUrl && (
						<div className="relative flex h-96 items-center justify-center overflow-hidden sm:h-120">
							<div
								aria-label="Crop preview"
								className="size-full bg-center bg-contain bg-no-repeat"
								role="img"
								style={{
									backgroundImage: `url(${previewUrl})`,
									transform: `scale(${zoom})`,
								}}
							/>
							{croppedAreaPixels && (
								<div
									className="pointer-events-none absolute border-2 border-primary bg-primary/10"
									style={{
										left: croppedAreaPixels.x,
										top: croppedAreaPixels.y,
										width: croppedAreaPixels.width,
										height: croppedAreaPixels.height,
									}}
								/>
							)}
						</div>
					)}
					<DialogFooter className="border-t px-4 py-6">
						<div className="mx-auto flex w-full max-w-80 items-center gap-4">
							<svg
								aria-hidden="true"
								className="size-4 shrink-0 opacity-60"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path
									d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7"
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
								/>
							</svg>
							<Slider
								aria-label="Zoom slider"
								defaultValue={[1]}
								max={3}
								min={1}
								onValueChange={(value) =>
									setZoom(Array.isArray(value) ? value[0] : value)
								}
								step={0.1}
								value={[zoom]}
							/>
							<svg
								aria-hidden="true"
								className="size-4 shrink-0 opacity-60"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path
									d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7"
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
								/>
							</svg>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Upload progress indicator */}
			{isUploading && (
				<div className="animate-pulse text-muted-foreground text-sm">
					Uploading avatar...
				</div>
			)}
		</div>
	);
}
