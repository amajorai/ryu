import type { CSSProperties } from "react";

/** Native dynamic usage visual properties keep the existing background shorthand
 * and width values intact while the classes own their declarations. */
export interface UsageVisualStyle extends CSSProperties {
	"--usage-projected-left"?: CSSProperties["left"];
	"--usage-projected-width"?: CSSProperties["width"];
	"--usage-remaining-width"?: CSSProperties["width"];
	"--usage-source-color"?: CSSProperties["background"];
}
