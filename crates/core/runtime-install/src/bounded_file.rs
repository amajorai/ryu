//! Limit metadata allocation before parsing, including concurrent file growth.
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

pub fn read(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let maximum = limit
        .checked_add(1)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid metadata byte limit")
        })?;
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "metadata is not a regular file within its byte limit",
        ));
    }
    let mut bytes = Vec::new();
    file.take(maximum).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "metadata grew beyond its byte limit",
        ));
    }
    Ok(bytes)
}

pub fn read_optional(path: &Path, limit: usize) -> io::Result<Option<Vec<u8>>> {
    match read(path, limit) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_exact_limit_and_rejects_oversized_sparse_metadata() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("metadata.json");
        std::fs::write(&path, "1234").unwrap();
        assert_eq!(read(&path, 4).unwrap(), b"1234");
        assert_eq!(
            read(&path, 3).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let oversized = File::options().write(true).open(&path).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::{Ioctl::FSCTL_SET_SPARSE, IO::DeviceIoControl};
            let mut returned = 0;
            assert_ne!(
                unsafe {
                    DeviceIoControl(
                        oversized.as_raw_handle() as _,
                        FSCTL_SET_SPARSE,
                        std::ptr::null(),
                        0,
                        std::ptr::null_mut(),
                        0,
                        &mut returned,
                        std::ptr::null_mut(),
                    )
                },
                0,
                "cannot mark the Windows metadata fixture sparse: {}",
                io::Error::last_os_error()
            );
        }
        oversized.set_len(1024 * 1024 * 1024).unwrap();
        assert_eq!(
            read(&path, 65536).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
