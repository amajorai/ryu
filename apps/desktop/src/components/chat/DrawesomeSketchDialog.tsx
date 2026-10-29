"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	isNativeFunction,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { PluginHostPanel } from "@/src/contributions/host/PluginHostPanel.tsx";
import type { PluginCompanion } from "@/src/lib/api/plugins.ts";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_SKETCH_DATA_URL_LENGTH = 16_000_000;

export interface DrawesomeSketchAttachment {
	dataUrl: string;
	filename: string;
	mimeType: "image/png";
	size: number;
}

interface DrawesomeSketchDialogProps {
	companion: PluginCompanion | undefined;
	onAttach: (attachment: DrawesomeSketchAttachment) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	sourceImage?: {
		filename: string;
		url: string;
	};
}

function createMessageToken(): string {
	if (isNativeFunction(crypto.randomUUID)) {
		return crypto.randomUUID();
	}
	return `drawesome-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

const sketchAttachmentSchema = z.object({
	dataUrl: z.string(),
	filename: z.string().optional().catch(undefined),
	size: z.number().optional().catch(undefined),
});
const sketchMessageSchema = z.object({
	kind: z.literal("ryu-drawesome-dialog"),
	token: z.string(),
	action: z.string(),
	file: z.unknown().optional(),
});

function parseAttachment<TValue>(
	value: TValue
): DrawesomeSketchAttachment | null {
	const parsed = sketchAttachmentSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const attachment = parsed.data;
	const dataUrl = attachment.dataUrl;
	if (
		!isNativeText(dataUrl) ||
		dataUrl.length > MAX_SKETCH_DATA_URL_LENGTH ||
		!dataUrl.startsWith(PNG_DATA_URL_PREFIX) ||
		!/^[A-Za-z0-9+/=]+$/.test(dataUrl.slice(PNG_DATA_URL_PREFIX.length))
	) {
		return null;
	}
	const filename =
		isNativeText(attachment.filename) &&
		/^[a-zA-Z0-9._-]{1,80}$/.test(attachment.filename)
			? attachment.filename
			: "sketch.png";
	const size =
		isNativeNumber(attachment.size) &&
		Number.isSafeInteger(attachment.size) &&
		attachment.size > 0
			? attachment.size
			: Math.floor((dataUrl.length - PNG_DATA_URL_PREFIX.length) * 0.75);
	return { dataUrl, filename, mimeType: "image/png", size };
}

export function DrawesomeSketchDialog({
	companion,
	onAttach,
	onOpenChange,
	open,
	sourceImage,
}: DrawesomeSketchDialogProps) {
	const [messageToken] = useState(createMessageToken);
	const handleRequestClose = useCallback(() => {
		if (open) {
			onOpenChange(false);
		}
	}, [open, onOpenChange]);
	const mountContext = useMemo(
		() => ({ mode: "sketch-dialog", token: messageToken, image: sourceImage }),
		[messageToken, sourceImage]
	);

	const handleFrameMessage = useCallback(
		(message: Parameters<typeof sketchMessageSchema.safeParse>[0]) => {
			const parsed = sketchMessageSchema.safeParse(message);
			if (!parsed.success) {
				return;
			}
			const data = parsed.data;
			if (data.kind !== "ryu-drawesome-dialog" || data.token !== messageToken) {
				return;
			}
			if (data.action === "close") {
				onOpenChange(false);
				return;
			}
			if (data.action !== "attach") {
				return;
			}
			const attachment = parseAttachment(data.file);
			if (!attachment) {
				return;
			}
			onAttach(attachment);
			onOpenChange(false);
		},
		[messageToken, onAttach, onOpenChange]
	);

	if (!companion) {
		return null;
	}

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent appearance="sketch" mobileFullPage showCloseButton={false}>
				<DialogTitle className="sr-only">Sketch</DialogTitle>
				<DialogDescription className="sr-only">
					Draw a visual reference and attach it to your next message.
				</DialogDescription>
				<div className="min-h-0 flex-1">
					<PluginHostPanel
						companion={companion}
						mountContext={mountContext}
						onMessage={handleFrameMessage}
						onRequestClose={handleRequestClose}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
