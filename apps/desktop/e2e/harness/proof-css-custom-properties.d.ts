import "react";

declare module "react" {
	interface CSSProperties {
		"--proof-composer-width"?: string;
		"--proof-pane-height"?: string;
		"--proof-pane-left"?: string;
		"--proof-pane-pixel-width"?: string;
		"--proof-pane-top"?: string;
		"--proof-pane-width"?: string;
		"--proof-width"?: string;
	}
}
