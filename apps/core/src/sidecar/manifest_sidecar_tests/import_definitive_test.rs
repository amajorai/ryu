use super::*;

/// The surfaced half: `health_check` reports the recorded reason through
/// [`HealthStatus::Unhealthy`] — the reason channel that already exists — so a
/// stopped sidecar reads as "binary not installed", not the indistinguishable
/// "process not running" a crash and a lazy scale-to-zero also produce.
#[tokio::test]
async fn health_check_says_binary_not_installed_rather_than_process_not_running() {
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    let plugin_id = format!("com.test.nobin-{}", uuid::Uuid::new_v4());
    let sc = ManifestSidecar::new(plugin_id.clone(), local_spec("ryu-test-nobin"), downloads);
    let name = sc.name().to_owned();

    // No record yet: a not-running sidecar (crashed, or lazily scaled to zero) must
    // NOT be reported as a missing binary — that would be a lie about the cause.
    assert!(!sc.is_running());
    let before = sc.health_check().await;
    let HealthStatus::Unhealthy(msg) = before else {
        panic!("a stopped sidecar is Unhealthy");
    };
    assert_eq!(msg, "process not running");

    record_missing_sidecar_binary(
        &name,
        &plugin_id,
        "ryu-test-nobin",
        "ryu-test-nobin-macos-aarch64",
        "not published for this platform".to_owned(),
    );
    let after = sc.health_check().await;
    let HealthStatus::Unhealthy(msg) = after else {
        panic!("a sidecar with no binary is Unhealthy");
    };
    assert!(
        msg.starts_with("binary not installed: "),
        "health must carry the missing-binary reason, got: {msg}"
    );
    assert!(msg.contains("not published for this platform"), "{msg}");

    clear_missing_sidecar_binary(&name);
}

/// A stranded claim is permanent and silent: the flag stays `true`, nothing was
/// stored so `has_ext_api_routes` stays `false`, and every later Healthy edge
/// spawns a task that loses the CAS and returns. The app then derives zero tools
/// for the life of the process with nothing in the log to say why. Releasing from
/// `Drop` rather than a trailing store is what makes an unwind survivable.
#[test]
fn claim_guard_releases_on_unwind() {
    let latch = Arc::new(AtomicBool::new(true));
    let escaped = std::panic::catch_unwind({
        let latch = Arc::clone(&latch);
        move || {
            let _claim = ClaimGuard(latch);
            panic!("lowering blew up");
        }
    });
    assert!(escaped.is_err(), "the panic must actually have unwound");
    assert!(
        !latch.load(Ordering::SeqCst),
        "an unwind must still release the claim, or the app never derives again"
    );
}

/// The re-wake guard. A `lazy` sidecar with `idle_stop_secs` crosses the Healthy
/// edge on every wake, so an unlatched hook would refetch and reparse the same
/// document for the life of the node.
///
/// This also pins the half that makes termination possible at all: a definitive
/// "no spec here" answer is RECORDED (as zero routes), not merely skipped. If it
/// were skipped, `has_ext_api_routes` would stay false and every one of the ~40
/// apps that serve no OpenAPI document would be re-probed twice a minute forever.
#[tokio::test]
async fn import_is_latched_and_does_not_refetch_on_rewake() {
    let (port, hits) = spawn_counting_probe();
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));

    import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "the first Healthy edge tries the root, then the mount-prefixed form"
    );
    assert!(
        registry.has_ext_api_routes("@ryu/probe"),
        "a definitive answer must be recorded even when it derives nothing"
    );

    import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
    assert_eq!(hits.load(Ordering::SeqCst), 2, "a re-wake must not refetch");
}

/// The ROOT is tried first. `http.mount` says where the sidecar nests its routes,
/// not where its server is rooted — the spec's own paths already carry the mount
/// (which is why `ext_api::lower` strips it), so an app nesting at `/api/crm`
/// still publishes its schema at `/openapi.json`. Getting this backwards 404s
/// every app that has a mount, and — because a 404 is definitive — latches it at
/// zero derived tools for the life of the process.
#[test]
fn openapi_is_probed_at_the_root_before_the_mount() {
    assert_eq!(
        openapi_doc_urls("http://127.0.0.1:8009", "/api/crm"),
        vec![
            "http://127.0.0.1:8009/openapi.json".to_owned(),
            "http://127.0.0.1:8009/api/crm/openapi.json".to_owned(),
        ]
    );
    // No mount ⇒ one candidate, not a duplicate of the same URL.
    assert_eq!(
        openapi_doc_urls("http://127.0.0.1:8009", ""),
        vec!["http://127.0.0.1:8009/openapi.json".to_owned()]
    );
}

/// …and the latch is re-armable, which is the whole reason it lives in the
/// REGISTRY rather than in this struct. `deactivate_plugin` and
/// `update_app_handler` both clear the rows without rebuilding the sidecar object;
/// a local done-flag would make those clears permanent (zero derived tools until
/// the next process restart) instead of a re-lower request.
#[tokio::test]
async fn clearing_the_registry_re_arms_the_import() {
    let (port, hits) = spawn_counting_probe();
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));

    import_openapi_once(probe_import(&registry), port, Arc::clone(&latch)).await;
    let after_first = hits.load(Ordering::SeqCst);
    assert!(after_first > 0);

    registry.clear_ext_api_routes("@ryu/probe");
    import_openapi_once(probe_import(&registry), port, latch).await;
    assert!(
        hits.load(Ordering::SeqCst) > after_first,
        "clearing the registry must let the next Healthy edge re-lower"
    );
}

/// A 404 is the app's real answer about this URL, so it stays DEFINITIVE: the ~40
/// shipped apps that publish no OpenAPI document must be recorded as "nothing to
/// derive" and never probed again, or every one of them pays two requests per
/// health poll for the life of the node.
///
/// The counterpart to `server_error_status_is_transient_and_retries` below — the
/// two together are the whole content of the status split, and asserting only one
/// of them would pass under a classifier that treats everything the same way.
#[tokio::test]
async fn not_found_is_definitive() {
    let (port, hits) = spawn_probe(ProbeReply::Status(404));
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "a 4xx at the root must still try the mount-prefixed candidate"
    );
    assert!(
        registry.has_ext_api_routes_for_sidecar(&key),
        "a 404 from every candidate is an answer, and must be recorded"
    );

    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "and it must never be re-asked"
    );
}

/// 401/403 stay DEFINITIVE, and that is a deliberate call rather than a gap in the
/// list. "The bearer was rejected" is a stable property of how the sidecar is
/// configured, not a hiccup — treating it as transient would put every
/// auth-misconfigured app into a permanent two-requests-per-30s loop that nothing
/// ever breaks, since the token Core presents does not change by being re-sent.
///
/// Pinned separately because it is the plausible wrong edit: "the token must have
/// rotated, so retry" reads reasonable and would leave the suite green. The INFO
/// line on the definitive branch carries the status precisely so an operator can
/// tell this case apart from a 404 without a retry loop to make it obvious.
#[tokio::test]
async fn unauthorized_is_definitive_not_a_retry_loop() {
    let (port, hits) = spawn_probe(ProbeReply::Status(401));
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    assert!(
        registry.has_ext_api_routes_for_sidecar(&key),
        "a rejected bearer is an answer about the app, not a transport hiccup"
    );
    let after_first = hits.load(Ordering::SeqCst);

    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        after_first,
        "…so it must never be re-asked"
    );
}

/// A 5xx is the sidecar failing, not answering — and the Healthy edge fires at
/// exactly the moment a sidecar is most likely to be mid-boot (health route up,
/// the rest of the router not yet mounted, workers still forking). Recording that
/// as "this app serves no OpenAPI document" would latch the app at zero derived
/// tools for the life of the process, on nothing but a slow start.
///
/// Also pins the no-second-candidate rule: a 503 at the root says nothing about
/// the mount, so retrying the mount would only add load to a sidecar that is
/// already shedding it. One hit per attempt, not two.
#[tokio::test]
async fn server_error_status_is_transient_and_retries() {
    let (port, hits) = spawn_probe(ProbeReply::Status(503));
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "a transient status must abort the candidate walk, not double the load"
    );
    assert!(
        !registry.has_ext_api_routes_for_sidecar(&key),
        "a 503 must store NOTHING, or the retry can never happen"
    );

    // The next Healthy edge (30s later in production; immediately here) re-asks.
    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "the sidecar that was briefly 503 must get another chance"
    );
}

/// Unbounded consumption: the only bound on this fetch used to be the 10s timeout,
/// and 10 seconds of loopback is gigabytes — buffered into a `Vec` and then handed
/// to a JSON parser.
///
/// Two properties in one test, because either alone is a false pass:
///
/// 1. The read is *stopped* — the probe streams far more than
///    [`EXT_API_SPEC_MAX_BYTES`] under a chunked encoding with no honest
///    `content-length`, so only the running total can stop it.
/// 2. The refusal is *definitive*. A transient classification here would be worse
///    than no cap at all: every 30s health poll would re-download the same
///    oversized document forever, turning a one-shot memory spike into a permanent
///    bandwidth loop.
#[tokio::test]
async fn oversized_spec_body_is_refused_and_not_retried() {
    let over = (EXT_API_SPEC_MAX_BYTES as usize) + 512 * 1024;
    let (port, hits) = spawn_probe(ProbeReply::OversizedBody { bytes: over });
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
    let latch = Arc::new(AtomicBool::new(false));
    let import = probe_import(&registry);
    let key = import.sidecar_key.clone();

    import_openapi_once(import, port, Arc::clone(&latch)).await;
    let after_first = hits.load(Ordering::SeqCst);
    assert_eq!(
        after_first, 1,
        "the first candidate answered 200, so the walk stops there"
    );
    assert!(
        registry.has_ext_api_routes_for_sidecar(&key),
        "an over-cap body must be recorded as a definitive zero-tool result"
    );

    import_openapi_once(probe_import(&registry), port, latch).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        after_first,
        "…and must NOT be re-downloaded on the next Healthy edge"
    );
}

/// The direct unit on the cap, so a regression is attributed to the reader rather
/// than to the hook around it — and so the `content-length` pre-check is pinned
/// independently of the streaming total the test above exercises.
#[tokio::test]
async fn a_lying_content_length_cannot_bypass_the_spec_cap() {
    // A server may under-declare (or omit) `content-length`; the pre-check is an
    // early-out, never the bound.
    let over = (EXT_API_SPEC_MAX_BYTES as usize) + 512 * 1024;
    let (port, _hits) = spawn_probe(ProbeReply::OversizedBody { bytes: over });
    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/openapi.json"))
        .send()
        .await
        .expect("the probe answers");
    assert!(
        resp.content_length()
            .is_none_or(|l| l <= EXT_API_SPEC_MAX_BYTES),
        "precondition: the header must not be what trips the cap"
    );
    assert!(
        matches!(
            read_capped_spec_body(resp, "probe").await,
            SpecBody::TooLarge
        ),
        "the streaming total is the bound"
    );
}

/// **FIX 3.** The hook is armed per SIDECAR while the store used to be keyed per
/// PLUGIN, so a manifest with two `http` sidecars had its second lowering silently
/// overwrite the first — and, worse, the plugin-scoped latch then answered "already
/// lowered" for the second sidecar before it ever ran, making the winner a function
/// of health-poll ordering.
///
/// Both halves are asserted, because they fail independently:
///
/// - the LATCH half, end-to-end through `import_openapi_once`: sidecar B must
///   actually go and fetch after sidecar A has finished;
/// - the STORE half: A's rows must still be there once B has stored its own.
///
/// Latent today only because exactly one shipped manifest (`finetune`) declares two
/// sidecars and its second happens to carry no `http` block. That is a coincidence,
/// not a guarantee, and the failure it would produce is invisible.
#[tokio::test]
async fn two_http_sidecars_on_one_plugin_do_not_overwrite_each_other() {
    let (port, hits) = spawn_counting_probe();
    let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());

    let alpha = probe_import_named(&registry, "@ryu/twin", "alpha");
    let beta = probe_import_named(&registry, "@ryu/twin", "beta");
    let (alpha_key, beta_key) = (alpha.sidecar_key.clone(), beta.sidecar_key.clone());
    assert_ne!(alpha_key, beta_key, "the two sidecars must key differently");

    import_openapi_once(alpha, port, Arc::new(AtomicBool::new(false))).await;
    let after_alpha = hits.load(Ordering::SeqCst);
    assert!(after_alpha > 0, "the first sidecar fetched");

    import_openapi_once(beta, port, Arc::new(AtomicBool::new(false))).await;
    assert!(
        hits.load(Ordering::SeqCst) > after_alpha,
        "the SECOND sidecar of the same plugin must still fetch its own document — \
             a plugin-scoped latch would have skipped it forever"
    );
    assert!(registry.has_ext_api_routes_for_sidecar(&alpha_key));
    assert!(registry.has_ext_api_routes_for_sidecar(&beta_key));

    // The store half: two sidecars' rows coexist instead of the later replacing
    // the earlier.
    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin",
        &alpha_key,
        vec![derived_row("ryu_ext.ryu_twin.get_alpha", "@ryu/twin")],
    );
    registry.set_ext_api_routes_for_sidecar(
        "@ryu/twin",
        &beta_key,
        vec![derived_row("ryu_ext.ryu_twin.get_beta", "@ryu/twin")],
    );
    assert!(
        registry
            .describe("ryu_ext.ryu_twin.get_alpha")
            .await
            .is_some(),
        "the first sidecar's rows must survive the second's lowering"
    );
    assert!(registry
        .describe("ryu_ext.ryu_twin.get_beta")
        .await
        .is_some());
}
