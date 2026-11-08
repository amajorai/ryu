use serde_json::{json, Value};
use tracing::debug;

use super::ComposioClient;
use crate::error::GatewayError;

/// Largest file a caller may declare for one staged upload slot.
pub const FILE_UPLOAD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// A validated `file_upload` operation: which tool the file belongs to and the
/// facts Composio needs to stage it. Every field is checked here so a malformed
/// app request never reaches the provider.
struct FileUploadRequest {
    toolkit_slug: String,
    tool_slug: String,
    filename: String,
    mimetype: String,
    md5: String,
    /// The caller's declared size. Composio's slot request carries no size, so
    /// this is not forwarded; it bounds what a caller may ask to stage.
    size: u64,
}

impl FileUploadRequest {
    const MAX_UPLOAD_BYTES: u64 = FILE_UPLOAD_MAX_BYTES;
    const MAX_FILENAME_CHARS: usize = 255;
    const MAX_MIMETYPE_BYTES: usize = 127;
    const MAX_SLUG_BYTES: usize = 128;

    fn parse(tool_slug: &str, file: &Value) -> Result<Self, GatewayError> {
        let bad = |why: &str| GatewayError::BadRequest(format!("invalid file upload: {why}"));
        let tool_slug = tool_slug.trim();
        if tool_slug.is_empty()
            || tool_slug.len() > Self::MAX_SLUG_BYTES
            || !tool_slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(bad("tool slug must be letters, digits and underscores"));
        }
        let field = |name: &str| file.get(name).and_then(Value::as_str).map(str::trim);
        let toolkit_slug = field("toolkitSlug")
            .filter(|slug| {
                !slug.is_empty()
                    && slug.len() <= Self::MAX_SLUG_BYTES
                    && slug
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
            .ok_or_else(|| bad("toolkitSlug is missing or malformed"))?;
        let filename = field("filename")
            .filter(|name| {
                !name.is_empty()
                    && name.chars().count() <= Self::MAX_FILENAME_CHARS
                    && !name.contains(['/', '\\'])
                    && !name.chars().any(char::is_control)
            })
            .ok_or_else(|| bad("filename is missing, too long or contains a path"))?;
        let mimetype = field("mimetype")
            .filter(|mime| {
                mime.len() <= Self::MAX_MIMETYPE_BYTES
                    && mime.split_once('/').is_some_and(|(kind, sub)| {
                        let token = |part: &str| {
                            !part.is_empty()
                                && part.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric()
                                        || matches!(byte, b'.' | b'+' | b'-' | b'_')
                                })
                        };
                        token(kind) && token(sub)
                    })
            })
            .ok_or_else(|| bad("mimetype must look like type/subtype"))?;
        let md5 = field("md5")
            .filter(|digest| digest.len() == 32 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| bad("md5 must be 32 hex characters"))?;
        let size = file
            .get("size")
            .and_then(Value::as_u64)
            .filter(|size| *size > 0)
            .ok_or_else(|| bad("size must be a positive byte count"))?;
        if size > Self::MAX_UPLOAD_BYTES {
            return Err(bad(&format!(
                "size {size} exceeds the {} byte staging limit",
                Self::MAX_UPLOAD_BYTES
            )));
        }
        Ok(Self {
            toolkit_slug: toolkit_slug.to_ascii_lowercase(),
            tool_slug: tool_slug.to_owned(),
            filename: filename.to_owned(),
            mimetype: mimetype.to_ascii_lowercase(),
            md5: md5.to_ascii_lowercase(),
            size,
        })
    }
}

/// Reduce Composio's upload-request response to the slot a caller needs. The
/// presigned URL must be HTTPS: a plain-HTTP write target would expose the
/// media in transit, so it is refused rather than passed on.
fn file_upload_slot(response: &Value) -> Result<Value, GatewayError> {
    let key = response
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::ProviderError("Composio file upload returned no storage key".to_owned())
        })?;
    let upload_url = response
        .get("new_presigned_url")
        .or_else(|| response.get("newPresignedUrl"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GatewayError::ProviderError("Composio file upload returned no upload URL".to_owned())
        })?;
    let parsed = reqwest::Url::parse(upload_url).map_err(|_| {
        GatewayError::ProviderError("Composio file upload returned a malformed URL".to_owned())
    })?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(GatewayError::ProviderError(
            "Composio file upload returned a non-HTTPS upload URL".to_owned(),
        ));
    }
    let storage_backend = response
        .pointer("/metadata/storage_backend")
        .and_then(Value::as_str)
        .unwrap_or("s3");
    Ok(json!({
        "key": key,
        "uploadUrl": upload_url,
        "storageBackend": storage_backend,
    }))
}

impl ComposioClient {
    /// Reserve a staged upload slot for one file a Composio tool will consume.
    ///
    /// Composio's file parameters (`file_uploadable` in its tool schemas) take
    /// `{ name, mimetype, s3key }`, where the key comes from
    /// `POST /files/upload/request` and the bytes go to the presigned URL it
    /// returns. Only this request needs the project key; the presigned URL is a
    /// short-lived, single-object write grant, so a caller can stream the bytes
    /// itself without ever holding the Composio credential.
    ///
    /// The returned value carries just the key, the upload URL and the storage
    /// backend, never the raw upstream envelope.
    pub async fn request_file_upload(
        &self,
        tool_slug: &str,
        file: &Value,
    ) -> Result<Value, GatewayError> {
        let request = FileUploadRequest::parse(tool_slug, file)?;
        debug!(
            tool = %request.tool_slug,
            declared_bytes = request.size,
            "requesting a Composio staged upload slot"
        );
        let response = self
            .request_json(
                reqwest::Method::POST,
                "/files/upload/request",
                Some(json!({
                    "toolkit_slug": request.toolkit_slug,
                    "tool_slug": request.tool_slug,
                    "filename": request.filename,
                    "mimetype": request.mimetype,
                    "md5": request.md5,
                })),
            )
            .await?;
        file_upload_slot(&response)
    }
}

#[cfg(test)]
#[path = "file_upload_tests.rs"]
mod tests;
