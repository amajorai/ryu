import { expect, test } from "bun:test";
import { featureWaitlistFormSchema } from "./feature-waitlists.ts";

function form(fields: unknown[]) {
	return {
		description: "Ask a few questions before launch.",
		fields,
		successMessage: "Thanks, we will be in touch.",
		title: "Join the list",
	};
}

test("feature waitlist form accepts supported question types and bounded options", () => {
	const result = featureWaitlistFormSchema.safeParse(
		form([
			{
				id: "role",
				label: "What is your role?",
				required: true,
				type: "short_text",
			},
			{
				id: "use-case",
				label: "What will you use it for?",
				required: false,
				type: "long_text",
			},
			{
				id: "team-size",
				label: "Team size",
				options: ["1–5", "6–20", "21+"],
				required: true,
				type: "single_select",
			},
			{
				id: "consent",
				label: "I agree to be contacted",
				required: true,
				type: "checkbox",
			},
		])
	);

	expect(result.success).toBe(true);
});

test("feature waitlist form rejects too many questions and duplicate IDs", () => {
	const tooMany = Array.from({ length: 11 }, (_, index) => ({
		id: `question-${index}`,
		label: `Question ${index}`,
		required: false,
		type: "short_text",
	}));
	expect(featureWaitlistFormSchema.safeParse(form(tooMany)).success).toBe(
		false
	);

	const duplicateIds = [
		{ id: "same", label: "First", required: false, type: "short_text" },
		{ id: "same", label: "Second", required: false, type: "short_text" },
	];
	expect(featureWaitlistFormSchema.safeParse(form(duplicateIds)).success).toBe(
		false
	);
});

test("select questions require at least two unique options", () => {
	const base = {
		id: "team-size",
		label: "Team size",
		required: true,
		type: "single_select",
	};
	expect(
		featureWaitlistFormSchema.safeParse(form([{ ...base, options: ["Small"] }]))
			.success
	).toBe(false);
	expect(
		featureWaitlistFormSchema.safeParse(
			form([{ ...base, options: ["Small", "Small"] }])
		).success
	).toBe(false);
});
