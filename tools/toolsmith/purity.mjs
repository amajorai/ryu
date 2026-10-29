// Static determinism scan for a Ryu sandboxed tool body.
//
// The runtime half of this lives in `harness.mjs`, which shadows every ambient
// nondeterministic global so reaching for one throws. That is the stronger check —
// but it only fires on a code path a case actually exercises. This scan is the
// cheap complement: it reads the source and rejects the reference outright, so a
// `Math.random()` sitting in an untested branch is caught before it ever ships.
//
// Deliberately a regex scan and not an AST walk. The body is a FRAGMENT with a
// top-level `return`, which no standard JS parser accepts as a Program — parsing
// would mean wrapping it first, and a wrapper changes the offsets every diagnostic
// points at. The patterns below are anchored on word boundaries and stripped of
// comments and strings first, which is accurate enough for a denylist whose whole
// purpose is to be conservative.

/** One denied construct: what to match, and what to tell the author instead. */
const DENIED = [
	{
		pattern: /\bDate\s*\.\s*now\s*\(/,
		what: "Date.now()",
		instead:
			"take the timestamp as an input field so the caller owns it, or accept a `now` argument",
	},
	{
		pattern: /\bnew\s+Date\s*\(\s*\)/,
		what: "new Date() with no argument",
		instead: "pass the epoch millis in as input: `new Date(input.at)`",
	},
	{
		pattern: /\bMath\s*\.\s*random\s*\(/,
		what: "Math.random()",
		instead:
			"take the random value as input, or derive it deterministically from an input field",
	},
	{
		pattern: /\bcrypto\s*\.\s*(randomUUID|getRandomValues)\s*\(/,
		what: "crypto randomness",
		instead:
			"have the caller supply the id — a tool that mints its own id cannot be replayed",
	},
	{
		pattern: /\bperformance\s*\.\s*now\s*\(/,
		what: "performance.now()",
		instead:
			"drop the timing, or return it under a field cases do not assert on",
	},
	{
		pattern: /\bfetch\s*\(/,
		what: "fetch()",
		instead:
			"route network through `callTool`/`callNamed` (adapter) or `host.*` (inline tool) — direct egress is not granted in the sandbox anyway",
	},
	{
		pattern: /\bprocess\s*\.\s*env\b/,
		what: "process.env",
		instead:
			"declare the value in the manifest (`arg_defaults`, `secret_headers`) so it is resolved host-side",
	},
	{
		pattern: /\bset(Timeout|Interval)\s*\(/,
		what: "timers",
		instead:
			"remove the delay — a tool body must be a straight-line function of its input",
	},
	{
		pattern: /\bglobalThis\b/,
		what: "globalThis",
		instead: "use only the bindings Core injects",
	},
	{
		pattern: /\beval\s*\(/,
		what: "eval()",
		instead:
			"write the logic out — dynamic evaluation is unauditable, which is the point",
	},
	{
		pattern: /\bnew\s+Function\s*\(/,
		what: "new Function()",
		instead: "write the logic out",
	},
	{
		pattern: /\brequire\s*\(/,
		what: "require()",
		instead: "the sandbox has no module resolver; inline what you need",
	},
	{
		pattern: /^\s*import\s+/m,
		what: "import statement",
		instead:
			"the body is a fragment spliced into an IIFE, not a module — an import is a syntax error at runtime",
	},
	{
		pattern: /^\s*export\s+/m,
		what: "export statement",
		instead:
			"the body is a fragment — `return` its result instead of exporting it",
	},
	{
		pattern: /\bchildProcess\s*\./,
		what: "the childProcess global",
		instead:
			"a self-built tool must not start processes — reach the outside world through host/callTool",
	},
];

/**
 * Blank out comments and string/template literals so a denied token quoted in
 * prose ("do not call Math.random here") is not reported as a violation.
 *
 * Replaces with same-length whitespace rather than deleting, so line and column
 * numbers in a diagnostic still match the file the author is looking at.
 */
function blankNonCode(source) {
	const blanked = source.replace(
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
		(match) => match.replace(/[^\n]/g, " ")
	);
	return blanked;
}

/**
 * Scan a tool body. Returns `[]` when the body is pure by this denylist, or one
 * entry per violation: `{ line, column, what, instead, source }`.
 */
export function scanPurity(source) {
	const code = blankNonCode(source);
	const lines = code.split("\n");
	const violations = [];

	for (const rule of DENIED) {
		// Per-line so every occurrence is reported, not only the first.
		for (const [index, line] of lines.entries()) {
			const match = line.match(rule.pattern);
			if (!match) {
				continue;
			}
			violations.push({
				line: index + 1,
				column: (match.index ?? 0) + 1,
				what: rule.what,
				instead: rule.instead,
				source: source.split("\n")[index]?.trim() ?? "",
			});
		}
	}

	violations.sort((a, b) => a.line - b.line || a.column - b.column);
	return violations;
}

/** Render violations as the diagnostic block the CLI prints. */
export function formatViolations(path, violations) {
	return violations
		.map(
			(v) =>
				`  ${path}:${v.line}:${v.column}  ${v.what}\n      ${v.source}\n      → ${v.instead}`
		)
		.join("\n");
}
