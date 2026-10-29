export const PRISM_COMPONENT_COLORS = {
	dark: ["#050505", "#66B3FF", "#FFFFFF"],
	light: ["#FAFAFA", "#66B3FF", "#050505"],
} as const;

/** OG cards keep Prism's blue and replace its dark stop with white. */
export const PRISM_OG_COLORS = PRISM_COMPONENT_COLORS.dark.map((color) =>
	color === "#050505" ? "#FFFFFF" : color
);
