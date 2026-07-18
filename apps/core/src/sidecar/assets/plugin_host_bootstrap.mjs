// Ryu extension-host bootstrap (RFC Option B) — the first-party entrypoint Core
// spawns for a `kind: "node"` manifest sidecar. It loads the plugin's declared
// backend module, calls its exported `activate(context)`, and serves the managed
// HTTP surface (health + the `/api/ext/<id>/*` proxied request handler) the rest of
// Ryu's sidecar lifecycle already expects.
//
// DEPENDENCY-FREE: only `node:http`, dynamic `import()`, and the global `fetch`
// (built in on bun and node >= 18) — no third-party packages, so the SAME file runs
// on stock `node` and on `bun` unchanged. Core injects everything via env; nothing is
// hardcoded.
//
// Env contract (all set by Core's `manifest_sidecar` node arm):
//   RYU_HOST_ENTRY        absolute path to the plugin's backend entry module
//   RYU_HOST_PORT         loopback port to bind (profile-shifted by Core)
//   RYU_HOST_HEALTH_PATH  health path Core probes (default "/health")
//   RYU_EXT_PLUGIN_ID     the owning plugin id
//   RYU_EXT_TOKEN         the per-plugin minted bearer (required on every request)
//   RYU_CORE_PORT         Core's loopback port for host RPC callbacks
//   RYU_HOST_PLUGIN_VERSION   the plugin's manifest version (for ctx.manifest)
//   RYU_HOST_API_VERSION      the host<->plugin contract version (ctx.hostApiVersion)

import http from "node:http";
import { pathToFileURL } from "node:url";

const env = process.env;
const PLUGIN_ID = env.RYU_EXT_PLUGIN_ID || "";
const EXT_TOKEN = env.RYU_EXT_TOKEN || "";
const CORE_PORT = env.RYU_CORE_PORT || "";
const PORT = Number.parseInt(env.RYU_HOST_PORT || "0", 10);
const HEALTH_PATH = env.RYU_HOST_HEALTH_PATH || "/health";
const ENTRY = env.RYU_HOST_ENTRY || "";

// Structured, greppable startup log to Core's captured stderr.
function log(msg, extra) {
  const rec = { level: "info", src: "ryu-host", plugin: PLUGIN_ID, msg, ...extra };
  process.stderr.write(`${JSON.stringify(rec)}\n`);
}

// Presented-bearer check: loopback is NOT authentication (Core mints a per-plugin
// token, re-stamps it on every proxied hop, and presents it on the health probe).
// A request without the exact token is refused — the same fail-closed posture the
// native test sidecar enforces.
function authorized(req) {
  if (!EXT_TOKEN) {
    return true; // no token configured (never in a real spawn) → do not lock out
  }
  const header = req.headers["authorization"] || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  return provided === EXT_TOKEN;
}

// The plugin's registered request handler (via ctx.http.onRequest). Absent → the
// bootstrap 404s every non-health path (an app with no HTTP surface).
let requestHandler = null;
let activated = false;

// The host bridge exposed to the plugin: every call routes through Core's ONE
// governed RPC endpoint (`POST /api/host/rpc`), which grant-gates + dispatches
// through the same PluginHookBridge the Deno turn-hook sandbox uses. No new
// vocabulary — `method` must be a row in the kernel-contracts host-API table.
async function hostCall(method, args) {
  if (!CORE_PORT) {
    throw new Error("RYU_CORE_PORT is not set; host RPC is unavailable");
  }
  const res = await fetch(`http://127.0.0.1:${CORE_PORT}/api/host/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${EXT_TOKEN}`,
      "x-ryu-plugin-id": PLUGIN_ID,
    },
    body: JSON.stringify({ method, args: args ?? {} }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) {
    throw new Error(
      `host.call('${method}') failed (${res.status}): ${parsed.error ?? text}`
    );
  }
  return parsed.result;
}

const context = {
  manifest: { id: PLUGIN_ID, version: env.RYU_HOST_PLUGIN_VERSION || "" },
  hostApiVersion: env.RYU_HOST_API_VERSION || "",
  host: { call: hostCall },
  http: {
    // Register the handler Core's `/api/ext/<id>/*` proxy forwards to. The handler
    // receives a normalized request `{ method, path, headers, body }` and returns
    // `{ status?, headers?, body? | json? }` (or a value shorthand → JSON 200).
    onRequest(handler) {
      requestHandler = handler;
    },
  },
};

function send(res, status, headers, body) {
  res.writeHead(status, headers || { "content-type": "application/json" });
  res.end(body == null ? "" : body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req, res) {
  if (!authorized(req)) {
    return send(res, 401, undefined, JSON.stringify({ error: "unauthorized" }));
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === HEALTH_PATH) {
    // Healthy ONLY once activate() has resolved, so Core's health monitor (and the
    // lazy wake-wait) never forwards traffic before the plugin is ready.
    if (activated) {
      return send(res, 200, undefined, JSON.stringify({ ok: true, plugin: PLUGIN_ID }));
    }
    return send(res, 503, undefined, JSON.stringify({ ok: false, activating: true }));
  }

  if (!requestHandler) {
    return send(res, 404, undefined, JSON.stringify({ error: "no request handler registered" }));
  }

  try {
    const body = await readBody(req);
    const result = await requestHandler({
      method: req.method,
      path,
      headers: req.headers,
      body,
    });
    if (result == null) {
      return send(res, 404, undefined, JSON.stringify({ error: "not found" }));
    }
    const status = typeof result.status === "number" ? result.status : 200;
    if (result.json !== undefined) {
      return send(res, status, { "content-type": "application/json" }, JSON.stringify(result.json));
    }
    if (result.body !== undefined) {
      return send(res, status, result.headers, result.body);
    }
    // Value shorthand: the handler returned a plain object → JSON 200.
    return send(res, status, { "content-type": "application/json" }, JSON.stringify(result));
  } catch (err) {
    return send(res, 500, undefined, JSON.stringify({ error: String(err && err.message ? err.message : err) }));
  }
}

async function main() {
  if (!ENTRY) {
    log("no RYU_HOST_ENTRY set; refusing to start", { level: "error" });
    process.exit(2);
  }
  if (!Number.isInteger(PORT) || PORT <= 0) {
    log("invalid RYU_HOST_PORT; refusing to start", { level: "error" });
    process.exit(2);
  }

  // Start the HTTP server FIRST (health returns 503 until activate resolves), so a
  // slow activate() never makes Core think the process failed to bind.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        send(res, 500, undefined, JSON.stringify({ error: String(err) }));
      } catch {
        /* response already sent */
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  log("host server listening", { port: PORT });

  // Load the plugin's backend module and activate it. A throwing/rejecting
  // activate() exits non-zero so Core's health monitor reports the sidecar down
  // (fail-closed) rather than silently serving 503 forever.
  let mod;
  try {
    mod = await import(pathToFileURL(ENTRY).href);
  } catch (err) {
    log("failed to import entry module", { level: "error", error: String(err), entry: ENTRY });
    process.exit(3);
  }
  const activate = mod.activate || (mod.default && mod.default.activate);
  if (typeof activate !== "function") {
    log("entry module has no exported activate()", { level: "error", entry: ENTRY });
    process.exit(3);
  }
  try {
    await activate(context);
  } catch (err) {
    log("activate() threw", { level: "error", error: String(err) });
    process.exit(4);
  }
  activated = true;
  log("plugin activated");

  // Cooperative shutdown: run the plugin's optional deactivate() on SIGTERM/SIGINT.
  // NOTE: Core's current `handle.stop()` sends SIGKILL (not catchable), so this path
  // is aspirational today — it fires only if the process receives a catchable signal
  // (e.g. a future graceful-stop that sends SIGTERM first, or a manual kill).
  const shutdown = async () => {
    const deactivate = mod.deactivate || (mod.default && mod.default.deactivate);
    if (typeof deactivate === "function") {
      try {
        await deactivate(context);
      } catch (err) {
        log("deactivate() threw", { level: "error", error: String(err) });
      }
    }
    server.close(() => process.exit(0));
    // Hard-exit backstop if close hangs.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log("bootstrap fatal", { level: "error", error: String(err) });
  process.exit(1);
});
