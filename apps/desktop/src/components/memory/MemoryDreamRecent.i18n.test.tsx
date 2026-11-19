import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MemoryProposal } from "@/src/lib/api/memory-dream.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { MemoryDreamRecent } = await import("./MemoryDreamRecent.tsx");

// Whole phrases, so a locale can say which memory sense "saved" means; the
// bare "Saved"/"Updated"/"Archived" labels are deliberately absent here.
const JA: Record<string, string> = {
	"Memory archived": "メモリをアーカイブしました",
	"Memory saved": "メモリを保存しました",
	"Memory updated": "メモリを更新しました",
};

function proposal(
	id: string,
	operation: MemoryProposal["operation"],
	content: string
): MemoryProposal {
	return {
		current: operation === "create" ? null : { content: `old ${id}`, id },
		id,
		operation,
		proposed: { content, id: `p-${id}` },
		status: "applied",
	} as MemoryProposal;
}

const RECENT = [
	proposal("a", "archive", "Lives in Osaka"),
	proposal("r", "revise", "Prefers exit rows"),
	proposal("c", "create", "Drinks green tea"),
];

async function renderRecent(locale: string) {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<MemoryDreamRecent
					busyProposal={null}
					onUndo={() => undefined}
					recent={RECENT}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const labels = Array.from(
		container.querySelectorAll("[data-testid=dream-recent-item]")
	).map(
		// The badge follows the memory's text.
		(item) => item.querySelector("p")?.nextElementSibling?.textContent ?? ""
	);
	return {
		labels,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("accepted-change labels render in Japanese", async () => {
	const { labels, unmount } = await renderRecent("ja");
	expect(labels).toEqual([
		"メモリをアーカイブしました",
		"メモリを更新しました",
		"メモリを保存しました",
	]);
	await unmount();
});

test("accepted-change labels say which memory change happened in English", async () => {
	const { labels, unmount } = await renderRecent("en");
	expect(labels).toEqual(["Memory archived", "Memory updated", "Memory saved"]);
	await unmount();
});
