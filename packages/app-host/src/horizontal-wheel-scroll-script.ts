/** CSP-safe equivalent of the shared UI wheel adapter for sandbox documents. */
export const HORIZONTAL_WHEEL_SCROLL_SCRIPT = `
function ryuInstallHorizontalWheelScrolling() {
  if (window.__ryuHorizontalWheelScrollingInstalled) return;
  window.__ryuHorizontalWheelScrollingInstalled = true;
  var slack = 1;
  var lineHeight = 16;

  function normalize(delta, mode, viewport) {
    if (mode === 1) return delta * lineHeight;
    if (mode === 2) return delta * viewport;
    return delta;
  }

  function asElement(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof value.clientHeight !== "number" ||
        typeof value.clientWidth !== "number" ||
        typeof value.scrollHeight !== "number" ||
        typeof value.scrollLeft !== "number" ||
        typeof value.scrollWidth !== "number") return null;
    return value;
  }

  function onWheel(event) {
    if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0 ||
        !Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX)) return;
    var candidate = asElement(event.target);
    if (!candidate && event.target) candidate = asElement(event.target.parentElement);
    var seen = [];

    while (candidate && seen.indexOf(candidate) === -1) {
      seen.push(candidate);
      var style = getComputedStyle(candidate);
      var overflowX = style.overflowX;
      var horizontalOverflow = candidate.scrollWidth - candidate.clientWidth > slack;
      var verticalOverflow = candidate.scrollHeight - candidate.clientHeight > slack;
      var scrollable = overflowX === "auto" || overflowX === "overlay" || overflowX === "scroll";
      if (horizontalOverflow && !verticalOverflow && scrollable) {
        // Under RTL scrollLeft runs from 0 toward negative values, so the
        // vertical term flips to keep wheel-down moving toward the inline end.
        // deltaX is physical and stays as it is.
        var inlineY = normalize(event.deltaY, event.deltaMode, candidate.clientHeight);
        if (style.direction === "rtl") inlineY = -inlineY;
        var delta = normalize(event.deltaX, event.deltaMode, candidate.clientWidth) + inlineY;
        if (delta !== 0) {
          var before = candidate.scrollLeft;
          candidate.scrollLeft += delta;
          if (candidate.scrollLeft !== before) {
            event.preventDefault();
            return;
          }
        }
      }
      candidate = asElement(candidate.parentElement);
    }
  }

  document.addEventListener("wheel", onWheel, { passive: false });
}

ryuInstallHorizontalWheelScrolling();
`;
