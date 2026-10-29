// Capability adapter for `verify.claim / verify.claim`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// apps-store/*/adapters is excluded from Biome — a module parser rejects it.

// The canonical verdicts are the verification layer's vocabulary, not the solver's.
// Every solver outcome that is not a decision (nothing formalizable, readings that
// disagree, a budget that ran out) maps to `unverifiable`, never to a pass.
const VERDICTS = {
	valid: "proved",
	invalid: "refuted",
	satisfiable: "undecided",
	impossible: "inconsistent",
};
const verdictOf = (solver) => VERDICTS[solver] || "unverifiable";
const unverifiable = (reason, extra) => ({
	verdict: "unverifiable",
	reason,
	claims: [],
	...extra,
});

const claim = parsePrimitiveText(input.claim);
if (claim === undefined || claim.trim() === "") {
	return unverifiable("`claim` must be a non-empty string.");
}

// A scope is a saved reasoning policy. With none named, the only safe default is
// the ONLY policy: guessing among several would check the claim against rules the
// caller never chose.
let scope = parsePrimitiveText(input.scope);
if (scope === undefined || scope.trim() === "") {
	const listed = decodeToolResult(await callNamed("reasoning.policies", {}));
	if (listed.error !== undefined) {
		return unverifiable(`Could not list policies: ${listed.error}`);
	}
	const policies = Array.isArray(listed.value?.policies)
		? listed.value.policies
		: [];
	if (policies.length === 0) {
		return unverifiable(
			"No reasoning policy exists yet, so there is nothing to check this claim against. Create one in Automated Reasoning first."
		);
	}
	if (policies.length > 1) {
		return unverifiable(
			"More than one policy exists. Pass `scope` with one of these ids (see verify.scopes).",
			{ scopes: policies.map((p) => ({ id: p.id, name: p.name })) }
		);
	}
	scope = policies[0].id;
}

const checked = decodeToolResult(
	await callTool({
		policy_id: scope,
		question: parsePrimitiveText(input.question) ?? "",
		answer: claim,
	})
);
if (checked.error !== undefined) {
	return unverifiable(checked.error, { scope: { id: scope } });
}
const report = checked.value;
if (!report || report.result === undefined) {
	return unverifiable("The solver returned no verdict.", { raw: report });
}
const constraint = (c) => ({
	id: c.id,
	statement: c.statement,
	origin: c.origin,
});
const claims = (Array.isArray(report.findings) ? report.findings : []).map(
	(f) => ({
		claim: f.claim_statement || f.claim,
		verdict: verdictOf(f.verdict),
		evidence: (f.responsible || []).map(constraint),
		assumptions: (f.unstated_assumptions || []).map(constraint),
		counterexample: f.counterexample ?? undefined,
		detail: f.detail,
		provider_verdict: f.verdict,
	})
);
const notes = Array.isArray(report.notes) ? report.notes : [];
return {
	...headline(claims, notes, report.result),
	scope: { id: report.policy_id, version: report.policy_version },
	claims,
	premises: report.premises || [],
	notes,
	provider_verdict: report.result,
	raw: report,
};

// The headline is folded from the per-claim verdicts, not copied from the solver's
// aggregate. The solver reports `valid` when one sentence is proved and the rest
// could not be expressed in the policy at all, but this layer promises that only
// `proved` means the claim is backed. So a contradiction anywhere refutes the
// claim, and `proved` needs every extracted part proved, the solver's aggregate to
// agree, and nothing skipped: sentences the extraction left out, facts that did
// not parse and rules that did not compile are all reported in `notes`.
function headline(parts, skipped, aggregate) {
	const precedence = ["refuted", "inconsistent", "unverifiable", "undecided"];
	for (const verdict of precedence) {
		if (parts.some((part) => part.verdict === verdict)) {
			return verdict === "unverifiable"
				? {
						verdict,
						reason:
							"At least one part of the claim could not be checked (see `claims`), so no verdict covers the whole claim.",
					}
				: { verdict };
		}
	}
	if (parts.length === 0) {
		return {
			verdict: "unverifiable",
			reason:
				"Nothing in the claim could be expressed in this policy's vocabulary, so nothing was checked.",
		};
	}
	if (aggregate !== "valid" || skipped.length > 0) {
		return {
			verdict: "unverifiable",
			reason:
				"Only part of the claim could be formalized and checked, so it is not reported as proved. See `claims` and `notes` for what was left out.",
		};
	}
	return { verdict: "proved" };
}

// An MCP `tools/call` answer is the TRANSPORT envelope, not the tool's value:
// `{content: [{type, text}], structuredContent, isError}`. The reasoning server puts
// its JSON in the text block, so decode that; prefer `structuredContent` if a later
// server version adds it. An error envelope is reported, never decoded as a result.
function decodeToolResult(envelope) {
	if (!envelope || typeof envelope !== "object") {
		return { error: "The reasoning server returned nothing." };
	}
	const text = parsePrimitiveText(envelope.content?.[0]?.text);
	let value = envelope.structuredContent;
	if (value === undefined && text !== undefined) {
		try {
			value = JSON.parse(text);
		} catch {
			value = undefined;
		}
	}
	if (envelope.isError || envelope.available === false) {
		return {
			error:
				parsePrimitiveText(value?.error) ??
				parsePrimitiveText(envelope.reason) ??
				text ??
				"The reasoning server reported an error.",
		};
	}
	if (value === undefined) {
		return { error: "The reasoning server returned no readable result." };
	}
	return { value };
}

// Decode with the native String internal-slot check; boxed strings remain
// non-text inputs. This flat sandbox fragment needs no module imports.
function parsePrimitiveText(value) {
	try {
		const parsed = String.prototype.valueOf.call(value);
		return parsed === value ? parsed : undefined;
	} catch {
		return undefined;
	}
}
