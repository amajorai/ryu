// Capability adapter for `browser.control / browser.scroll` backed by Kernel.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// Kernel has no shared "active tab": each browser is a Kernel session, and the
// session id IS the canonical tab_id that browser.navigate and browser.tabs return.
//
// Kernel scrolls in xdotool wheel units at a viewport point, not in pixels. The
// adapter scrolls at the viewport centre when the session reports its viewport
// (a corner point otherwise) and converts the canonical pixel amount at roughly
// 100 px per wheel unit, reporting the units and point it actually sent so the
// caller is never told an exact pixel distance it did not get.

const sessionId = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!sessionId) {
	return { error: "tab_id is required; it is the Kernel browser session id from browser.navigate or browser.tabs" };
}
const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const vector = DIRECTIONS[input.direction];
if (!vector) {
	return { error: "direction must be up, down, left, or right" };
}
const failed = (result) =>
	!result || result.isError === true || Boolean(result.error) || result.available === false;

const info = await callNamed("kernel.manage_browsers", { action: "get", session_id: sessionId });
if (failed(info)) {
	return info;
}
let viewport;
try {
	viewport = JSON.parse(info.content?.find((item) => item?.type === "text")?.text ?? "")?.viewport;
} catch {
	viewport = undefined;
}
const amount =
	typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount > 0
		? input.amount
		: 500;
const units = Math.max(1, Math.round(amount / 100));
const centred = Number.isFinite(viewport?.width) && Number.isFinite(viewport?.height);
const scroll = {
	x: centred ? Math.round(viewport.width / 2) : 10,
	y: centred ? Math.round(viewport.height / 2) : 10,
};
if (vector[0] !== 0) {
	scroll.delta_x = vector[0] * units;
}
if (vector[1] !== 0) {
	scroll.delta_y = vector[1] * units;
}
const raw = await callTool({ session_id: sessionId, actions: [{ type: "scroll", scroll }] });
if (failed(raw)) {
	return raw;
}
return {
	ok: true,
	tab_id: sessionId,
	direction: input.direction,
	wheel_units: units,
	point: { x: scroll.x, y: scroll.y },
	raw,
};
