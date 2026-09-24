use super::prepare_directory;
use crate::util::stat_file;
use serde_json::json;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "termina-prepare-sync-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn request(&self) -> serde_json::Value {
        let metadata = fs::metadata(&self.0).unwrap();
        json!({"root": self.0,
            "rootIdentity": {"dev": metadata.dev().to_string(), "ino": metadata.ino().to_string()},
            "components": ["a", "b", "c"], "createMissing": true,
            "expectedMissingAt": 0, "expectedChain": [],
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn prepare_syncs_every_child_and_parent_before_returning_capability() {
    let fixture = Fixture::new();
    let mut synced = Vec::new();
    let response = prepare_directory(&fixture.request(), |directory| {
        synced.push(stat_file(directory).unwrap().ino);
        directory.sync_all()
    })
    .unwrap();
    let expected: Vec<_> = ["a", "", "a/b", "a", "a/b/c", "a/b"]
        .iter()
        .map(|path| fs::metadata(fixture.0.join(path)).unwrap().ino())
        .collect();
    assert_eq!(synced, expected);
    assert!(response["result"]["identity"]["capability"].is_string());
    assert_eq!(response["result"]["chain"].as_array().unwrap().len(), 3);
    // Expected-missing checks remain strict after publication.
    assert!(
        prepare_directory(&fixture.request(), fs::File::sync_all)
            .unwrap_err()
            .contains("expected to be missing")
    );
}

#[test]
fn prepare_propagates_each_child_or_parent_sync_failure_without_advancing() {
    for failure in 0..6 {
        let fixture = Fixture::new();
        let mut calls = 0;
        let error = prepare_directory(&fixture.request(), |_| {
            let current = calls;
            calls += 1;
            if current == failure {
                Err(std::io::Error::other("injected sync failure"))
            } else {
                Ok(())
            }
        })
        .expect_err("sync failure must prevent a capability result");
        assert!(error.contains("injected sync failure"), "{error}");
        assert_eq!(calls, failure + 1);
        let created_depth = failure / 2 + 1;
        for (depth, path) in ["a", "a/b", "a/b/c"].iter().enumerate() {
            assert_eq!(fixture.0.join(path).exists(), depth < created_depth);
        }
    }
}
