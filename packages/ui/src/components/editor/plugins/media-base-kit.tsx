import { BaseCaptionPlugin } from "@platejs/caption";
import {
	BaseAudioPlugin,
	BaseFilePlugin,
	BaseImagePlugin,
	BaseMediaEmbedPlugin,
	BasePlaceholderPlugin,
	BaseVideoPlugin,
} from "@platejs/media";
import { AudioElementStatic } from "@ryu/ui/components/editor/ui/media-audio-node-static.tsx";
import { FileElementStatic } from "@ryu/ui/components/editor/ui/media-file-node-static.tsx";
import { ImageElementStatic } from "@ryu/ui/components/editor/ui/media-image-node-static.tsx";
import { VideoElementStatic } from "@ryu/ui/components/editor/ui/media-video-node-static.tsx";
import { KEYS } from "platejs";

export const BaseMediaKit = [
	BaseImagePlugin.withComponent(ImageElementStatic),
	BaseVideoPlugin.withComponent(VideoElementStatic),
	BaseAudioPlugin.withComponent(AudioElementStatic),
	BaseFilePlugin.withComponent(FileElementStatic),
	BaseCaptionPlugin.configure({
		options: {
			query: {
				allow: [KEYS.img, KEYS.video, KEYS.audio, KEYS.file, KEYS.mediaEmbed],
			},
		},
	}),
	BaseMediaEmbedPlugin,
	BasePlaceholderPlugin,
];
