// The `i18n` namespace every Companion bridge installs: Path A `makePlugin` and
// `installWindowRyu` (`third-party-plugin.ts`, `plugin-window-ryu-script.ts`) and the
// Path B `window.ryu` (`html-companion-window-ryu.ts`). Each verb is an RPC over the
// capability-gated port; the host answers from its own locale state.

/** Object-literal member text (`i18n: { get, translate, subscribe }`) spliced into
 *  the generated bridges; callers indent it with `indentGeneratedScript`. */
export const I18N_BRIDGE = `i18n: {
  get: function () { return call("i18n.get", []); },
  translate: function (a) { return call("i18n.translate", [a || {}]); },
  subscribe: function (opts) {
    opts = opts || {};
    var h = callStream("i18n.subscribe", [{}], function (d) {
      try {
        if (opts.onChange) opts.onChange(JSON.parse(d));
      } catch (e) {}
    });
    h.promise.catch(function () {});
    return { dispose: h.cancel };
  }
}`;
