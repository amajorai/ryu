use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Read;

const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Read byte-preserving content from the file selected by the trusted host.
pub fn read_binary(path: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("File exceeds the 8 MiB editor limit".to_owned());
    }
    Ok(STANDARD.encode(bytes))
}

/// Validate replacement bytes completely before touching the selected file.
pub fn write_binary(path: &str, blob: &str) -> Result<(), String> {
    if blob.len() > MAX_BYTES * 3 / 2 {
        return Err("File exceeds the 8 MiB editor limit".to_owned());
    }
    let bytes = STANDARD.decode(blob).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("File exceeds the 8 MiB editor limit".to_owned());
    }
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_round_trip_preserves_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("resource.bin");
        let bytes = [0_u8, 255, 128, 254];
        std::fs::write(&path, bytes).unwrap();
        let path = path.to_string_lossy().into_owned();
        assert_eq!(STANDARD.decode(read_binary(&path).unwrap()).unwrap(), bytes);
        let replacement = [255_u8, 0, 254];
        write_binary(&path, &STANDARD.encode(replacement)).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), replacement);
    }

    #[test]
    fn invalid_or_oversized_resource_does_not_replace_the_file() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_string_lossy().into_owned();
        std::fs::write(&path, b"original").unwrap();
        assert!(write_binary(&path, "invalid-base64!").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert!(write_binary(&path, &STANDARD.encode(vec![0_u8; MAX_BYTES + 1])).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        std::fs::write(&path, vec![0_u8; MAX_BYTES + 1]).unwrap();
        assert!(read_binary(&path).is_err());
    }
}
