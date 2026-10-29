import { expect, test } from "bun:test";
import { createElement, type SetStateAction, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useControllableState } from "./use-controllable-state.ts";

interface StateProbeProps {
	action: SetStateAction<number>;
	changes: number[];
	controlled?: number;
}
function StateProbe({ action, changes, controlled }: StateProbeProps) {
	const [value, setValue] = useControllableState({
		defaultProp: 5,
		onChange: (next) => changes.push(next),
		prop: controlled,
	});
	const sent = useRef(false);
	if (!sent.current) {
		sent.current = true;
		setValue(action);
	}
	return createElement("output", null, String(value));
}

test("controlled actions notify changes while retaining the supplied value", () => {
	for (const action of [5, 6, (previous: number) => previous + 1]) {
		const changes: number[] = [];
		expect(
			renderToStaticMarkup(
				createElement(StateProbe, { action, changes, controlled: 5 })
			)
		).toBe("<output>5</output>");
		expect(changes).toEqual(action === 5 ? [] : [6]);
	}
});

test("uncontrolled literal and functional actions update only changed values", () => {
	const unchanged: SetStateAction<number>[] = [5, (previous) => previous];
	for (const action of unchanged) {
		const changes: number[] = [];
		expect(
			renderToStaticMarkup(createElement(StateProbe, { action, changes }))
		).toBe("<output>5</output>");
		expect(changes).toEqual([]);
	}
	const updates: SetStateAction<number>[] = [6, (previous) => previous + 1];
	for (const action of updates) {
		const changes: number[] = [];
		expect(
			renderToStaticMarkup(createElement(StateProbe, { action, changes }))
		).toBe("<output>6</output>");
		expect(changes).toEqual([6]);
	}
});
