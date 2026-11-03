import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { drawing as proWorkbench } from "./pro-workbench.tsx";
import { STATIC_FIGURES } from "./registry.tsx";
import { drawing as securityCheckpoint } from "./security-checkpoint.tsx";
import type { StaticDrawing } from "./static-figure.tsx";
import { StaticFigure } from "./static-figure.tsx";

// The two hero drawings drawn for /security and /pro, which used to borrow
// Box's glovebox and Desktop's dock. Each must be its own drawing, registered
// under its own id, rendered the way every static figure is.

const HERO_DRAWINGS = ["security-checkpoint", "pro-workbench"] as const;

/** Kit files in this folder that are not figure drawings. */
const NOT_DRAWINGS = new Set([
	"parts.ts",
	"registry.tsx",
	"sketch.tsx",
	"static-figure.tsx",
]);

const drawingFiles = readdirSync(import.meta.dir).filter(
	(name) =>
		/\.tsx?$/.test(name) && !name.includes(".test.") && !NOT_DRAWINGS.has(name)
);

const loadDrawing = async (name: string): Promise<StaticDrawing> =>
	((await import(`./${name}.tsx`)) as { drawing: StaticDrawing }).drawing;

const render = (name: string, drawing: StaticDrawing) =>
	renderToStaticMarkup(<StaticFigure drawing={drawing} name={name} />);

describe.each(HERO_DRAWINGS)("%s", (name) => {
	test("is registered as a static figure", () => {
		expect(Object.keys(STATIC_FIGURES)).toContain(name);
		expect(drawingFiles).toContain(`${name}.tsx`);
	});

	test("renders a decorative svg like every static figure", async () => {
		const drawing = await loadDrawing(name);
		const html = render(name, drawing);
		expect(html).toContain(`data-static-figure="${name}"`);
		expect(html).toContain('class="iso iso-quiet"');
		expect(html).toMatch(
			/<svg aria-hidden="true" class="iso-svg" focusable="false" viewBox="0 0 640 440">/
		);
		expect(html).not.toContain('role="img"');
		// Static figures carry no words or numbers; the page copy does.
		expect(html).not.toMatch(/<text[\s>]/);
		expect(drawing.nodes.length).toBeGreaterThan(40);
	});

	test("has exactly one lit part, the figure's accent", async () => {
		const html = render(name, await loadDrawing(name));
		expect(html.match(/data-lit=""/g) ?? []).toHaveLength(1);
	});

	test("draws its own geometry instead of reusing another figure's drawing", async () => {
		const drawing = await loadDrawing(name);
		const html = render(name, drawing);
		const source = readFileSync(join(import.meta.dir, `${name}.tsx`), "utf8");
		for (const file of drawingFiles) {
			const other = file.replace(/\.tsx?$/, "");
			if (other === name) {
				continue;
			}
			expect([other, source.includes(`./${other}`)]).toEqual([other, false]);
			const otherDrawing = await loadDrawing(other);
			expect([other, otherDrawing === drawing]).toEqual([other, false]);
			const otherHtml = render(name, otherDrawing);
			expect([other, otherHtml === html]).toEqual([other, false]);
		}
	});
});

test("the registry stays in alphabetical order", () => {
	const ids = Object.keys(STATIC_FIGURES);
	expect(ids).toEqual([...ids].sort());
});

test("the two hero drawings are distinct drawings", () => {
	expect(proWorkbench).not.toBe(securityCheckpoint);
	expect(render("pro-workbench", proWorkbench)).not.toBe(
		render("security-checkpoint", securityCheckpoint)
	);
});
