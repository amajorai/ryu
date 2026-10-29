use super::*;

/// A stub backend answering with a fixed sentinel response — proof the registry
/// dispatches to a swapped-in impl.
struct StubPassthrough;
#[async_trait::async_trait]
impl PassthroughBackend for StubPassthrough {
    async fn forward(
        &self,
        _format: WireFormat,
        _upstream_base: String,
        _route: PassthroughRoute,
        _state: SharedState,
        _peer: SocketAddr,
        _path: String,
        _method: Method,
        _headers: HeaderMap,
        _raw_query: axum::extract::RawQuery,
        _body: Bytes,
    ) -> Response {
        (StatusCode::IM_A_TEAPOT, "stub").into_response()
    }
}

#[test]
fn builtin_is_the_default_active_backend() {
    let reg = PassthroughRegistry::new();
    assert_eq!(reg.active_id(), PassthroughRegistry::BUILTIN);
    assert_eq!(
        reg.available(),
        vec![PassthroughRegistry::BUILTIN.to_string()]
    );
}

#[test]
fn register_then_set_active_swaps_the_live_backend() {
    let reg = PassthroughRegistry::new();
    reg.register(
        "stub",
        std::sync::Arc::new(StubPassthrough) as std::sync::Arc<dyn PassthroughBackend>,
    );
    // Registered but not active: built-in is still the active id.
    assert_eq!(reg.active_id(), PassthroughRegistry::BUILTIN);
    assert_eq!(reg.available().len(), 2);

    assert!(reg.set_active("stub"));
    assert_eq!(reg.active_id(), "stub");

    // Unknown id is a no-op keeping the current active backend.
    assert!(!reg.set_active("nope"));
    assert_eq!(reg.active_id(), "stub");
}
