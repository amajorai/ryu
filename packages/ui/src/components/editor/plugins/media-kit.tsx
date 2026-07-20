"use client";

import { CaptionPlugin } from "@platejs/caption/react";
import {
	AudioPlugin,
	FilePlugin,
	ImagePlugin,
	MediaEmbedPlugin,
	PlaceholderPlugin,
	VideoPlugin,
} from "@platejs/media/react";
import { AudioElement } from "@ryu/ui/components/editor/ui/media-audio-node.tsx";
import { MediaEmbedElement } from "@ryu/ui/components/editor/ui/media-embed-node.tsx";
import { FileElement } from "@ryu/ui/components/editor/ui/media-file-node.tsx";
import { ImageElement } from "@ryu/ui/components/editor/ui/media-image-node.tsx";
import { PlaceholderElement } from "@ryu/ui/components/editor/ui/media-placeholder-node.tsx";
import { MediaPreviewDialog } from "@ryu/ui/components/editor/ui/media-preview-dialog.tsx";
import { MediaUploadToast } from "@ryu/ui/components/editor/ui/media-upload-toast.tsx";
import { VideoElement } from "@ryu/ui/components/editor/ui/media-video-node.tsx";
import { KEYS } from "platejs";

export const MediaKit = [
	ImagePlugin.configure({
		options: { disableUploadInsert: true },
		render: { afterEditable: MediaPreviewDialog, node: ImageElement },
	}),
	MediaEmbedPlugin.withComponent(MediaEmbedElement),
	VideoPlugin.withComponent(VideoElement),
	AudioPlugin.withComponent(AudioElement),
	FilePlugin.withComponent(FileElement),
	PlaceholderPlugin.configure({
		options: { disableEmptyPlaceholder: true },
		render: { afterEditable: MediaUploadToast, node: PlaceholderElement },
	}),
	CaptionPlugin.configure({
		options: {
			query: {
				allow: [KEYS.img, KEYS.video, KEYS.audio, KEYS.file, KEYS.mediaEmbed],
			},
		},
	}),
];
