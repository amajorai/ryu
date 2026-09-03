// Tool body for `text_chunk`, run in Core's Deno sandbox.
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// with `input` (the call arguments) and `host` (the capability bridge) already
// bound, and the body `return`s the tool's result. A top-level `return` is
// therefore correct here and `export` is not.
//
// It is the worked example `tools/toolsmith` ships: a real tool, not a stub, so
// the case table next to it demonstrates the boundaries worth pinning rather than
// three variations on "it works".

const size = Number.isInteger(input.size) ? input.size : 512;
const overlap = Number.isInteger(input.overlap) ? input.overlap : 0;

if (typeof input.text !== "string") {
	throw new Error("text_chunk: 'text' is required and must be a string");
}
if (size <= 0) {
	throw new Error(`text_chunk: 'size' must be positive, got ${size}`);
}
// Guarded because `size - overlap <= 0` makes the cursor stop advancing and the
// loop below never terminates. A tool that hangs the sandbox on a bad argument is
// worse than one that rejects it: the caller gets a timeout with no reason.
if (overlap < 0 || overlap >= size) {
	throw new Error(
		`text_chunk: 'overlap' must be in [0, size), got ${overlap} with size ${size}`
	);
}

const chunks = [];
const stride = size - overlap;
for (let start = 0; start < input.text.length; start += stride) {
	chunks.push({ start, text: input.text.slice(start, start + size) });
}

// An empty input yields ZERO chunks, not one empty chunk. The distinction is the
// whole reason this is a case: a downstream embedder handed `[{text: ""}]` bills
// for a vector of nothing and stores it as a real match.
return { count: chunks.length, chunks };
