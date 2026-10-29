"use client";

import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import { cssDimension } from "./css-dimension.ts";
import styles from "./iframe.module.css";

interface IframeDimensionsStyle extends CSSProperties {
	"--assistant-iframe-border": string | undefined;
	"--assistant-iframe-height": string | undefined;
	"--assistant-iframe-width": string | undefined;
}

export interface RyuAssistantWidgetIframeProps {
	/** Optional permissions requested by the hosted widget, kept explicit. */
	allow?: string;
	className?: string;
	height?: CSSProperties["height"];
	loading?: "eager" | "lazy";
	src: string;
	style?: CSSProperties;
	title?: string;
	width?: CSSProperties["width"];
}

/**
 * Safe-by-default iframe wrapper for a hosted assistant surface. Scripts are
 * allowed, but the frame keeps an opaque origin and cannot navigate the parent,
 * submit arbitrary forms, or request ambient browser capabilities.
 */
export function RyuAssistantWidgetIframe({
	allow,
	className,
	height = "100%",
	loading = "lazy",
	src,
	style,
	title = "Ryu assistant",
	width = "100%",
}: RyuAssistantWidgetIframeProps) {
	const dimensions: IframeDimensionsStyle = {
		...style,
		"--assistant-iframe-border": cssDimension(
			Object.hasOwn(style ?? {}, "border") ? style?.border : 0
		),
		"--assistant-iframe-height": cssDimension(
			Object.hasOwn(style ?? {}, "height") ? style?.height : height
		),
		"--assistant-iframe-width": cssDimension(
			Object.hasOwn(style ?? {}, "width") ? style?.width : width
		),
	};
	return (
		<iframe
			allow={allow}
			className={cn(styles.frame, className)}
			loading={loading}
			referrerPolicy="strict-origin-when-cross-origin"
			sandbox="allow-scripts"
			src={src}
			style={dimensions}
			title={title}
		/>
	);
}
