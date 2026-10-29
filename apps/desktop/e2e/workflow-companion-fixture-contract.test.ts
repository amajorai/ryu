import { expect, test } from "bun:test";
import {
	FixtureBindingSchema,
	FixtureRunInputSchema,
	parseCompanionBinding,
	parseCompanionRunInput,
	parseWorkflowCompanionSnapshot,
} from "./workflow-companion-fixture-contract.ts";

test("companion bind and run boundaries check IDs and text input values", () => {
	expect(
		FixtureBindingSchema.parse({
			id: "bind-1",
			triggerId: "conn-1",
			triggerSlug: "new-mail",
		})
	).toEqual({ id: "bind-1", triggerId: "conn-1", triggerSlug: "new-mail" });
	expect(() =>
		FixtureBindingSchema.parse({
			id: "bind-1",
			triggerId: 12,
			triggerSlug: "new-mail",
		})
	).toThrow();
	expect(
		FixtureRunInputSchema.parse({ customer_id: "", memo: "quoted text" })
	).toEqual({ customer_id: "", memo: "quoted text" });
	expect(() => FixtureRunInputSchema.parse({ customer_id: 12 })).toThrow();
});

test("companion snapshots retain captured own keys and reject malformed workflow graphs", () => {
	const raw =
		'{"bindings":{},"calls":[{"args":{"__proto__":{"retained":true}},"method":"workflows.save"}],"runs":{},"versions":{},"workflows":[]}';
	const parsed = parseWorkflowCompanionSnapshot(raw);
	expect(Object.keys(parsed.calls[0].args)).toContain("__proto__");
	expect(parsed.workflows).toEqual([]);
	const invalid =
		'{"bindings":{},"calls":[],"runs":{},"versions":{},"workflows":[{"id":"bad","name":"bad","edges":[],"nodes":[{"type":"input"}],"triggers":[]}]}';
	expect(() => parseWorkflowCompanionSnapshot(invalid)).toThrow();
});

test("companion input and binding parsing preserves special own keys after checking each declared contract", () => {
	const parsed = parseCompanionRunInput(
		JSON.parse('{"__proto__":"echo","customer_id":"42"}')
	);
	expect(Object.keys(parsed)).toContain("__proto__");
	expect(parsed.customer_id).toBe("42");
	expect(() =>
		parseCompanionRunInput(JSON.parse('{"__proto__":12}'))
	).toThrow();
	const binding = parseCompanionBinding(
		JSON.parse(
			'{"id":"binding-1","triggerId":"connection-1","triggerSlug":"new-mail","__proto__":{"retained":true}}'
		)
	);
	expect(Object.keys(binding)).toContain("__proto__");
});
