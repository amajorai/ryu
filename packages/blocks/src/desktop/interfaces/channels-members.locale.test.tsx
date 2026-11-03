import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Inside an ICU plural branch "#" prints the count, so the channel's "#"
// travels in the value: "1 member of #site-refresh", never "1site-refresh".
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ChannelsMembers } = await import("./channels-members.tsx");

const SOURCE =
	"{count, plural, one {# member of {channel}} other {# members of {channel}}}";
const DE: Record<string, string> = {
	[SOURCE]:
		"{count, plural, one {# Mitglied von {channel}} other {# Mitglieder von {channel}}}",
};

const member = (id: string): InterfaceAgent =>
	({ id, name: `Agent ${id}`, status: "idle" }) as InterfaceAgent;

let mounted: { container: HTMLElement; root: Root } | undefined;
async function unmount(): Promise<void> {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
}
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await unmount();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function triggerLabel(
	locale: string,
	members: InterfaceAgent[]
): Promise<string | null> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ChannelsMembers
					channelLabel="site-refresh"
					members={members}
					onMessage={() => undefined}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.querySelector("button")?.getAttribute("aria-label") ?? null;
}

test("the member count names the channel with its hash in English", async () => {
	expect(await triggerLabel("en", [member("a")])).toBe(
		"1 member of #site-refresh"
	);
	await unmount();
	expect(await triggerLabel("en", [member("a"), member("b")])).toBe(
		"2 members of #site-refresh"
	);
});

test("the translated member count keeps the channel's hash", async () => {
	expect(await triggerLabel("de", [member("a")])).toBe(
		"1 Mitglied von #site-refresh"
	);
});
