// Capability adapter for `browser.control / browser.scroll` backed by browser-use.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// browser-use acts on its active tab and reports some failures as plain text
// ("Error: ..." or "Element with index N not found") without isError, so both
// shapes count as failure here rather than being passed on as success.
//
// browser_scroll moves a fixed 500 px vertically and takes no distance, so
// left/right and an explicit amount are refused rather than approximated.

const textOf = (result) => result?.content?.find((item) => item?.type === "text")?.text ?? "";
const failed = (result) =>
	!result ||
	result.isError === true ||
	Boolean(result.error) ||
	result.available === false ||
	/^(Error:|Element with index )/.test(textOf(result));
if (input.direction !== "up" && input.direction !== "down") {
	return { error: "browser-use scrolls vertically only; direction must be up or down" };
}
if (input.amount !== undefined && input.amount !== null && input.amount !== 500) {
	return { error: "browser-use scrolls a fixed 500 px; omit amount" };
}

// Honour the canonical tab_id by switching first instead of acting on whichever
// tab happens to be active. browser.tabs returns browser-use's own tab ids.
if (typeof input.tab_id === "string" && input.tab_id.trim()) {
	const switched = await callNamed("browseruse.browser_switch_tab", { tab_id: input.tab_id.trim() });
	if (failed(switched)) {
		return switched;
	}
}
const raw = await callTool({ direction: input.direction });
if (failed(raw)) {
	return raw;
}
return { ok: true, direction: input.direction, amount: 500, raw };
