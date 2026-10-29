//! The JavaScript sandbox guest for `ryu-tool-exec`.
//!
//! QuickJS (through the Bytecode Alliance's Javy runtime) compiled to
//! `wasm32-wasip1` and run by the host inside Wasmtime. The guest is a generic
//! script runner: the host hands it ONE script (its bootstrap + the user program,
//! built host-side in `js_backend.rs`) and the script reaches the outside world
//! only through the `ryu` imports below. There is no filesystem, network, env or
//! clock beyond what the host's empty WASI context answers.
//!
//! Protocol (all strings UTF-8):
//! - `script_len` / `script_read` — fetch the script once at startup.
//! - `call(req)` → id — start one host operation (`{kind, ...}` JSON). It returns
//!   at once unless the host has not yet drained its operation channel, in which
//!   case it blocks until the host reads it (backpressure); the script awaits the
//!   promise it registered under that id. The host holds each operation's
//!   concurrency slot until `wait` hands its reply over, and fails the run if a
//!   script starts more operations than its waiting queue holds.
//! - `wait(buf, cap)` — block until the next operation settles and copy its
//!   reply JSON into `buf`. Returns the length, `-needed` when `cap` is too small
//!   (the host keeps the frame for the retry), or `0` when the host is gone.
//! - `log(line)` / `done(value, is_error)` — console output and the final result.
//!
//! The guest also provides pure helpers that never leave the instance:
//! `__ryu_url_*` / `__ryu_query_*` back the bootstrap's WHATWG `URL` and
//! `URLSearchParams` with the `url` crate, so a security check written against
//! `new URL(...)` sees spec-exact parsing rather than a hand-rolled polyfill.
//!
//! Rebuild with `tools/build-js-guest.sh` after editing this file; it writes the
//! embedded `../assets/ryu_js_guest.wasm` and its `.sha256`.

use javy::quickjs::function::{Func, Opt, Rest};
use javy::quickjs::{Ctx, Function, Value};
use javy::{Config, Runtime};
use std::cell::Cell;
use url::{quirks, Url};

#[link(wasm_import_module = "ryu")]
extern "C" {
    fn script_len() -> u32;
    fn script_read(ptr: *mut u8);
    fn call(ptr: *const u8, len: u32) -> u32;
    fn wait(ptr: *mut u8, cap: u32) -> i32;
    fn log(ptr: *const u8, len: u32);
    fn done(ptr: *const u8, len: u32, is_error: u32);
}

thread_local! {
    static FINISHED: Cell<bool> = const { Cell::new(false) };
    static OUTSTANDING: Cell<u32> = const { Cell::new(0) };
}

fn report(message: &str, is_error: bool) {
    // SAFETY: the pointer/length pair describes a live, initialized buffer.
    unsafe { done(message.as_ptr(), message.len() as u32, u32::from(is_error)) };
    FINISHED.with(|finished| finished.set(true));
}

fn read_script() -> Option<String> {
    // SAFETY: the host writes exactly `script_len()` bytes into the buffer.
    let bytes = unsafe {
        let mut buf = vec![0u8; script_len() as usize];
        script_read(buf.as_mut_ptr());
        buf
    };
    String::from_utf8(bytes).ok()
}

fn install_imports(cx: &Ctx<'_>) -> javy::quickjs::Result<()> {
    let globals = cx.globals();
    globals.set(
        "__ryu_call",
        Func::from(|request: String| {
            OUTSTANDING.with(|n| n.set(n.get() + 1));
            // SAFETY: as in `report`.
            unsafe { call(request.as_ptr(), request.len() as u32) }
        }),
    )?;
    globals.set(
        "__ryu_log",
        Func::from(|line: String| unsafe { log(line.as_ptr(), line.len() as u32) }),
    )?;
    globals.set(
        "__ryu_done",
        Func::from(|value: String, is_error: bool| report(&value, is_error)),
    )?;
    globals.set(
        "__ryu_url_parse",
        Func::from(|input: String, base: Opt<String>| {
            let parsed = match base.0 {
                Some(base) => Url::parse(&base).and_then(|b| b.join(&input)),
                None => Url::parse(&input),
            };
            parsed.ok().map(|url| url_record(&url))
        }),
    )?;
    globals.set(
        "__ryu_url_set",
        Func::from(|href: String, field: String, value: String| {
            let mut url = Url::parse(&href).ok()?;
            match field.as_str() {
                "href" => quirks::set_href(&mut url, &value).ok()?,
                "protocol" => quirks::set_protocol(&mut url, &value).ok()?,
                "username" => quirks::set_username(&mut url, &value).ok()?,
                "password" => quirks::set_password(&mut url, &value).ok()?,
                "host" => quirks::set_host(&mut url, &value).ok()?,
                "hostname" => quirks::set_hostname(&mut url, &value).ok()?,
                "port" => quirks::set_port(&mut url, &value).ok()?,
                "pathname" => quirks::set_pathname(&mut url, &value),
                "search" => quirks::set_search(&mut url, &value),
                "hash" => quirks::set_hash(&mut url, &value),
                _ => return None,
            }
            Some(url_record(&url))
        }),
    )?;
    globals.set(
        "__ryu_query_parse",
        Func::from(|query: String| {
            let mut fields = Vec::new();
            for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
                fields.push(key.into_owned());
                fields.push(value.into_owned());
            }
            json_array(&fields)
        }),
    )?;
    globals.set(
        "__ryu_query_serialize",
        Func::from(|flat: Rest<String>| {
            let mut out = url::form_urlencoded::Serializer::new(String::new());
            for pair in flat.0.chunks(2) {
                if let [key, value] = pair {
                    out.append_pair(key, value);
                }
            }
            out.finish()
        }),
    )?;
    Ok(())
}

/// A URL's WHATWG getters, as a JSON array in a fixed order the bootstrap's
/// `URL` class reads back.
fn url_record(url: &Url) -> String {
    json_array(&[
        quirks::href(url),
        &quirks::origin(url),
        quirks::protocol(url),
        quirks::username(url),
        quirks::password(url),
        quirks::host(url),
        quirks::hostname(url),
        quirks::port(url),
        quirks::pathname(url),
        quirks::search(url),
        quirks::hash(url),
    ])
}

fn json_array<S: AsRef<str>>(items: &[S]) -> String {
    let mut out = String::from("[");
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        for c in item.as_ref().chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }
    out.push(']');
    out
}

/// `Name: message` for a thrown JS value (a script that failed to parse, or a
/// throw outside the program's own try/catch), falling back to the engine error.
fn describe_error(cx: &Ctx<'_>, error: javy::quickjs::Error) -> String {
    if !error.is_exception() {
        return error.to_string();
    }
    let thrown = cx.catch();
    let Some(object) = thrown.as_object() else {
        return thrown
            .as_string()
            .and_then(|s| s.to_string().ok())
            .unwrap_or_else(|| "uncaught exception".to_owned());
    };
    let name: Option<String> = object.get("name").ok();
    let message: Option<String> = object.get("message").ok();
    match (name, message) {
        (Some(name), Some(message)) => format!("{name}: {message}"),
        (None, Some(message)) => message,
        _ => "uncaught exception".to_owned(),
    }
}

/// Block on the host for the next settled operation's reply.
fn next_reply(buf: &mut Vec<u8>) -> Option<String> {
    // SAFETY: `buf` is a live buffer of `buf.len()` bytes.
    let mut n = unsafe { wait(buf.as_mut_ptr(), buf.len() as u32) };
    if n < 0 {
        buf.resize(n.unsigned_abs() as usize, 0);
        n = unsafe { wait(buf.as_mut_ptr(), buf.len() as u32) };
    }
    if n <= 0 {
        return None;
    }
    String::from_utf8(buf[..n as usize].to_vec()).ok()
}

fn main() {
    let Some(script) = read_script() else {
        return report("sandbox script is not valid UTF-8", true);
    };
    let mut config = Config::default();
    config.text_encoding(true);
    let runtime = match Runtime::new(config) {
        Ok(runtime) => runtime,
        Err(e) => return report(&format!("sandbox runtime failed to start: {e}"), true),
    };

    runtime.context().with(|cx| {
        if let Err(e) = install_imports(&cx) {
            return report(&format!("sandbox bridge failed to install: {e}"), true);
        }
        if let Err(e) = cx.eval::<Value, _>(script) {
            report(&describe_error(&cx, e), true);
        }
    });

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if let Err(e) = runtime.resolve_pending_jobs() {
            return report(&e.to_string(), true);
        }
        if FINISHED.with(Cell::get) {
            return;
        }
        if OUTSTANDING.with(Cell::get) == 0 {
            return report(
                "the program is waiting on a promise that nothing will settle",
                true,
            );
        }
        let Some(reply) = next_reply(&mut buf) else {
            return;
        };
        OUTSTANDING.with(|n| n.set(n.get() - 1));
        let settled = runtime.context().with(|cx| {
            let settle: Function = cx.globals().get("__ryu_settle")?;
            settle.call::<_, ()>((reply,))
        });
        if let Err(e) = settled {
            return report(&format!("sandbox bridge failed: {e}"), true);
        }
    }
}
