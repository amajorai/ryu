import { ImageUploadIcon, Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type SubmitEvent, useId, useRef, useState } from "react";
import {
	fileToWallpaperDataUrl,
	type WallpaperPreference,
} from "@/src/lib/wallpaper.ts";
import { saveOrWarn } from "./PickerGalleryTab.tsx";

export function UploadTab({
	update,
}: {
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [dragging, setDragging] = useState(false);

	const applyFile = async (file: File | undefined) => {
		if (!file || busy) {
			return;
		}
		setBusy(true);
		try {
			const url = await fileToWallpaperDataUrl(file);
			saveOrWarn(() =>
				update({
					image: { attribution: null, label: file.name, sourceUrl: null, url },
					mode: "image",
				})
			);
		} catch (error) {
			toast.error({
				title: "Couldn't use that image",
				description:
					error instanceof Error ? error.message : "Please try another file.",
			});
		} finally {
			setBusy(false);
			if (inputRef.current) {
				inputRef.current.value = "";
			}
		}
	};

	return (
		<label
			className={cn(
				"flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center transition-colors",
				dragging ? "border-foreground bg-muted" : "border-border hover:bg-muted"
			)}
			htmlFor={inputId}
			onDragLeave={() => setDragging(false)}
			onDragOver={(event) => {
				event.preventDefault();
				setDragging(true);
			}}
			onDrop={(event) => {
				event.preventDefault();
				setDragging(false);
				applyFile(event.dataTransfer.files[0]).catch(() => undefined);
			}}
		>
			{busy ? (
				<Spinner className="size-5" />
			) : (
				<HugeiconsIcon
					className="size-5 text-muted-foreground"
					icon={ImageUploadIcon}
				/>
			)}
			<span className="font-medium text-sm">Upload an image</span>
			<span className="text-muted-foreground text-xs">
				Drop a photo here or click to browse. It stays on this device.
			</span>
			<input
				accept="image/*"
				className="sr-only"
				id={inputId}
				onChange={(event) => {
					applyFile(event.target.files?.[0]).catch(() => undefined);
				}}
				ref={inputRef}
				type="file"
			/>
		</label>
	);
}

export function isAllowedImageUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:";
	} catch {
		return false;
	}
}

export function LinkTab({
	update,
}: {
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const [value, setValue] = useState("");
	const valid = isAllowedImageUrl(value.trim());
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const url = value.trim();
		if (!isAllowedImageUrl(url)) {
			return;
		}
		const saved = saveOrWarn(() =>
			update({
				image: {
					attribution: null,
					label: new URL(url).hostname,
					sourceUrl: url,
					url,
				},
				mode: "image",
			})
		);
		if (saved) {
			setValue("");
		}
	};
	return (
		<form className="space-y-3" onSubmit={submit}>
			<div className="relative">
				<HugeiconsIcon
					className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Link01Icon}
				/>
				<Input
					aria-label="Image link"
					leadingAdornment="default"
					onChange={(event) => setValue(event.target.value)}
					placeholder="Paste an https:// image link…"
					value={value}
				/>
			</div>
			<Button className="w-full" disabled={!valid} type="submit">
				Use this image
			</Button>
			<p className="text-muted-foreground text-xs">
				Works with any image on the web, including Unsplash photo links.
			</p>
		</form>
	);
}
