"use client";

import { PlaceholderPlugin, UploadErrorCode } from "@platejs/media/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { usePluginOption } from "platejs/react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export function MediaUploadToast() {
	useUploadErrorToast();

	return null;
}

const useUploadErrorToast = () => {
	const uploadError = usePluginOption(PlaceholderPlugin, "error");
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;

	useEffect(() => {
		if (!uploadError) {
			return;
		}
		const tlNow = tlRef.current;

		const { code, data } = uploadError;

		switch (code) {
			case UploadErrorCode.INVALID_FILE_SIZE: {
				toast.error(
					tlNow("The size of files {fileNames} is invalid", {
						fileNames: data.files.map((f) => f.name).join(", "),
					})
				);

				break;
			}
			case UploadErrorCode.INVALID_FILE_TYPE: {
				toast.error(
					tlNow("The type of files {fileNames} is invalid", {
						fileNames: data.files.map((f) => f.name).join(", "),
					})
				);

				break;
			}
			case UploadErrorCode.TOO_LARGE: {
				toast.error(
					tlNow(
						"The size of files {fileNames} is too large than {maxFileSize}",
						{
							fileNames: data.files.map((f) => f.name).join(", "),
							maxFileSize: String(data.maxFileSize),
						}
					)
				);

				break;
			}
			case UploadErrorCode.TOO_LESS_FILES: {
				toast.error(
					tlNow(
						"The mini um number of files is {minFileCount} for {fileType}",
						{
							fileType: String(data.fileType),
							minFileCount: String(data.minFileCount),
						}
					)
				);

				break;
			}
			case UploadErrorCode.TOO_MANY_FILES: {
				const maxFileCount = String(data.maxFileCount);
				toast.error(
					data.fileType
						? tlNow(
								"The maximum number of files is {maxFileCount} for {fileType}",
								{ fileType: String(data.fileType), maxFileCount }
							)
						: tlNow("The maximum number of files is {maxFileCount} ", {
								maxFileCount,
							})
				);

				break;
			}
		}
	}, [uploadError]);
};
