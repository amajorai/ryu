import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-rows.tsx";

describe("@ryu/settings rows", () => {
	test("a group of rows sits on a rounded grouped card", () => {
		const html = renderToStaticMarkup(
			<SettingsSection title="Sessions">
				<SettingsGroup>
					<SettingsItem title="This device" />
					<SettingsItem title="Laptop" />
				</SettingsGroup>
			</SettingsSection>
		);

		expect(html).toContain('data-slot="settings-group-card"');
		expect(html).toContain("rounded-xl bg-grouped-card");
		expect(html).toContain("This device");
		expect(html).toContain("Laptop");
	});

	test("a card block is a padded grouped card unless bare", () => {
		const carded = renderToStaticMarkup(
			<SettingsCard>
				<p>Empty</p>
			</SettingsCard>
		);
		const bare = renderToStaticMarkup(
			<SettingsCard bare>
				<p>Empty</p>
			</SettingsCard>
		);

		expect(carded).toContain("bg-grouped-card");
		expect(carded).toContain("p-3.5");
		expect(bare).not.toContain("bg-grouped-card");
	});

	test("the section title and caption are inset to the card rows", () => {
		const html = renderToStaticMarkup(
			<SettingsSection caption="Caption text" title="Referrals">
				<SettingsGroup>
					<SettingsItem title="Row" />
				</SettingsGroup>
			</SettingsSection>
		);

		expect(html).toMatch(/<div class="[^"]*px-3\.5[^"]*"><h3/);
		expect(html).toMatch(/<p class="[^"]*px-3\.5[^"]*">Caption text<\/p>/);
	});
});
