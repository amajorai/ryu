// Capability adapter for `browser.control / browser.type` backed by browser-use.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// browser-use acts on its active tab and reports some failures as plain text
// ("Error: ..." or "Element with index N not found") without isError, so both
// shapes count as failure here rather than being passed on as success.
//
// browser_type clears the field before typing, so it always OVERWRITES, and the
// MCP server has no key-press tool for an Enter afterwards. An append request or
// submit is refused up front instead of being silently changed.

const textOf = (result) => result?.content?.find((item) => item?.type === "text")?.text ?? "";
const failed = (result) =>
	!result ||
	result.isError === true ||
	Boolean(result.error) ||
	result.available === false ||
	/^(Error:|Element with index )/.test(textOf(result));

// Snapshot refs are "@e<index>"; a bare index is accepted too.
const match = /^@?e?(\d+)$/.exec(typeof input.ref === "string" ? input.ref.trim() : "");
if (!match) {
	return { error: "ref must be an element reference from browser.snapshot, such as @e12" };
}
const index = Number(match[1]);
if (typeof input.text !== "string") {
	return { error: "text is required" };
}
if (input.replace !== true) {
	return {
		error:
			"browser-use always replaces a field's value; pass replace: true to overwrite it, or include the existing text",
	};
}
if (input.submit === true) {
	return { error: "browser-use's MCP server cannot press Enter after typing; click the submit control instead" };
}

// Honour the canonical tab_id by switching first instead of acting on whichever
// tab happens to be active. browser.tabs returns browser-use's own tab ids.
if (typeof input.tab_id === "string" && input.tab_id.trim()) {
	const switched = await callNamed("browseruse.browser_switch_tab", { tab_id: input.tab_id.trim() });
	if (failed(switched)) {
		return switched;
	}
}
const typed = await callTool({ index, text: input.text });
if (failed(typed)) {
	return typed;
}
return { ok: true, ref: input.ref, submitted: false, raw: typed };
