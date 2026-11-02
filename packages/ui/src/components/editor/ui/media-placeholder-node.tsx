"use client";

import {
	PlaceholderPlugin,
	PlaceholderProvider,
	updateUploadHistory,
} from "@platejs/media/react";
import { activeLocale } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { useUploadFile } from "@ryu/ui/hooks/use-upload-file.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AudioLines, FileUp, Film, ImageIcon, Loader2Icon } from "lucide-react";
import type { TPlaceholderElement } from "platejs";
import { KEYS } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement, useEditorPlugin, withHOC } from "platejs/react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useFilePicker } from "use-file-picker";

interface PlaceholderContent {
	accept: string[];
	icon: ReactNode;
}

// Native media keys own these controls. Unsupported names use the file entry,
// including Object.prototype names which are not authored placeholder types.
const CONTENT = new Map<TPlaceholderElement["mediaType"], PlaceholderContent>([
	[
		KEYS.audio,
		{
			accept: ["audio/*"],
			icon: <AudioLines />,
		},
	],
	[
		KEYS.file,
		{
			accept: ["*"],
			icon: <FileUp />,
		},
	],
	[
		KEYS.img,
		{
			accept: ["image/*"],
			icon: <ImageIcon />,
		},
	],
	[
		KEYS.video,
		{
			accept: ["video/*"],
			icon: <Film />,
		},
	],
]);

/**
 * The card's call to action. It renders inside the editable, which the DOM
 * localizer skips, so each kind is its own literal tl() call.
 */
function placeholderLabel(
	mediaType: TPlaceholderElement["mediaType"],
	tl: LiteralMessage
): string {
	switch (mediaType) {
		case KEYS.audio:
			return tl("Add an audio file");
		case KEYS.img:
			return tl("Add an image");
		case KEYS.video:
			return tl("Add a video");
		default:
			return tl("Add a file");
	}
}

export const PlaceholderElement = withHOC(
	PlaceholderProvider,
	function PlaceholderElement(props: PlateElementProps<TPlaceholderElement>) {
		const { editor, element } = props;
		const tl = useLiteralMessages();

		const { api } = useEditorPlugin(PlaceholderPlugin);

		const { isUploading, progress, uploadedFile, uploadFile, uploadingFile } =
			useUploadFile();

		const loading = isUploading && uploadingFile;

		const currentContent =
			CONTENT.get(element.mediaType) ?? CONTENT.get(KEYS.file)!;

		const isImage = element.mediaType === KEYS.img;

		const imageRef = useRef<HTMLImageElement>(null);

		const { openFilePicker } = useFilePicker({
			accept: currentContent.accept,
			multiple: true,
			onFilesSelected: ({ plainFiles: updatedFiles }) => {
				const firstFile = updatedFiles[0];
				const restFiles = updatedFiles.slice(1);

				replaceCurrentPlaceholder(firstFile);

				if (restFiles.length > 0) {
					editor.getTransforms(PlaceholderPlugin).insert.media(restFiles);
				}
			},
		});

		const replaceCurrentPlaceholder = useCallback(
			(file: File) => {
				uploadFile(file).catch(() => undefined);
				// SAFETY: Native addUploadingFile uses the original id as a computed
				// object key; it applies native property-key coercion, not a string
				// parser. This bridge retains that behavior and proves no id brand.
				api.placeholder.addUploadingFile(element.id as string, file);
			},
			[api.placeholder, element.id, uploadFile]
		);

		useEffect(() => {
			if (!uploadedFile) {
				return;
			}

			const path = editor.api.findPath(element);

			editor.tf.withoutSaving(() => {
				editor.tf.removeNodes({ at: path });

				// SAFETY: Native updateUploadHistory matches operation.node.id to
				// placeholderId with strict equality. Preserve this exact raw identity;
				// its declared string slot does not establish string membership.
				const node = {
					children: [{ text: "" }],
					initialHeight: imageRef.current?.height,
					initialWidth: imageRef.current?.width,
					isUpload: true,
					name: element.mediaType === KEYS.file ? uploadedFile.name : "",
					placeholderId: element.id as string,
					type: element.mediaType!,
					url: uploadedFile.url,
				};

				editor.tf.insertNodes(node, { at: path });

				updateUploadHistory(editor, node);
			});

			// SAFETY: Native removeUploadingFile deletes uploadingFiles[id] using
			// the same original key/coercion as addUploadingFile; no id parsing.
			api.placeholder.removeUploadingFile(element.id as string);
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [
			uploadedFile,
			element.id,
			api.placeholder.removeUploadingFile,
			editor.tf.withoutSaving,
			element,
			editor.tf.insertNodes,
			editor.tf.removeNodes,
			editor.api.findPath,
			editor,
		]);

		// React dev mode will call useEffect twice
		const isReplaced = useRef(false);

		/** Paste and drop */
		useEffect(() => {
			if (isReplaced.current) {
				return;
			}

			isReplaced.current = true;
			// SAFETY: Native getUploadingFile reads uploadingFiles[id] with the
			// original property key. Its string type does not change key coercion.
			const currentFiles = api.placeholder.getUploadingFile(
				element.id as string
			);

			if (!currentFiles) {
				return;
			}

			replaceCurrentPlaceholder(currentFiles);

			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [
			element.id,
			replaceCurrentPlaceholder,
			api.placeholder.getUploadingFile,
		]);

		return (
			<PlateElement className="my-1" {...props}>
				{!(loading && isImage) && (
					<div
						aria-disabled={Boolean(loading) || undefined}
						className={cn(
							"flex cursor-pointer select-none items-center rounded-sm bg-muted p-3 pe-9 outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
						)}
						contentEditable={false}
						onClick={() => !loading && openFilePicker()}
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== " ") {
								return;
							}
							event.preventDefault();
							if (!loading) {
								openFilePicker();
							}
						}}
						role="button"
						tabIndex={0}
					>
						<div className="relative me-3 flex text-muted-foreground/80 [&_svg]:size-6">
							{currentContent.icon}
						</div>
						<div className="whitespace-nowrap text-muted-foreground text-sm">
							<div>
								{loading
									? uploadingFile?.name
									: placeholderLabel(element.mediaType, tl)}
							</div>

							{loading && !isImage && (
								<div className="mt-1 flex items-center gap-1.5">
									<div>{formatBytes(uploadingFile?.size ?? 0)}</div>
									<div>–</div>
									<div className="flex items-center tabular-nums">
										<Loader2Icon className="me-1 size-3.5 animate-spin text-muted-foreground" />
										{progress ?? 0}%
									</div>
								</div>
							)}
						</div>
					</div>
				)}

				{isImage && loading && (
					<ImageProgress
						file={uploadingFile}
						imageRef={imageRef}
						progress={progress}
					/>
				)}

				{props.children}
			</PlateElement>
		);
	}
);

export function ImageProgress({
	className,
	file,
	imageRef,
	progress = 0,
}: {
	file: File;
	className?: string;
	imageRef?: RefObject<HTMLImageElement | null>;
	progress?: number;
}) {
	const [objectUrl, setObjectUrl] = useState<string | null>(null);

	useEffect(() => {
		const url = URL.createObjectURL(file);
		// eslint-disable-next-line react-hooks/set-state-in-effect -- Store the object URL tied to this File and revoke it on cleanup.
		setObjectUrl(url);

		return () => {
			URL.revokeObjectURL(url);
		};
	}, [file]);

	if (!objectUrl) {
		return null;
	}

	return (
		<div className={cn("relative", className)} contentEditable={false}>
			<img
				alt={file.name}
				className="h-auto w-full rounded-sm object-cover"
				ref={imageRef}
				src={objectUrl}
			/>
			{progress < 100 && (
				<div className="absolute end-1 bottom-1 flex items-center space-x-2 rounded-full bg-black/50 px-1 py-0.5 rtl:space-x-reverse">
					<Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
					<span className="font-medium text-white text-xs">
						{Math.round(progress)}%
					</span>
				</div>
			)}
		</div>
	);
}

/** Whole units ("12 MB"), in the UI locale's own digits and unit names. */
function formatBytes(bytes: number) {
	return formatByteSize(bytes, activeLocale(), {
		fractionDigits: 0,
		maxUnit: "terabyte",
	});
}
