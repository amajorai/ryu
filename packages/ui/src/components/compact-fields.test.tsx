import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { NativeSelect } from "./native-select.tsx";
import { Textarea } from "./textarea.tsx";

describe("compact field variants", () => {
	test("input heights retain responsive and file typography", () => {
		expect(renderComparableMarkup(<Input size="compact" />)).toBe(
			renderComparableMarkup(<Input className="h-8 text-xs" />)
		);
		expect(renderComparableMarkup(<Input size="dense" />)).toBe(
			renderComparableMarkup(<Input className="h-7 text-xs" />)
		);
	});

	test("label typography preserves both existing sizes", () => {
		expect(renderComparableMarkup(<Label size="compact">Name</Label>)).toBe(
			renderComparableMarkup(<Label className="text-xs">Name</Label>)
		);
		expect(renderComparableMarkup(<Label size="caption">Name</Label>)).toBe(
			renderComparableMarkup(<Label className="type-caption">Name</Label>)
		);
	});

	test("native select styling remains on its existing wrapper", () => {
		expect(renderComparableMarkup(<NativeSelect appearance="compact" />)).toBe(
			renderComparableMarkup(<NativeSelect className="h-8 text-xs" />)
		);
	});

	test("textarea heights retain responsive typography and code font", () => {
		expect(renderComparableMarkup(<Textarea size="compact" />)).toBe(
			renderComparableMarkup(<Textarea className="min-h-20 text-xs" />)
		);
		expect(
			renderComparableMarkup(<Textarea size="dense" variant="code" />)
		).toBe(
			renderComparableMarkup(
				<Textarea className="min-h-16 font-mono text-xs" />
			)
		);
		expect(
			renderComparableMarkup(<Textarea size="expanded" variant="code" />)
		).toBe(
			renderComparableMarkup(
				<Textarea className="min-h-24 font-mono text-xs" />
			)
		);
	});
});

function normalizeClasses(html: string) {
	return html.replace(
		/class="([^"]*)"/g,
		(_, classes: string) => `class="${classes.split(" ").sort().join(" ")}"`
	);
}

describe("compact editor controls", () => {
	test("input semantic typography retains the same class sets", () => {
		expect(
			normalizeClasses(renderComparableMarkup(<Input size="caption" />))
		).toBe(
			normalizeClasses(
				renderComparableMarkup(<Input className="type-caption h-7" />)
			)
		);
		expect(
			normalizeClasses(
				renderComparableMarkup(<Input size="micro-dense" variant="code" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(<Input className="type-compact h-7 font-mono" />)
			)
		);
		expect(
			normalizeClasses(renderComparableMarkup(<Input size="micro" />))
		).toBe(
			normalizeClasses(
				renderComparableMarkup(<Input className="type-compact h-6" />)
			)
		);
	});
	test("native select dense controls preserve wrapper-only styles", () => {
		expect(
			normalizeClasses(
				renderComparableMarkup(<NativeSelect appearance="dense" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(<NativeSelect className="h-7 text-xs" />)
			)
		);
		expect(
			normalizeClasses(
				renderComparableMarkup(<NativeSelect appearance="micro-dense" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(<NativeSelect className="type-compact h-7" />)
			)
		);
	});
	test("button sizes preserve small-control icon padding and typography", () => {
		expect(
			normalizeClasses(
				renderComparableMarkup(<Button size="caption" variant="ghost" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(
					<Button className="type-caption h-7" size="sm" variant="ghost" />
				)
			)
		);
		expect(
			normalizeClasses(
				renderComparableMarkup(<Button size="micro-dense" variant="outline" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(
					<Button
						className="type-compact h-7 px-1.5"
						size="sm"
						variant="outline"
					/>
				)
			)
		);
		expect(
			normalizeClasses(
				renderComparableMarkup(<Button size="micro" variant="ghost" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(
					<Button
						className="type-compact h-6 px-1.5"
						size="sm"
						variant="ghost"
					/>
				)
			)
		);
	});
	test("badge typography, trailing action and failure tone preserve classes", () => {
		expect(
			normalizeClasses(
				renderComparableMarkup(
					<Badge className="ml-auto" motion="pulse" variant="secondary" />
				)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(
					<Badge className="ml-auto animate-pulse" variant="secondary" />
				)
			)
		);
		expect(
			normalizeClasses(
				renderComparableMarkup(<Badge size="compact" variant="secondary" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(
					<Badge className="type-compact" variant="secondary" />
				)
			)
		);
		expect(
			normalizeClasses(
				renderComparableMarkup(<Badge trailingAction variant="secondary" />)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(
					<Badge className="gap-1 pr-1" variant="secondary" />
				)
			)
		);
		expect(
			normalizeClasses(
				renderComparableMarkup(
					<Badge size="compact" tone="destructive" variant="outline" />
				)
			)
		).toBe(
			normalizeClasses(
				renderComparableMarkup(
					<Badge
						className="type-compact border-destructive text-status-destructive"
						variant="outline"
					/>
				)
			)
		);
	});
});

function renderComparableMarkup(element: ReactElement) {
	return normalizeClasses(renderToStaticMarkup(element));
}
