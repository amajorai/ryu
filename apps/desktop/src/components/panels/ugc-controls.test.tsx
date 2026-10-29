import { expect, test } from "bun:test";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import originalMarkup from "./ugc-controls.fixture.json" with { type: "json" };

function normalizeClasses(markup: string) {
	return markup.replace(
		/class="([^"]*)"/g,
		(_match, classes: string) =>
			`class="${classes.split(" ").sort().join(" ")}"`
	);
}

test("compact native tables preserve every existing class, frame selector and DOM attribute", () => {
	const current = renderToStaticMarkup(
		<Table size="compact">
			<TableHeader>
				<TableRow>
					<TableHead size="compact">Creator</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				<TableRow>
					<TableCell spacing="compact">Creator</TableCell>
					<TableCell
						className="text-right"
						presentation="numeric"
						spacing="compact"
					>
						42
					</TableCell>
					<TableCell
						className="text-right"
						presentation="monospace-numeric"
						spacing="compact"
					>
						$1.00
					</TableCell>
					<TableCell
						className="max-w-56"
						overflow="truncate"
						presentation="muted"
						spacing="compact"
					>
						Reason
					</TableCell>
				</TableRow>
			</TableBody>
		</Table>
	);
	expect(normalizeClasses(current)).toBe(
		normalizeClasses(originalMarkup.table)
	);
});

test("UGC status capitalization and loading spacing retain existing native markup without leaking role props", () => {
	for (const variant of [
		"default",
		"outline",
		"secondary",
		"destructive",
	] as const) {
		const current = renderToStaticMarkup(
			<Badge casing="capitalized" variant={variant}>
				accrued
			</Badge>
		);
		expect(normalizeClasses(current)).toBe(
			normalizeClasses(originalMarkup.badges[variant])
		);
	}
	const current = renderToStaticMarkup(
		<SkeletonRows label="Loading" size="sm" spacing="compact-panel" />
	);
	expect(normalizeClasses(current)).toBe(
		normalizeClasses(originalMarkup.skeleton)
	);
});
