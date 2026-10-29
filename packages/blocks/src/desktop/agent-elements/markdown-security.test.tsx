import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, MarkdownResponseImages } from "./markdown.tsx";

test.each([
	"constructor",
	"__proto__",
])("renders hostile bracketed file extension %s without throwing", (extension) => {
	const markup = renderToStaticMarkup(
		<Markdown content={`See @<note.${extension}> and @<normal.pdf>.`} />
	);
	expect(markup).toContain(`note.${extension}`);
	expect(markup).toContain("normal.pdf");
	expect(markup).toContain("text-red-500");
});

test("disabled response images produce neither an image nor its automatic preload", () => {
	const markup = renderToStaticMarkup(
		<MarkdownResponseImages.Provider value={false}>
			<Markdown
				content={
					"**Local answer** ![Image description](http://127.0.0.1:5257/probe?question=synthetic)\n\n![Relative image](/probe)\n\n![Inline image](data:image/png;base64,aGVsbG8=)\n\n[Documentation](https://docs.ryuhq.com)"
				}
			/>
		</MarkdownResponseImages.Provider>
	);
	expect(markup).not.toContain("<img");
	expect(markup).not.toContain('as="image"');
	expect(markup).toContain("Image description");
	expect(markup).toContain("<strong");
	expect(markup).toContain('href="https://docs.ryuhq.com/"');
});

test("desktop Markdown retains ordinary response images", () => {
	const markup = renderToStaticMarkup(
		<Markdown content="![Desktop image](http://127.0.0.1:5257/image.png)" />
	);
	expect(markup).toContain("<img");
});

test.each([
	"![Reference image][pixel]\n\n[pixel]: http://127.0.0.1:5257/probe?form=reference",
	'<img src="http://127.0.0.1:5257/probe?form=html" srcset="http://127.0.0.1:5257/probe?form=srcset 2x" />',
])("reply image policy covers alternate Markdown and HTML forms", (content) => {
	const markup = renderToStaticMarkup(
		<MarkdownResponseImages.Provider value={false}>
			<Markdown content={content} />
		</MarkdownResponseImages.Provider>
	);
	expect(markup).not.toContain("<img");
	expect(markup).not.toContain('as="image"');
});
