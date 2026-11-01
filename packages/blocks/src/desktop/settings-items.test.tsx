import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";
import { SettingsSurfaceProvider } from "./settings-surface.tsx";

const countMatches = (html: string, needle: string): number =>
	html.split(needle).length - 1;

describe("settings primitives on the default card surface", () => {
	test("a group of rows sits on one rounded grouped card", () => {
		const html = renderToStaticMarkup(
			<SettingsSection title="General">
				<SettingsGroup>
					<SettingsItem title="Launch at login" />
					<SettingsItem title="Show in menu bar" />
				</SettingsGroup>
			</SettingsSection>
		);

		expect(countMatches(html, 'data-slot="settings-group-card"')).toBe(1);
		expect(html).toContain("bg-grouped-card");
		expect(html).toContain("Launch at login");
		expect(html).toContain("Show in menu bar");
	});

	test("a card block paints the grouped card surface", () => {
		const html = renderToStaticMarkup(
			<SettingsCard>
				<p>Slider</p>
			</SettingsCard>
		);

		expect(html).toContain('data-slot="settings-card"');
		expect(html).toContain("bg-grouped-card");
		expect(html).toContain("p-3.5");
	});

	test("a bare card keeps only the child's own edge", () => {
		const html = renderToStaticMarkup(
			<SettingsCard bare className="border">
				<p>Diff</p>
			</SettingsCard>
		);

		expect(html).not.toContain("bg-grouped-card");
	});

	test("blocks inside a card never paint a second card", () => {
		const html = renderToStaticMarkup(
			<SettingsCard>
				<SettingsGroup>
					<SettingsItem title="Nested row" />
				</SettingsGroup>
			</SettingsCard>
		);

		expect(countMatches(html, "bg-grouped-card")).toBe(1);
		expect(html).not.toContain('data-slot="settings-group-card"');
	});

	test("the section title lines up with the rows inside the card", () => {
		const html = renderToStaticMarkup(
			<SettingsSection caption="Caption text" title="Privacy">
				<SettingsGroup>
					<SettingsItem title="Row" />
				</SettingsGroup>
			</SettingsSection>
		);

		expect(html).toMatch(/<div class="[^"]*px-3\.5[^"]*"><h3/);
		expect(html).toMatch(/<p class="[^"]*px-3\.5[^"]*">Caption text<\/p>/);
	});
});

describe("settings primitives on a plain surface", () => {
	test("rows sit straight on the pane with no card", () => {
		const html = renderToStaticMarkup(
			<SettingsSurfaceProvider surface="plain">
				<SettingsSection title="General">
					<SettingsGroup>
						<SettingsItem title="Launch at login" />
					</SettingsGroup>
					<SettingsCard>
						<p>Slider</p>
					</SettingsCard>
				</SettingsSection>
			</SettingsSurfaceProvider>
		);

		expect(html).not.toContain("bg-grouped-card");
		expect(html).not.toContain('data-slot="settings-group-card"');
		expect(html).toContain("Launch at login");
	});
});
