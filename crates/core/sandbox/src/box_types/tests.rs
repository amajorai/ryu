use super::*;

use serde_json::json;

#[test]
fn box_types_size_serde_is_the_wire_name() {
    for (size, name) in [
        (BoxSize::Small, "small"),
        (BoxSize::Default, "default"),
        (BoxSize::Large, "large"),
    ] {
        assert_eq!(serde_json::to_value(size).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<BoxSize>(json!(name)).unwrap(),
            size
        );
        assert_eq!(name.parse::<BoxSize>().unwrap(), size);
        assert_eq!(size.to_string(), name);
    }
    assert!(serde_json::from_value::<BoxSize>(json!("huge")).is_err());
    assert!("cpx22".parse::<BoxSize>().is_err());
    assert_eq!(BoxSize::default(), BoxSize::Small);
}

#[test]
fn box_types_spec_for_matches_the_box_service_size_limits() {
    let shapes: Vec<_> = BoxSize::ALL
        .iter()
        .map(|size| {
            let spec = spec_for(*size);
            assert_eq!(spec.gpu, GpuKind::None);
            assert_eq!(spec.gpu_count, 0);
            assert_eq!(spec.os, OsKind::Linux);
            (spec.vcpu, spec.mem_gib, spec.storage_gib)
        })
        .collect();
    assert_eq!(shapes, vec![(2, 4, 40), (4, 8, 80), (8, 16, 100)]);
    let units: Vec<_> = BoxSize::ALL
        .iter()
        .map(|size| size.resource_units())
        .collect();
    assert_eq!(units, vec![1, 2, 4]);
}

#[test]
fn box_types_park_reason_and_status_serde() {
    for (reason, name) in [
        (ParkReason::User, "user"),
        (ParkReason::Idle, "idle"),
        (ParkReason::Balance, "balance"),
        (ParkReason::Budget, "budget"),
        (ParkReason::Liveness, "liveness"),
        (ParkReason::Suspended, "suspended"),
        (ParkReason::Ttl, "ttl"),
    ] {
        assert_eq!(serde_json::to_value(reason).unwrap(), json!(name));
        assert_eq!(reason.as_str(), name);
    }
    assert_eq!(
        serde_json::from_value::<BoxStatus>(json!("stopping")).unwrap(),
        BoxStatus::Stopping
    );
    assert_eq!(
        serde_json::from_value::<BoxStatus>(json!("hibernating")).unwrap(),
        BoxStatus::Unknown
    );
    assert!(BoxStatus::Ready.is_live() && !BoxStatus::Stopping.is_live());
    assert!(BoxStatus::Stopped.is_settled() && !BoxStatus::Stopping.is_settled());
}

#[test]
fn box_types_wire_shapes_are_camel_case_and_redact_secrets() {
    let request = DesktopTokenRequest {
        origin: "https://app.ryu.dev".to_owned(),
        sub: "user_1".to_owned(),
        view_only: true,
    };
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({ "scope": "desktop", "origin": "https://app.ryu.dev", "sub": "user_1", "viewOnly": true })
    );
    let credential = SessionCredential {
        gateway_url: "https://gw.ryu.dev".to_owned(),
        key: SecretString::new("gwb1.abc.def"),
        expires_at: "2026-10-19T00:20:00Z".to_owned(),
    };
    assert_eq!(
        serde_json::to_value(&credential).unwrap(),
        json!({ "gatewayUrl": "https://gw.ryu.dev", "key": "gwb1.abc.def", "expiresAt": "2026-10-19T00:20:00Z" })
    );
    let debug = format!("{credential:?}");
    assert!(!debug.contains("gwb1.abc.def"), "{debug}");
    assert_eq!(credential.key.to_string(), "<redacted>");
    assert_eq!(
        serde_json::to_value(KeepaliveRequest {
            tick_index: 3,
            accrued_micro_usd: 1200
        })
        .unwrap(),
        json!({ "tickIndex": 3, "accruedMicroUsd": 1200 })
    );

    let grant: DesktopGrant = serde_json::from_value(json!({
        "mode": "direct",
        "url": "wss://box.ryu.dev/v1/boxes/bx_1/desktop/ws",
        "protocols": ["ryu.box.v1", "ryu.token.t"],
        "expiresAt": "2026-10-19T00:00:30Z",
    }))
    .unwrap();
    assert_eq!(grant.mode, StreamMode::Direct);
    assert_eq!(grant.path, None);
    let relay = DesktopGrant {
        mode: StreamMode::Relay,
        url: None,
        protocols: vec![],
        path: Some("/api/session-boxes/c1/screen/ws".to_owned()),
        expires_at: "2026-10-19T00:00:30Z".to_owned(),
    };
    assert_eq!(
        serde_json::to_value(&relay).unwrap(),
        json!({ "mode": "relay", "protocols": [], "path": "/api/session-boxes/c1/screen/ws", "expiresAt": "2026-10-19T00:00:30Z" })
    );

    let token: DesktopTokenResponse = serde_json::from_value(json!({
        "token": "t", "expiresAt": "2026-10-19T00:00:30Z", "protocols": ["ryu.box.v1", "ryu.token.t"]
    }))
    .unwrap();
    assert_eq!(token.url, None);
    assert!(!format!("{token:?}").contains("\"t\""));
}

#[test]
fn box_types_box_view_reads_public_box_with_and_without_new_fields() {
    let old = json!({
        "allowedHosts": [], "createdAt": "x", "driver": "docker", "envNames": [],
        "id": "bx_1", "image": "ubuntu:24.04", "lastError": null, "name": "box",
        "network": "none", "repo": null, "secrets": [], "size": "default",
        "snapshotId": null, "status": "ready", "stoppedAt": null, "ttlSeconds": 60,
        "updatedAt": "x"
    });
    let view: BoxView = serde_json::from_value(old).unwrap();
    assert_eq!(view.status, BoxStatus::Ready);
    assert_eq!(view.size, BoxSize::Default);
    assert!(view.placement.is_none() && view.desktop.is_none() && view.running_since.is_none());
    assert!(view.billing.is_none() && !view.minimum_waived());

    let new = json!({
        "id": "bx_2", "status": "stopping", "size": "large",
        "placement": { "provider": "hetzner", "location": "hel1", "tier": "hetzner", "serverType": "cx43", "isolation": "vm" },
        "desktop": { "ready": true, "viewers": 2, "width": 1280, "height": 800 },
        "runningSince": "2026-10-19T00:00:00Z"
    });
    let view: BoxView = serde_json::from_value(new).unwrap();
    assert_eq!(view.status, BoxStatus::Stopping);
    assert_eq!(view.desktop.unwrap().viewers, 2);
    assert_eq!(view.placement.unwrap()["serverType"], "cx43");

    let waived: BoxView = serde_json::from_value(json!({
        "id": "bx_3", "status": "ready", "size": "small",
        "billing": { "minimumWaived": true, "paidHourEndsAt": "2026-10-20T11:00:00.000Z" }
    }))
    .unwrap();
    assert!(waived.minimum_waived());
    // Waived but unsigned: nothing the Gateway would honour.
    assert_eq!(waived.minimum_waiver(), None);
    assert_eq!(
        waived.billing.unwrap().paid_hour_ends_at.as_deref(),
        Some("2026-10-20T11:00:00.000Z")
    );
    let signed: BoxView = serde_json::from_value(json!({
        "id": "bx_5", "status": "ready", "size": "small",
        "billing": {
            "minimumWaived": true,
            "paidHourEndsAt": "2026-10-20T11:00:00.000Z",
            "waiver": "bw1.payload.signature"
        }
    }))
    .unwrap();
    assert_eq!(
        signed.minimum_waiver().as_deref(),
        Some("bw1.payload.signature")
    );
    // A waiver on a start that was not waived is never forwarded.
    let stray: BoxView = serde_json::from_value(json!({
        "id": "bx_6", "status": "ready", "size": "small",
        "billing": { "minimumWaived": false, "paidHourEndsAt": null, "waiver": "bw1.a.b" }
    }))
    .unwrap();
    assert_eq!(stray.minimum_waiver(), None);
    let charged: BoxView = serde_json::from_value(json!({
        "id": "bx_4", "status": "ready", "size": "small",
        "billing": { "minimumWaived": false, "paidHourEndsAt": null }
    }))
    .unwrap();
    assert!(!charged.minimum_waived());

    let limits: BoxLimits = serde_json::from_value(json!({
        "running": 1, "maxRunning": 3, "stored": 2, "maxStored": 20,
        "resourceUnits": 2, "maxResourceUnits": 6
    }))
    .unwrap();
    assert_eq!(limits.max_running, 3);
    assert_eq!(limits.max_stored, 20);
}
