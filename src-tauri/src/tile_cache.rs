//! Disk cache for tarkov.dev Leaflet map tiles, served to the webview through the `tiles` URI scheme.
//!
//! Tiles are fetched from `TILE_HOST` on first request and kept under the cache directory with the
//! same relative path. Tiles the host does not have (outside a map's art) are remembered with a
//! `.missing` marker so they are not requested again.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use ts_rs::TS;

pub const TILE_HOST: &str = env!("TARKOV_TILE_HOST");
/// Item icons share the cache under `items/<id>-512.webp`; the host serves them from its root.
const ASSET_HOST: &str = env!("TARKOV_ASSET_HOST");
const TILE_LIMIT: u64 = 8 * 1024 * 1024;
const PREFETCH_WORKERS: usize = 6;

pub enum Tile {
    Hit(Vec<u8>),
    Missing,
}

/// One tile set at one zoom: `template` with `{z}`, `{x}`, `{y}`, over an inclusive index range.
#[derive(Clone, Debug, Deserialize, TS)]
pub struct TileJob {
    pub template: String,
    pub z: u32,
    pub x0: u32,
    pub x1: u32,
    pub y0: u32,
    pub y1: u32,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, TS)]
pub struct PrefetchStatus {
    pub running: bool,
    /// What the current or last download was for, as given by the caller.
    pub label: Option<String>,
    #[ts(type = "number")]
    pub total: u64,
    /// Tiles handled so far, including ones already cached.
    #[ts(type = "number")]
    pub done: u64,
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number")]
    pub failed: u64,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, TS)]
pub struct CacheStats {
    #[ts(type = "number")]
    pub files: u64,
    #[ts(type = "number")]
    pub bytes: u64,
}

pub struct TileCache {
    root: PathBuf,
    agent: ureq::Agent,
    prefetch: Mutex<PrefetchStatus>,
    cancel: AtomicBool,
}

/// Relative tile paths only: plain segments, image extension, no traversal.
pub fn valid_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    segments.iter().all(|segment| {
        !segment.is_empty()
            && *segment != "."
            && *segment != ".."
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    }) && [".png", ".jpg", ".webp"]
        .iter()
        .any(|extension| path.ends_with(extension))
}

pub fn expand(template: &str, z: u32, x: u32, y: u32) -> String {
    template
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string())
}

fn missing_marker(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(".missing");
    PathBuf::from(name)
}

impl TileCache {
    pub fn open(root: PathBuf) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .user_agent(concat!("tarkov-mappinator/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self {
            root,
            agent,
            prefetch: Mutex::default(),
            cancel: AtomicBool::new(false),
        }
    }

    fn file(&self, path: &str) -> Result<PathBuf, String> {
        if !valid_path(path) {
            return Err(format!("Invalid tile path \"{path}\"."));
        }
        Ok(self.root.join(path))
    }

    /// True when the tile, or the knowledge that it does not exist, is on disk.
    pub fn has(&self, path: &str) -> bool {
        self.file(path)
            .is_ok_and(|file| file.exists() || missing_marker(&file).exists())
    }

    /// The tile from disk, else from the host (then cached).
    pub fn get(&self, path: &str) -> Result<Tile, String> {
        let file = self.file(path)?;
        if let Ok(bytes) = fs::read(&file) {
            return Ok(Tile::Hit(bytes));
        }
        if missing_marker(&file).exists() {
            return Ok(Tile::Missing);
        }
        self.fetch(path, &file)
    }

    fn fetch(&self, path: &str, file: &Path) -> Result<Tile, String> {
        let url = match path.strip_prefix("items/") {
            Some(icon) => format!("{ASSET_HOST}{icon}"),
            None => format!("{TILE_HOST}{path}"),
        };
        let mut response = self
            .agent
            .get(&url)
            .call()
            .map_err(|error| format!("{url}: {error}"))?;
        let status = response.status().as_u16();
        let io = |error: std::io::Error| format!("Unable to cache {path}: {error}");
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        match status {
            200 => {
                let bytes = response
                    .body_mut()
                    .with_config()
                    .limit(TILE_LIMIT)
                    .read_to_vec()
                    .map_err(|error| format!("{url}: {error}"))?;
                // Write beside, then rename, so a concurrent reader never sees a partial tile.
                let mut partial = file.as_os_str().to_os_string();
                partial.push(format!(".{}.part", std::process::id()));
                let partial = PathBuf::from(partial);
                fs::write(&partial, &bytes).map_err(io)?;
                if fs::rename(&partial, file).is_err() {
                    let _ = fs::remove_file(&partial);
                }
                Ok(Tile::Hit(bytes))
            }
            // The tile host answers 404 (and sometimes 403) for tiles outside a map's art.
            403 | 404 => {
                fs::write(missing_marker(file), b"").map_err(io)?;
                Ok(Tile::Missing)
            }
            _ => Err(format!("{url}: HTTP {status}")),
        }
    }

    /// How many tiles of `jobs` are already cached (present or known missing).
    pub fn coverage(&self, jobs: &[TileJob]) -> u64 {
        paths(jobs).filter(|path| self.has(path)).count() as u64
    }

    pub fn prefetch_status(&self) -> PrefetchStatus {
        self.prefetch
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    pub fn cancel_prefetch(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Downloads every tile of `jobs` not yet cached. Returns false when a download is already running.
    pub fn prefetch(
        self: &Arc<Self>,
        label: String,
        jobs: Vec<TileJob>,
        publish: impl Fn(&PrefetchStatus) + Send + Sync,
    ) -> bool {
        {
            let mut status = self
                .prefetch
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if status.running {
                return false;
            }
            *status = PrefetchStatus {
                running: true,
                label: Some(label),
                total: paths(&jobs).count() as u64,
                ..Default::default()
            };
            publish(&status);
        }
        self.cancel.store(false, Ordering::SeqCst);
        let queue = Mutex::new(paths(&jobs));
        let last_publish = Mutex::new(Instant::now());
        std::thread::scope(|scope| {
            for _ in 0..PREFETCH_WORKERS {
                scope.spawn(|| loop {
                    if self.cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    let Some(path) = queue.lock().ok().and_then(|mut queue| queue.next()) else {
                        break;
                    };
                    let fetched = !self.has(&path);
                    let result = if fetched {
                        self.get(&path).map(|_| ())
                    } else {
                        Ok(())
                    };
                    let mut status = self
                        .prefetch
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    status.done += 1;
                    match result {
                        Ok(()) if fetched => status.downloaded += 1,
                        Ok(()) => {}
                        Err(_) => status.failed += 1,
                    }
                    let mut last = last_publish
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if last.elapsed() >= Duration::from_millis(250) {
                        *last = Instant::now();
                        publish(&status);
                    }
                });
            }
        });
        let mut status = self
            .prefetch
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.running = false;
        status.cancelled = self.cancel.load(Ordering::SeqCst);
        publish(&status);
        true
    }

    pub fn stats(&self) -> CacheStats {
        fn walk(dir: &Path, stats: &mut CacheStats) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                match entry.metadata() {
                    Ok(meta) if meta.is_dir() => walk(&entry.path(), stats),
                    Ok(meta) => {
                        stats.files += 1;
                        stats.bytes += meta.len();
                    }
                    Err(_) => {}
                }
            }
        }
        let mut stats = CacheStats::default();
        walk(&self.root, &mut stats);
        stats
    }

    pub fn clear(&self) -> Result<(), String> {
        if self.prefetch_status().running {
            return Err("Stop the tile download first.".into());
        }
        match fs::remove_dir_all(&self.root) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("Unable to clear {}: {error}", self.root.display()))
            }
            _ => Ok(()),
        }
    }
}

fn paths(jobs: &[TileJob]) -> impl Iterator<Item = String> + '_ {
    jobs.iter().flat_map(|job| {
        (job.y0..=job.y1)
            .flat_map(move |y| (job.x0..=job.x1).map(move |x| expand(&job.template, job.z, x, y)))
    })
}

pub fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("jpg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_relative_image_paths_are_valid() {
        assert!(valid_path("customs_0.16/main/6/40/20.png"));
        assert!(!valid_path("../secrets/6/40/20.png"));
        assert!(!valid_path("customs/./6/40/20.png"));
        assert!(!valid_path("/customs/6/40/20.png"));
        assert!(!valid_path("customs\\6\\40\\20.png"));
        assert!(!valid_path("customs/6/40/20.json"));
        assert!(!valid_path("customs//20.png"));
    }

    #[test]
    fn item_icon_paths_are_valid() {
        assert!(valid_path("items/6a31807f17005505b70d5827-512.webp"));
    }

    #[test]
    fn jobs_expand_to_inclusive_ranges() {
        let job = TileJob {
            template: "m/{z}/{x}/{y}.png".into(),
            z: 2,
            x0: 1,
            x1: 2,
            y0: 3,
            y1: 3,
        };
        assert_eq!(
            paths(&[job]).collect::<Vec<_>>(),
            vec!["m/2/1/3.png", "m/2/2/3.png"]
        );
    }

    #[test]
    fn cached_and_missing_tiles_are_served_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let cache = TileCache::open(dir.path().to_path_buf());
        let file = dir.path().join("m/0/0/0.png");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"png").unwrap();
        let missing = dir.path().join("m/0/1/0.png");
        fs::create_dir_all(missing.parent().unwrap()).unwrap();
        fs::write(missing_marker(&missing), b"").unwrap();
        assert!(matches!(cache.get("m/0/0/0.png"), Ok(Tile::Hit(bytes)) if bytes == b"png"));
        assert!(matches!(cache.get("m/0/1/0.png"), Ok(Tile::Missing)));
        assert!(cache.get("../m/0/0/0.png").is_err());
        let jobs = [TileJob {
            template: "m/{z}/{x}/{y}.png".into(),
            z: 0,
            x0: 0,
            x1: 1,
            y0: 0,
            y1: 0,
        }];
        assert_eq!(cache.coverage(&jobs), 2);
        assert_eq!(cache.stats(), CacheStats { files: 2, bytes: 3 });
        cache.clear().unwrap();
        assert_eq!(cache.coverage(&jobs), 0);
    }

    /// Network: `cargo test live_tiles -- --ignored`.
    #[test]
    #[ignore]
    fn live_tiles() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(TileCache::open(dir.path().to_path_buf()));
        assert!(
            matches!(cache.get("customs_0.16/main/0/0/0.png"), Ok(Tile::Hit(bytes)) if bytes.starts_with(b"\x89PNG"))
        );
        assert!(matches!(
            cache.get("customs_0.16/main/0/1/0.png"),
            Ok(Tile::Missing)
        ));
        let jobs = vec![TileJob {
            template: "customs_0.16/main/{z}/{x}/{y}.png".into(),
            z: 2,
            x0: 0,
            x1: 3,
            y0: 0,
            y1: 3,
        }];
        assert!(cache.prefetch("customs".into(), jobs.clone(), |_| {}));
        let status = cache.prefetch_status();
        assert_eq!(
            (status.total, status.done, status.failed, status.running),
            (16, 16, 0, false)
        );
        assert_eq!(cache.coverage(&jobs), 16);
    }

    #[test]
    fn export_frontend_contract() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings");
        TileJob::export_all_to(dir).unwrap();
        PrefetchStatus::export_all_to(dir).unwrap();
        CacheStats::export_all_to(dir).unwrap();
    }
}
