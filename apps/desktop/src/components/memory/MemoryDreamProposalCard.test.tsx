import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Memory } from "@/src/lib/api/memory.ts";
import type { MemoryProposal } from "@/src/lib/api/memory-dream.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { ProposalCard } = await import("./MemoryDreamProposalCard.tsx");

const pack: LanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	id: "test/en",
	locale: "en",
	messages: {},
	name: "English",
	schemaVersion: 1,
	version: "1.0.0",
};

function memory(content: string): Memory {
	return {
		category: "preference",
		content,
		id: `memory-${content.length}`,
		importance: 4,
		scope: "user",
		tags: ["travel"],
	} as unknown as Memory;
}

function revision(): MemoryProposal {
	return {
		current: memory("Prefers aisle seats"),
		id: "revise-1",
		operation: "revise",
		proposed: memory("Prefers window seats on long flights"),
		reason: null,
		source: null,
		status: "pending",
	} as unknown as MemoryProposal;
}

describe("ProposalCard", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	async function render(busy: boolean, decisions: string[]): Promise<void> {
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialPackId={pack.id}
					manageDocument={false}
					packs={[pack]}
				>
					<ProposalCard
						busy={busy}
						onAccept={(proposal) => decisions.push(`accept:${proposal.id}`)}
						onReject={(proposal) => decisions.push(`reject:${proposal.id}`)}
						proposal={revision()}
					/>
				</I18nProvider>
			);
		});
	}

	function button(label: string): HTMLButtonElement | undefined {
		return Array.from(container.querySelectorAll("button")).find((item) =>
			item.textContent?.includes(label)
		);
	}

	it("shows a revision as before and proposed with its badges", async () => {
		const decisions: string[] = [];
		await render(false, decisions);

		const text = container.textContent ?? "";
		expect(text).toContain("Proposed memory");
		expect(text).toContain("Before");
		expect(text).toContain("Prefers aisle seats");
		expect(text).toContain("Prefers window seats on long flights");
		expect(text).toContain("Importance 4");
		expect(text).toContain("#travel");

		await act(async () => {
			button("Accept memory")?.click();
			button("Reject")?.click();
		});
		expect(decisions).toEqual(["accept:revise-1", "reject:revise-1"]);
	});

	it("disables both decisions while the proposal is busy", async () => {
		const decisions: string[] = [];
		await render(true, decisions);

		expect(button("Accept memory")?.disabled).toBe(true);
		expect(button("Reject")?.disabled).toBe(true);
	});
});
