// The slide thumbnails and the stage preview are SVG documents that
// `renderSlideToSvg` builds locally from the open deck. They are only ever bound
// to an `<img src>`, where an SVG cannot run script, so they go in as an
// `image/svg+xml` data URL. `safeMediaUrl` is the wrong gate for them: it admits
// raster image data URLs only (an SVG data URL in an href or iframe could run
// script), so routing the previews through it blanked every slide preview.

const SVG_DATA_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";

/** An `<img>`-only data URL for a locally rendered slide SVG. */
export function slidePreviewSrc(svg: string): string {
	return `${SVG_DATA_URL_PREFIX}${encodeURIComponent(svg)}`;
}
