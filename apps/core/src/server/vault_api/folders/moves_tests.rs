use super::*;
use crate::server::vault_api::tests::{caller, ctx, node, parts};

async fn put(ctx: &Ctx, name: &str, body: Value) {
    let (status, text) = parts(put_secret_with(ctx, name, body).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
}

fn folder_move(body: Value) -> FolderMoveBody {
    serde_json::from_value(body).unwrap()
}

fn secret_move(body: Value) -> SecretMoveBody {
    serde_json::from_value(body).unwrap()
}

fn member() -> Ctx {
    ctx(
        Some(node(NodeScope::Org, None, None)),
        Some(caller("user-1", OrgRole::Member, &[])),
        false,
        Vec::new(),
    )
}

#[tokio::test]
async fn an_admin_renames_a_folder_and_a_member_cannot() {
    let ctx = ctx(None, None, true, Vec::new());
    put(&ctx, "TOKEN", json!({ "value": "t", "path": "/app" })).await;
    put(&ctx, "DB_URL", json!({ "value": "d", "path": "/app/db" })).await;
    let rename = || {
        folder_move(json!({
            "environment": "default", "path": "/app", "toPath": "/svc"
        }))
    };

    let mut outsider = member();
    outsider.store = ctx.store;
    let (status, _) = parts(move_folder_with(&outsider, rename()).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = parts(move_folder_with(&ctx, rename()).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("\"values\":2"), "{body}");
    let moved = SecretCoords {
        path: "/svc/db".into(),
        ..SecretCoords::root(SecretScope::User, "local", None, "DB_URL")
    };
    assert_eq!(
        ctx.store.reveal(&moved, None, &ctx.actor()).await.unwrap(),
        "d"
    );

    let root = folder_move(json!({ "environment": "default", "path": "/", "toPath": "/x" }));
    let (status, _) = parts(move_folder_with(&ctx, root).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_member_moves_and_renames_their_own_value_but_not_onto_another() {
    let ctx = member();
    put(&ctx, "OLD", json!({ "value": "v" })).await;
    put(&ctx, "BUSY", json!({ "value": "w", "path": "/x" })).await;
    let rename = secret_move(json!({ "toPath": "/x", "toName": "NEW" }));
    let (status, body) = parts(move_secret_with(&ctx, "OLD", rename).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("\"name\":\"NEW\""), "{body}");

    let onto = secret_move(json!({ "path": "/x", "toName": "BUSY" }));
    let (status, _) = parts(move_secret_with(&ctx, "NEW", onto).await).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A node value needs a manager.
    let node_value = secret_move(json!({ "scope": "node", "scopeId": "node-1", "toPath": "/y" }));
    let (status, _) = parts(move_secret_with(&ctx, "NEW", node_value).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
