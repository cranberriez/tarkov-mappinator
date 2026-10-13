//! Small JPEG previews of screenshots, served to the webview through the `thumb` URI scheme.
//!
//! Decoding full-size screenshots per tile is what made the import grid lag, so each one is
//! decoded once and kept under the cache directory, keyed by path, size and modified time.

use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

/// Longest side in pixels; tiles are 58 CSS pixels wide.
const EDGE: u32 = 160;
const QUALITY: u8 = 80;

pub struct ThumbCache {
    root: PathBuf,
}

impl ThumbCache {
    pub fn open(root: PathBuf) -> Self {
        Self { root }
    }

    /// The JPEG preview of `source`, from the cache when the file is unchanged.
    pub fn get(&self, source: &Path) -> Result<Vec<u8>, String> {
        let cached = self.entry(source)?;
        if let Ok(bytes) = fs::read(&cached) {
            return Ok(bytes);
        }
        let bytes = render(source)?;
        // Written aside then renamed, so concurrent misses never leave a half-written entry.
        static TEMP: AtomicU64 = AtomicU64::new(0);
        let temp = cached.with_extension(format!("{}.tmp", TEMP.fetch_add(1, Ordering::Relaxed)));
        let stored = fs::create_dir_all(&self.root)
            .and_then(|_| fs::write(&temp, &bytes))
            .and_then(|_| fs::rename(&temp, &cached));
        if stored.is_err() {
            let _ = fs::remove_file(&temp);
        }
        Ok(bytes)
    }

    /// Drops the cached previews of `sources`; best-effort, unreadable sources are skipped.
    pub fn forget<'a>(&self, sources: impl IntoIterator<Item = &'a Path>) {
        for source in sources {
            let Ok(cached) = self.entry(source) else { continue };
            match fs::remove_file(&cached) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    eprintln!("Unable to remove {}: {error}", cached.display());
                }
                _ => {}
            }
        }
    }

    fn entry(&self, source: &Path) -> Result<PathBuf, String> {
        let meta = fs::metadata(source).map_err(|error| format!("Unable to read {}: {error}", source.display()))?;
        let modified = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0, |at| at.as_nanos());
        Ok(self.root.join(format!("{}.jpg", key(source, meta.len(), modified))))
    }

    pub fn clear(&self) -> Result<(), String> {
        match fs::remove_dir_all(&self.root) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("Unable to clear {}: {error}", self.root.display()))
            }
            _ => Ok(()),
        }
    }
}

fn key(path: &Path, len: u64, modified: u128) -> String {
    let mut hash = Sha256::new();
    hash.update(path.to_string_lossy().as_bytes());
    hash.update([0]);
    hash.update(len.to_le_bytes());
    hash.update(modified.to_le_bytes());
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn render(source: &Path) -> Result<Vec<u8>, String> {
    let image = image::open(source).map_err(|error| format!("Unable to decode {}: {error}", source.display()))?;
    let small = image.thumbnail(EDGE, EDGE).to_rgb8();
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, QUALITY)
        .encode_image(&small)
        .map_err(|error| format!("Unable to encode preview: {error}"))?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_changes_with_path_size_and_time() {
        let base = key(Path::new("a.png"), 10, 5);
        assert_eq!(base, key(Path::new("a.png"), 10, 5));
        assert_ne!(base, key(Path::new("b.png"), 10, 5));
        assert_ne!(base, key(Path::new("a.png"), 11, 5));
        assert_ne!(base, key(Path::new("a.png"), 10, 6));
    }

    #[test]
    fn previews_are_small_jpegs_and_cached() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("shot.png");
        image::RgbImage::from_pixel(640, 360, image::Rgb([200, 60, 20])).save(&source).unwrap();
        let thumbs = dir.path().join("thumbs");
        let cache = ThumbCache::open(thumbs.clone());

        let bytes = cache.get(&source).unwrap();
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (160, 90));
        assert_eq!(fs::read_dir(&thumbs).unwrap().count(), 1);
        assert_eq!(bytes, cache.get(&source).unwrap());

        // A changed file is a new entry, and here no longer an image.
        fs::write(&source, b"changed and no longer an image").unwrap();
        assert!(cache.get(&source).is_err());

        cache.clear().unwrap();
        assert!(!thumbs.exists());
    }

    #[test]
    fn forget_removes_only_cached_previews() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a.png"), dir.path().join("b.png"));
        for path in [&a, &b] {
            image::RgbImage::from_pixel(32, 32, image::Rgb([1, 2, 3])).save(path).unwrap();
        }
        let thumbs = dir.path().join("thumbs");
        let cache = ThumbCache::open(thumbs.clone());
        cache.get(&a).unwrap();
        assert_eq!(fs::read_dir(&thumbs).unwrap().count(), 1);

        // `b` was never cached and `gone` does not exist; neither is an error.
        cache.forget([a.as_path(), b.as_path(), dir.path().join("gone.png").as_path()]);
        assert_eq!(fs::read_dir(&thumbs).unwrap().count(), 0);
        cache.forget([a.as_path()]);
    }

    #[test]
    fn missing_sources_fail() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ThumbCache::open(dir.path().join("t")).get(&dir.path().join("none.png")).is_err());
    }
}
