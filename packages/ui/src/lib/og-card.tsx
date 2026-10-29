import { type CSSProperties, createElement } from "react";
import { OG_LOGO, OG_PRISM_FRAME } from "./og-frames.generated.ts";

export const OG_SIZE = { width: 1200, height: 630 } as const;
export interface OgCardProps {
	/** A 1200x630 data-URI still behind the card. Defaults to the Prism frame. */
	background?: string;
	/** Public summary of the page; omitted cards carry the title alone. */
	description?: string;
	eyebrow?: string;
	title?: string;
}

/** Bound public labels by Unicode code points. */
export function ogLabel(value: string | undefined, limit = 80): string {
	const characters = Array.from(value?.replace(/\s+/gu, " ").trim() ?? "");
	return characters.length > limit
		? `${characters
				.slice(0, limit - 1)
				.join("")
				.trimEnd()}…`
		: characters.join("");
}

const TEXT = "#ffffff";
/** White at reduced strength for the description, so the title leads. */
const TEXT_MUTED = "rgba(255, 255, 255, 0.74)";
const PADDING = 72;

function titleSize(length: number): number {
	if (length > 48) {
		return 56;
	}
	return length > 24 ? 68 : 80;
}

/**
 * Server-safe composition shared by Web and Docs, with no remote image
 * dependencies: a frozen backdrop frame, the README brand mark, and white type
 * anchored to the bottom-left corner. The frames and mark come from
 * `tools/og/render-og-frames.ts`.
 */
export function OgCard({
	background = OG_PRISM_FRAME,
	description,
	eyebrow,
	title,
}: OgCardProps = {}) {
	const label = ogLabel(title);
	const personalized = Boolean(label && label.toLowerCase() !== "ryu");
	const context = ogLabel(eyebrow, 24);
	const brand =
		context && context.toLowerCase() !== label.toLowerCase()
			? `Ryu ${context}`
			: "Ryu";
	const summary = ogLabel(description, 170);
	const cardStyle: CSSProperties = {
		width: "100%",
		height: "100%",
		display: "flex",
		position: "relative",
		backgroundColor: "#050505",
		fontFamily: "Geist",
		color: TEXT,
	};
	const backgroundStyle: CSSProperties = {
		position: "absolute",
		left: 0,
		top: 0,
	};
	const contentStyle: CSSProperties = {
		width: "100%",
		height: "100%",
		display: "flex",
		position: "relative",
		flexDirection: "column",
		alignItems: "flex-start",
		justifyContent: "flex-end",
		padding: `${PADDING}px`,
		gap: "24px",
	};
	const brandStyle: CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: personalized ? "14px" : "22px",
	};
	const brandTextStyle: CSSProperties = {
		fontSize: personalized ? "30px" : "88px",
		fontWeight: 500,
		lineHeight: 1,
		letterSpacing: personalized ? "-0.5px" : "-3px",
	};
	const titleStyle: CSSProperties = {
		display: "flex",
		maxWidth: "980px",
		fontSize: titleSize(label.length),
		fontWeight: 500,
		lineHeight: 1.08,
		letterSpacing: "-2px",
		overflowWrap: "anywhere",
	};
	const descriptionStyle: CSSProperties = {
		display: "flex",
		maxWidth: "900px",
		fontSize: "28px",
		lineHeight: 1.4,
		color: TEXT_MUTED,
		overflowWrap: "anywhere",
	};
	const logoSize = personalized ? 44 : 88;
	// Satori consumes a React element tree with native style props; it does not
	// load the host's CSS stylesheet or resolve classes/custom properties.
	return createElement(
		"div",
		{ style: cardStyle },
		createElement("img", {
			alt: "",
			height: OG_SIZE.height,
			src: background,
			style: backgroundStyle,
			width: OG_SIZE.width,
		}),
		createElement(
			"div",
			{ style: contentStyle },
			createElement(
				"div",
				{ style: brandStyle },
				createElement("img", {
					alt: "",
					height: logoSize,
					src: OG_LOGO,
					width: logoSize,
				}),
				createElement("span", { style: brandTextStyle }, brand)
			),
			personalized ? createElement("div", { style: titleStyle }, label) : null,
			summary
				? createElement("div", { style: descriptionStyle }, summary)
				: null
		)
	);
}
