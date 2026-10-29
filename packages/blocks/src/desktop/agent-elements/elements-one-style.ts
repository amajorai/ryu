import type { CSSProperties } from "react";

/** Custom properties consumed by the private agent element geometry owners. */
export interface AgentGeometryStyle extends CSSProperties {
	"--agent-cursor"?: string;
	"--agent-height"?: string;
	"--agent-left"?: string;
	"--agent-size"?: string;
	"--agent-top"?: string;
	"--agent-width"?: string;
}
