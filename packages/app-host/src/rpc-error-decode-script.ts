// Settles a pending RPC from a host `ryu-plugin-rpc-result` frame inside the
// generated sandbox bootstraps. This is the ONE place the frame-side RPC error
// decoding lives: change how a structured `{ code, message }` error (or a legacy
// string error) becomes an `Error` here, not in the document builders.
//
// The fragments are spliced verbatim into generated JavaScript, so indentation and
// formatting are part of the output (`srcdoc-split-parity.test.ts` pins the bytes).
// Each one runs inside `onPortMessage`, where `msg` is the result frame and `p` is
// the pending `{ resolve, reject }` entry already removed from the table.

/** Companion bootstrap (Path A `thirdPartyPluginSrcdoc` and Path B
 *  `htmlCompanionSrcdoc`): rejects on ANY error (string legacy OR structured
 *  `{ code, message }`) with an `Error` that carries `code` when the host sent one,
 *  plus the HTTP `status` and the server's own `reason` sentence when an
 *  `app.request` failed, else resolves with `msg.result`. */
export function companionRpcResultSettleScript(): string {
	return `      if (msg.error !== undefined && msg.error !== null) {
        var em = (typeof msg.error === "string" ? msg.error : msg.error.message) || "error";
        var error = new Error(em);
        if (typeof msg.error === "object" && msg.error.code) error.code = msg.error.code;
        if (typeof msg.error === "object" && typeof msg.error.status === "number") error.status = msg.error.status;
        if (typeof msg.error === "object" && typeof msg.error.reason === "string") error.reason = msg.error.reason;
        p.reject(error);
      } else {
        p.resolve(msg.result);
      }`;
}

/** Widget bootstrap (`widgetBootstrapSrcdoc`): the compact variant. A structured
 *  error always gets a `code` property (undefined when the host sent none), and
 *  `status` / `reason` when the host relayed a failed `app.request`. */
export function widgetRpcResultSettleScript(): string {
	return `      if(msg.error !== undefined && msg.error !== null){
        var e;
        if(typeof msg.error === "string"){ e = new Error(msg.error || "error"); }
        else {
          e = new Error((msg.error && msg.error.message) || "error"); e.code = msg.error && msg.error.code;
          if(typeof msg.error.status === "number") e.status = msg.error.status;
          if(typeof msg.error.reason === "string") e.reason = msg.error.reason;
        }
        p.reject(e);
      } else { p.resolve(msg.result); }`;
}
