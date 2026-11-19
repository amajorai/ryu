// The Top 10 poster under each reading direction: the rank numeral sits on
// the poster's inline-start side, so in right-to-left reading its anchor, x
// and alignment mirror while the digits stay left-to-right, and the current
// ring covers the poster half at the inline end.
import { describe, expect, test } from "bun:test";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
import { cinemaTitle } from "./cinema-model.ts";
import { CinemaPoster } from "./cinema-poster.tsx";

const THREAD: InterfaceThread = {
	agentIds: [],
	id: "thread-rank",
	lastMessage: null,
	lastMessageRole: "assistant",
	messageCount: 2,
	pinned: false,
	projectId: null,
	running: false,
	teamId: null,
	title: "Quarterly notes",
	updatedAt: "2026-10-12T12:00:00Z",
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [THREAD],
	version: 1,
};

function poster(direction: "ltr" | "rtl", rank: number): string {
	return renderToStaticMarkup(
		<DirectionProvider direction={direction}>
			<CinemaPoster
				current
				layout="top"
				onHoverEnd={() => undefined}
				onHoverStart={() => undefined}
				onSelect={() => undefined}
				rank={rank}
				title={cinemaTitle(SNAPSHOT, THREAD)}
			/>
		</DirectionProvider>
	);
}

function numeral(markup: string): Record<string, string> {
	const svg = /<svg[^>]*preserveAspectRatio="([^"]*)"/u.exec(markup)?.[1];
	const text = /<text([^>]*)>/u.exec(markup)?.[1] ?? "";
	const attribute = (name: string) =>
		new RegExp(`${name}="([^"]*)"`, "u").exec(text)?.[1] ?? "";
	return {
		align: svg ?? "",
		anchor: attribute("text-anchor"),
		direction: attribute("direction"),
		x: attribute("x"),
	};
}

function ringClass(markup: string): string {
	return (
		/<span aria-hidden="true" class="(pointer-events-none[^"]*)"/u.exec(
			markup
		)?.[1] ?? ""
	);
}

describe("CinemaPoster rank numeral", () => {
	test("anchors the numeral at the poster's left edge in left-to-right reading", () => {
		expect(numeral(poster("ltr", 3))).toEqual({
			align: "xMaxYMax meet",
			anchor: "end",
			direction: "ltr",
			x: "104",
		});
		expect(numeral(poster("ltr", 10)).x).toBe("112");
	});

	test("mirrors the anchor, x and alignment under dir=rtl", () => {
		expect(numeral(poster("rtl", 3))).toEqual({
			align: "xMinYMax meet",
			anchor: "start",
			direction: "ltr",
			x: "-4",
		});
		expect(numeral(poster("rtl", 10)).x).toBe("-12");
	});

	test("draws the current ring over the poster at the inline end", () => {
		for (const direction of ["ltr", "rtl"] as const) {
			const ring = ringClass(poster(direction, 3));
			expect(ring).toContain("end-0");
			expect(ring).not.toContain("right-0");
		}
	});
});
