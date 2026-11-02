// Localized strings for React Flow's built-in chrome. `@xyflow/react` ships
// English aria labels, button titles and screen-reader descriptions (the
// visible "Fit View" tooltip among them) and only takes translations through
// the `ariaLabelConfig` prop, so every `<ReactFlow>` mount passes this hook's
// result. `tools/check-third-party-chrome-labels.test.mjs` keeps it that way.

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { AriaLabelConfig } from "@xyflow/react";
import { useRef } from "react";

type AriaLiveMessage = AriaLabelConfig["node.a11yDescription.ariaLiveMessage"];
type StaticLabels = Omit<
	AriaLabelConfig,
	"node.a11yDescription.ariaLiveMessage"
>;

/** React Flow's static labels, translated. */
export function reactFlowStaticLabels(tl: LiteralMessage): StaticLabels {
	return {
		"node.a11yDescription.default": tl(
			"Press enter or space to select a node. Press delete to remove it and escape to cancel."
		),
		"node.a11yDescription.keyboardDisabled": tl(
			"Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel."
		),
		"edge.a11yDescription.default": tl(
			"Press enter or space to select an edge. You can then press delete to remove it or escape to cancel."
		),
		"controls.ariaLabel": tl("Control Panel"),
		"controls.zoomIn.ariaLabel": tl("Zoom In"),
		"controls.zoomOut.ariaLabel": tl("Zoom Out"),
		"controls.fitView.ariaLabel": tl("Fit View"),
		"controls.interactive.ariaLabel": tl("Toggle Interactivity"),
		"minimap.ariaLabel": tl("Mini Map"),
		"handle.ariaLabel": tl("Handle"),
	};
}

/**
 * The live-region sentence React Flow announces after a keyboard move. The
 * direction (`up`, `down`, `left`, `right`) selects a whole sentence so each
 * language words it naturally.
 */
export function reactFlowAriaLiveMessage(tl: LiteralMessage): AriaLiveMessage {
	return ({ direction, x, y }) =>
		tl(
			"{direction, select, up {Moved selected node up. New position, x: {x}, y: {y}} down {Moved selected node down. New position, x: {x}, y: {y}} left {Moved selected node left. New position, x: {x}, y: {y}} right {Moved selected node right. New position, x: {x}, y: {y}} other {Moved selected node. New position, x: {x}, y: {y}}}",
			{ direction, x, y }
		);
}

/**
 * The role descriptions React Flow hard-codes on every node and edge
 * (`aria-roledescription="node"` / `"edge"`). React Flow takes no option for
 * them; these literals put the lowercase keys in the catalog so the DOM
 * attribute localizer can translate the rendered attribute, and canvases that
 * set `domAttributes` can use them directly.
 */
export function reactFlowRoleDescriptions(tl: LiteralMessage): {
	edge: string;
	node: string;
} {
	return { edge: tl("edge"), node: tl("node") };
}

/**
 * An edge's accessible name, replacing React Flow's English default
 * ("Edge from a to b"). Pass readable node names, not internal ids.
 */
export function reactFlowEdgeAriaLabel(
	tl: LiteralMessage,
	source: string,
	target: string
): string {
	return tl("Edge from {source} to {target}", { source, target });
}

interface CachedLabels {
	config: Partial<AriaLabelConfig>;
	key: string;
}

/**
 * `ariaLabelConfig` for a `<ReactFlow>` in the active locale. The object keeps
 * its identity until a translated string changes, because React Flow copies a
 * new config into its store on every identity change.
 */
export function useReactFlowAriaLabels(): Partial<AriaLabelConfig> {
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const labels = reactFlowStaticLabels(tl);
	const key = Object.values(labels).join("\u0000");
	const cache = useRef<CachedLabels | null>(null);
	if (cache.current?.key !== key) {
		cache.current = {
			config: {
				...labels,
				// Read the latest `tl` at announce time: the remote host may
				// have answered since the config was built.
				"node.a11yDescription.ariaLiveMessage": (params) =>
					reactFlowAriaLiveMessage(tlRef.current)(params),
			},
			key,
		};
	}
	return cache.current.config;
}
