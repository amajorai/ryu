import { expect, it } from "bun:test";
import {
	Select,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import legacyMarkup from "./general-controls.fixture.json" with {
	type: "json",
};

// The archive predates dropping the shared squircle corner shape; its retired
// corner-* utilities are not part of the preserved treatment.
const RETIRED_CORNER_UTILITY = /corner-(?:[a-z]{1,2}-)?(?:squircle|round)$/;

function withoutRetiredCorners(markup: string) {
	return markup.replace(
		/class="([^"]*)"/g,
		(_attribute, classes: string) =>
			`class="${classes
				.split(" ")
				.filter((value) => !RETIRED_CORNER_UTILITY.test(value))
				.join(" ")}"`
	);
}

// Archived native markup records the pre-migration caller treatment; fixtures
// never restyle current primitives to manufacture their expected appearance.
it("preserves the native segmented group's exact default-size and pressed-state markup", () => {
	for (const { value, disabled, markup } of legacyMarkup.groups) {
		const current = renderToStaticMarkup(
			<ToggleGroup
				appearance="segmented"
				aria-label="Terminal location"
				disabled={disabled}
				spacing={0}
				value={value}
				variant="default"
			>
				<ToggleGroupItem density="segmented" value="bottom">
					Bottom
				</ToggleGroupItem>
				<ToggleGroupItem density="segmented" value="right">
					Right
				</ToggleGroupItem>
			</ToggleGroup>
		);
		expect(current).toBe(
			withoutRetiredCorners(markup).replaceAll(
				"focus-visible:ring-[3px]",
				"focus-visible:ring-3"
			)
		);
	}
});
function normalizeUtilityOrder(markup: string) {
	return markup.replace(/class="([^"]*)"/g, (_attribute, classes: string) => {
		const normalized = [
			...new Set(
				classes
					.split(" ")
					.filter((value) => !RETIRED_CORNER_UTILITY.test(value))
					.map((value) => (value === "flex-shrink-0" ? "shrink-0" : value))
			),
		].sort();
		return `class="${normalized.join(" ")}"`;
	});
}
it("preserves select native sizing and font treatment when replacing its real shrink utility alias", () => {
	const triggers = [
		<SelectTrigger className="h-8 w-40 shrink-0">
			<SelectValue />
		</SelectTrigger>,
		<SelectTrigger className="h-8 w-52 shrink-0">
			<SelectValue />
		</SelectTrigger>,
		<SelectTrigger className="h-8 w-56 shrink-0">
			<SelectValue />
		</SelectTrigger>,
	];
	for (const [index, { markup }] of legacyMarkup.selects.entries()) {
		const current = renderToStaticMarkup(
			<Select items={[{ value: "restore", label: "Restore" }]} value="restore">
				{triggers[index]}
			</Select>
		);
		expect(normalizeUtilityOrder(current)).toBe(normalizeUtilityOrder(markup));
		expect(current).toContain('data-size="default"');
	}
});
