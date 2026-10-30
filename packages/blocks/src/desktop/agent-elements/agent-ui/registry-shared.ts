import type { BaseComponentProps } from "@json-render/react";
import type { CSSProperties, ReactNode } from "react";

export interface AgentUiClassLookup {
	[value: string]: string | undefined;
}
interface HeadingClassLookup {
	[level: number]: string | undefined;
}
export interface AgentUiGeometryStyle extends CSSProperties {
	"--agent-ui-chart-height"?: string;
	"--agent-ui-columns"?: string;
	"--agent-ui-skeleton-height"?: CSSProperties["height"];
	"--agent-ui-skeleton-width"?: CSSProperties["width"];
}

export const GAP_CLASS: AgentUiClassLookup = {
	none: "gap-0",
	xs: "gap-1",
	sm: "gap-2",
	md: "gap-3",
	lg: "gap-4",
	xl: "gap-6",
};

export const ALIGN_CLASS: AgentUiClassLookup = {
	start: "items-start",
	center: "items-center",
	end: "items-end",
	stretch: "items-stretch",
};

export const JUSTIFY_CLASS: AgentUiClassLookup = {
	start: "justify-start",
	center: "justify-center",
	end: "justify-end",
	between: "justify-between",
	around: "justify-around",
};

export const TEXT_SIZE_CLASS: AgentUiClassLookup = {
	xs: "text-xs",
	sm: "text-sm",
	base: "text-sm",
	lg: "text-(length:--text-comfortable) leading-(--text-comfortable--line-height)",
};

export const TEXT_WEIGHT_CLASS: AgentUiClassLookup = {
	normal: "font-normal",
	medium: "font-medium",
	semibold: "font-medium",
	bold: "font-medium",
};

export const HEADING_CLASS: HeadingClassLookup = {
	1: "text-balance text-xl font-semibold tracking-tight",
	2: "text-balance text-lg font-semibold tracking-tight",
	3: "text-balance text-(length:--text-comfortable) font-semibold leading-(--text-comfortable--line-height)",
	4: "text-balance text-sm font-semibold",
};

// Convenience alias so each renderer reads cleanly.
export type Render<P> = (ctx: BaseComponentProps<P>) => ReactNode;

// Agent-controlled UI: the spec (including href/src) is supplied by the model, so
// any URL must be scheme-checked before it reaches the DOM. A `javascript:` href on
// an <a> is directly clickable XSS; resolve against the app origin and only allow an
// explicit allowlist, otherwise fall back to an inert "#".
export const sanitizeUrl = (
	raw: string | undefined,
	allowed: readonly string[]
): string => {
	if (!raw) {
		return "#";
	}
	try {
		const origin =
			globalThis.window === undefined
				? "http://localhost"
				: window.location.origin;
		const url = new URL(raw, origin);
		return allowed.includes(url.protocol) ? url.toString() : "#";
	} catch {
		return "#";
	}
};

export const LINK_SCHEMES = ["http:", "https:", "mailto:"] as const;
export const IMAGE_SCHEMES = ["http:", "https:", "data:", "blob:"] as const;
