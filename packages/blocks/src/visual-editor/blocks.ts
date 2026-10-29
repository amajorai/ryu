/**
 * Starter blocks for the visual editor palette. Each block is a small,
 * self-contained HTML fragment with inline styles so it renders the same in
 * the canvas, the sandboxed preview, and a published site without external
 * assets.
 */
export interface VisualBlock {
	description: string;
	html: string;
	id: string;
	label: string;
}

const PLACEHOLDER_IMAGE =
	"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23e7e5e4'/%3E%3Cpath d='M250 230l50-60 40 45 30-30 70 85H250z' fill='%23a8a29e'/%3E%3Ccircle cx='280' cy='140' r='22' fill='%23a8a29e'/%3E%3C/svg%3E";

export const VISUAL_BLOCKS: readonly VisualBlock[] = [
	{
		id: "section",
		label: "Section",
		description: "A padded, centered area to group content",
		html: '<section style="padding:64px 24px;max-width:960px;margin:0 auto"><h2 style="margin:0 0 12px">New section</h2><p style="margin:0">Describe this part of the page.</p></section>',
	},
	{
		id: "heading",
		label: "Heading",
		description: "A section title",
		html: '<h2 style="margin:0 0 12px">Heading</h2>',
	},
	{
		id: "paragraph",
		label: "Text",
		description: "A paragraph of body text",
		html: '<p style="margin:0 0 12px;line-height:1.6">Write something people will want to read.</p>',
	},
	{
		id: "button",
		label: "Button",
		description: "A call-to-action link styled as a button",
		html: '<a href="#" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">Get started</a>',
	},
	{
		id: "image",
		label: "Image",
		description: "A responsive image with alt text",
		html: `<img alt="Describe this image" src="${PLACEHOLDER_IMAGE}" style="display:block;width:100%;height:auto;border-radius:12px">`,
	},
	{
		id: "columns",
		label: "Two columns",
		description: "Side-by-side content that stacks on small screens",
		html: '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px"><div><h3 style="margin:0 0 8px">First column</h3><p style="margin:0">Supporting text.</p></div><div><h3 style="margin:0 0 8px">Second column</h3><p style="margin:0">Supporting text.</p></div></div>',
	},
	{
		id: "cards",
		label: "Cards",
		description: "Three feature cards in a responsive grid",
		html: '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px"><article style="padding:20px;border:1px solid #e5e7eb;border-radius:12px"><h3 style="margin:0 0 8px">Feature one</h3><p style="margin:0">Why it matters.</p></article><article style="padding:20px;border:1px solid #e5e7eb;border-radius:12px"><h3 style="margin:0 0 8px">Feature two</h3><p style="margin:0">Why it matters.</p></article><article style="padding:20px;border:1px solid #e5e7eb;border-radius:12px"><h3 style="margin:0 0 8px">Feature three</h3><p style="margin:0">Why it matters.</p></article></div>',
	},
	{
		id: "list",
		label: "List",
		description: "A bulleted list",
		html: '<ul style="margin:0 0 12px;padding-inline-start:20px;line-height:1.6"><li>First point</li><li>Second point</li><li>Third point</li></ul>',
	},
	{
		id: "quote",
		label: "Quote",
		description: "A testimonial or pull quote",
		html: '<blockquote style="margin:0;padding:16px 20px;border-inline-start:4px solid #111827;font-size:1.125rem">“A quote that builds trust.”</blockquote>',
	},
	{
		id: "divider",
		label: "Divider",
		description: "A horizontal rule between sections",
		html: '<hr style="border:0;border-top:1px solid #e5e7eb;margin:32px 0">',
	},
];

export function visualBlock(id: string): VisualBlock | undefined {
	return VISUAL_BLOCKS.find((block) => block.id === id);
}
