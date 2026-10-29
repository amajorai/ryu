// Capability adapter for `browser.control / browser.type` backed by Steel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Steel has no shared "active tab": every page lives in a Steel session, and the
// session handle IS the canonical tab_id that browser.navigate returns.
//
// Steel's `type` action selects the field's contents before inserting text, so
// it always OVERWRITES. The canonical verb appends unless `replace` is set; an
// append request is refused rather than silently replacing the user's value.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Steel session id from browser.navigate" };
}
if (typeof input.ref !== "string" || !input.ref) {
	return { error: "ref is required" };
}
if (typeof input.text !== "string") {
	return { error: "text is required" };
}
if (input.replace !== true) {
	return {
		error:
			"Steel always replaces a field's value; pass replace: true to overwrite it, or include the existing text",
	};
}
const failed = (result) =>
	!result || result.isError === true || Boolean(result.error) || result.available === false;

const typed = await callTool({
	session_id: sessionId,
	action: "type",
	target: input.ref,
	value: input.text,
});
if (failed(typed)) {
	return typed;
}
if (!input.submit) {
	return { ok: true, ref: input.ref, submitted: false, raw: typed };
}
const pressed = await callTool({ session_id: sessionId, action: "press", value: "Enter" });
if (failed(pressed)) {
	return pressed;
}
return { ok: true, ref: input.ref, submitted: true, raw: { typed, pressed } };
