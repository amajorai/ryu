import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pool } from "./ProviderPoolsEditor-options.ts";
import { ProviderPoolListItem } from "./ProviderPoolsEditor-pool-list-item.tsx";

const ACTIVE =
	"{count, plural, one {# active member} other {# active members}}";
const STICKY =
	"{sticky_limit, plural, one {# new session per member ·} other {# new sessions per member ·}}";

// Stub rows standing in for the catalog rows the coordinator generates.
const AR = {
	[ACTIVE]:
		"{count, plural, zero {لا أعضاء نشطون} one {عضو نشط واحد} two {عضوان نشطان} few {# أعضاء نشطين} many {# عضوًا نشطًا} other {# عضو نشط}}",
	[STICKY]:
		"{sticky_limit, plural, zero {لا جلسات جديدة لكل عضو ·} one {جلسة جديدة لكل عضو ·} two {جلستان جديدتان لكل عضو ·} few {# جلسات جديدة لكل عضو ·} many {# جلسة جديدة لكل عضو ·} other {# جلسة جديدة لكل عضو ·}}",
};
const DE = {
	[ACTIVE]:
		"{count, plural, one {# aktives Mitglied} other {# aktive Mitglieder}}",
};

function member(index: number, enabled = true): Pool["members"][number] {
	return {
		enabled,
		model: `model-${index}`,
		priority: index,
		provider: "openai",
		weight: 1,
	};
}

function render(locale: string, pool: Pool): string {
	return renderToStaticMarkup(
		<I18nProvider
			initialLocale={locale}
			manageDocument={false}
			overlays={{ ar: AR, de: DE }}
		>
			<ProviderPoolListItem
				disabled={false}
				pool={pool}
				poolName="primary"
				remove={async () => undefined}
				saving={false}
				startEdit={() => undefined}
			/>
		</I18nProvider>
	);
}

function poolWith(active: number, extra: Partial<Pool> = {}): Pool {
	return {
		members: [
			...Array.from({ length: active }, (_, index) => member(index)),
			member(99, false),
		],
		strategy: "priority",
		...extra,
	} as Pool;
}

describe("ProviderPoolListItem member count", () => {
	test("counts only enabled members, in English singular and plural", () => {
		expect(render("en", poolWith(1))).toContain("1 active member<");
		expect(render("en", poolWith(3))).toContain("3 active members");
	});

	test("selects the German singular and plural forms", () => {
		expect(render("de", poolWith(1))).toContain("1 aktives Mitglied");
		expect(render("de", poolWith(2))).toContain("2 aktive Mitglieder");
	});

	test("selects the Arabic forms for 1, 2 and 11", () => {
		expect(render("ar", poolWith(1))).toContain("عضو نشط واحد");
		expect(render("ar", poolWith(2))).toContain("عضوان نشطان");
		expect(render("ar", poolWith(11))).toContain("11 عضوًا نشطًا");
	});

	test("pluralizes the round-robin sticky limit", () => {
		const roundRobin = (limit: number) =>
			poolWith(2, { sticky_limit: limit, strategy: "round_robin" });
		expect(render("en", roundRobin(2))).toContain(
			"2 new sessions per member ·"
		);
		expect(render("ar", roundRobin(2))).toContain("جلستان جديدتان لكل عضو ·");
	});
});
