//! #166 (P1): deep incremental deletions must not retain deleted files.
//! Adapts the issue's inline repro: baseline capture, delete `a/b/...`,
//! incremental capture with watcher hints, then full capture. Asserts path
//! absence plus incremental/full tree equality, with root/one-level
//! controls, transitions, mixed hints, repeated requests, and restart.

mod common;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use common::{CoreProcess, TempFixture};

const DEADLINE: Duration = Duration::from_secs(10);

fn git_env(home: &Path, tmp: &Path) -> Vec<(String, String)> {
    vec![
        ("PATH".to_string(), "/usr/bin:/bin:/usr/sbin:/sbin".to_string()),
        ("HOME".to_string(), home.to_str().unwrap().to_string()),
        ("TMPDIR".to_string(), tmp.to_str().unwrap().to_string()),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("LANG".to_string(), "C".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ]
}

fn git_init_and_add(source: &Path, home: &Path, tmp: &Path) {
    let env = git_env(home, tmp);
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .arg(source)
        .envs(env.iter().cloned())
        .status()
        .expect("run git init");
    assert!(status.success(), "git init failed");
    let status = Command::new("git")
        .args(["-C"])
        .arg(source)
        .args(["add", "--all"])
        .envs(git_env(home, tmp))
        .status()
        .expect("run git add");
    assert!(status.success(), "git add failed");
}

struct CaptureHarness {
    fixture: TempFixture,
    home: PathBuf,
    source: PathBuf,
    base: Value,
    core: CoreProcess,
}

impl CaptureHarness {
    fn with_files(prefix: &str, files: &[(&str, &str)]) -> Self {
        let fixture = TempFixture::new(prefix);
        let home = fixture.join("home");
        fs::create_dir_all(&home).expect("create home");
        let source = fixture.join("source");
        fs::create_dir_all(&source).expect("create source");
        for (rel, content) in files {
            let path = source.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create source parent");
            }
            fs::write(&path, content).expect("write source file");
        }
        git_init_and_add(&source, &home, fixture.path());
        let mut core = CoreProcess::spawn(&home, fixture.path());
        let store_dir = fixture.join("store");
        let created = core
            .request_ok(
                "store-create",
                json!({
                    "storeDir": store_dir.to_str().unwrap(),
                    "sourceGitDir": source.join(".git").to_str().unwrap(),
                    "objectFormat": "sha1",
                }),
                DEADLINE,
            )
            .expect("store-create");
        let mut base = json!({
            "storeDir": store_dir.to_str().unwrap(),
            "sourceRoot": source.to_str().unwrap(),
            "sourceGitDir": source.join(".git").to_str().unwrap(),
            "objectFormat": "sha1",
        });
        for (key, value) in created.as_object().expect("store-create object") {
            if key.starts_with("store") {
                base[key] = value.clone();
            }
        }
        Self {
            fixture,
            home,
            source,
            base,
            core,
        }
    }

    fn payload(&self, extra: Value) -> Value {
        let mut merged = self.base.as_object().cloned().expect("base object");
        for (key, value) in extra.as_object().expect("extra object") {
            merged.insert(key.clone(), value.clone());
        }
        Value::Object(merged)
    }

    fn capture(&mut self, parent: Option<&str>) -> Value {
        self.core
            .request_ok(
                "capture",
                self.payload(json!({
                    "head": Value::Null,
                    "parentCommit": parent,
                })),
                DEADLINE,
            )
            .expect("full capture")
            .get("state")
            .cloned()
            .expect("capture state")
    }

    fn incremental(&mut self, parent: &str, hints: &[&str]) -> Value {
        self.core
            .request_ok(
                "capture-incremental",
                self.payload(json!({
                    "parentCommit": parent,
                    "hints": hints,
                    "reconcile": [],
                })),
                DEADLINE,
            )
            .expect("incremental capture")
            .get("state")
            .cloned()
            .expect("incremental state")
    }

    fn incremental_err(&mut self, parent: &str, hints: &[&str]) -> String {
        let response = self
            .core
            .request(
                "capture-incremental",
                self.payload(json!({
                    "parentCommit": parent,
                    "hints": hints,
                    "reconcile": [],
                })),
                DEADLINE,
            )
            .expect("incremental capture response");
        assert_eq!(
            response.get("ok").and_then(Value::as_bool),
            Some(false),
            "directory hint must fail capture loudly: {response}"
        );
        response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("failed capture is missing error: {response}"))
            .to_string()
    }

    fn paths(&mut self, commit: &str) -> HashSet<String> {
        self.core
            .request_ok(
                "tree-paths",
                self.payload(json!({ "stateId": commit })),
                DEADLINE,
            )
            .expect("tree-paths")
            .get("paths")
            .and_then(Value::as_array)
            .expect("paths array")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    }

    fn shutdown(&mut self) {
        self.core.shutdown();
    }
}

fn state_str(state: &Value, key: &str) -> String {
    state
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("state is missing {key}: {state}"))
        .to_string()
}

#[test]
fn deep_deletion_incremental_matches_full_and_survives_restart() {
    let mut harness = CaptureHarness::with_files(
        "inc-deep-deletion",
        &[
            ("keep.txt", "keep\n"),
            ("a/b/deleted.txt", "deleted bytes\n"),
            ("a/b/sibling.txt", "sibling\n"),
        ],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    let baseline_tree = state_str(&baseline, "tree");

    fs::remove_file(harness.source.join("a/b/deleted.txt")).expect("delete deep file");
    let incremental = harness.incremental(&baseline_commit, &["a/b/deleted.txt"]);
    let incremental_commit = state_str(&incremental, "commit");
    let incremental_tree = state_str(&incremental, "tree");
    assert_ne!(
        incremental_commit, baseline_commit,
        "incremental capture must acknowledge with a new commit"
    );
    assert_ne!(
        incremental_tree, baseline_tree,
        "incremental tree must differ from its parent after a deletion"
    );
    let incremental_paths = harness.paths(&incremental_commit);
    assert!(
        !incremental_paths.contains("a/b/deleted.txt"),
        "incremental snapshot retains the deleted file: {incremental_paths:?}"
    );
    assert!(incremental_paths.contains("a/b/sibling.txt"));
    assert!(incremental_paths.contains("keep.txt"));

    let full = harness.capture(Some(&incremental_commit));
    let full_commit = state_str(&full, "commit");
    let full_tree = state_str(&full, "tree");
    let full_paths = harness.paths(&full_commit);
    assert!(
        !full_paths.contains("a/b/deleted.txt"),
        "full capture retains the deleted file"
    );
    assert_eq!(
        incremental_tree, full_tree,
        "incremental and full trees must agree on a deep deletion"
    );
    assert_eq!(incremental_paths, full_paths);

    // Repeated requests on the same core reuse the cached map.
    let repeat = harness.incremental(&incremental_commit, &["a/b/sibling.txt"]);
    let repeat_tree = state_str(&repeat, "tree");
    let repeat_paths = harness.paths(&state_str(&repeat, "commit"));
    assert_eq!(repeat_tree, incremental_tree);
    assert_eq!(repeat_paths, incremental_paths);

    // Restart clears the in-memory cache; disk state must still agree.
    let base = harness.base.clone();
    let fixture_path = harness.fixture.path().to_path_buf();
    let home = harness.home.clone();
    harness.shutdown();
    let mut restarted = CoreProcess::spawn(&home, &fixture_path);
    let mut request = |op: &str, extra: Value| -> Value {
        let mut merged = base.as_object().cloned().expect("base object");
        for (key, value) in extra.as_object().expect("extra object") {
            merged.insert(key.clone(), value.clone());
        }
        restarted
            .request_ok(op, Value::Object(merged), DEADLINE)
            .unwrap_or_else(|e| panic!("restarted {op} failed: {e}"))
    };
    let restarted_paths: HashSet<String> = request("tree-paths", json!({ "stateId": incremental_commit }))
        .get("paths")
        .and_then(Value::as_array)
        .expect("paths array")
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    assert_eq!(restarted_paths, incremental_paths);
    assert!(!restarted_paths.contains("a/b/deleted.txt"));
    restarted.shutdown();
    // Harness fixture (source/store) drops here after both children exited.
}

#[test]
fn root_and_shallow_deletions_match_full() {
    let mut harness = CaptureHarness::with_files(
        "inc-shallow-deletion",
        &[
            ("keep.txt", "keep\n"),
            ("root-victim.txt", "root\n"),
            ("a/one-victim.txt", "one\n"),
            ("a/keep.txt", "a-keep\n"),
        ],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");

    // Root deletion control.
    fs::remove_file(harness.source.join("root-victim.txt")).expect("delete root file");
    let root_inc = harness.incremental(&baseline_commit, &["root-victim.txt"]);
    let root_inc_commit = state_str(&root_inc, "commit");
    let root_inc_tree = state_str(&root_inc, "tree");
    let root_inc_paths = harness.paths(&root_inc_commit);
    assert!(!root_inc_paths.contains("root-victim.txt"));
    let root_full = harness.capture(Some(&root_inc_commit));
    let root_full_tree = state_str(&root_full, "tree");
    let root_full_paths = harness.paths(&state_str(&root_full, "commit"));
    assert_eq!(root_inc_tree, root_full_tree);
    assert_eq!(root_inc_paths, root_full_paths);

    // One-level deletion control chained on the same core (cached parent).
    fs::remove_file(harness.source.join("a/one-victim.txt")).expect("delete one-level file");
    let one_inc = harness.incremental(&root_inc_commit, &["a/one-victim.txt"]);
    let one_inc_commit = state_str(&one_inc, "commit");
    let one_inc_tree = state_str(&one_inc, "tree");
    let one_inc_paths = harness.paths(&one_inc_commit);
    assert!(!one_inc_paths.contains("a/one-victim.txt"));
    assert!(one_inc_paths.contains("a/keep.txt"));
    let one_full = harness.capture(Some(&one_inc_commit));
    let one_full_tree = state_str(&one_full, "tree");
    let one_full_paths = harness.paths(&state_str(&one_full, "commit"));
    assert_eq!(one_inc_tree, one_full_tree);
    assert_eq!(one_inc_paths, one_full_paths);

    // Mixed hints: sparse deep addition plus an edit in one batch.
    let deep_path = harness.source.join("a/c/d/added.txt");
    fs::create_dir_all(deep_path.parent().unwrap()).expect("create deep parent");
    fs::write(&deep_path, "added\n").expect("write deep addition");
    fs::write(harness.source.join("keep.txt"), "keep-edited\n").expect("edit file");
    let mixed = harness.incremental(&one_inc_commit, &["a/c/d/added.txt", "keep.txt"]);
    let mixed_commit = state_str(&mixed, "commit");
    let mixed_tree = state_str(&mixed, "tree");
    let mixed_paths = harness.paths(&mixed_commit);
    assert!(mixed_paths.contains("a/c/d/added.txt"));
    let mixed_full = harness.capture(Some(&mixed_commit));
    let mixed_full_tree = state_str(&mixed_full, "tree");
    let mixed_full_paths = harness.paths(&state_str(&mixed_full, "commit"));
    assert_eq!(mixed_tree, mixed_full_tree);
    assert_eq!(mixed_paths, mixed_full_paths);

    harness.shutdown();
}

#[test]
fn file_directory_transitions_match_full() {
    let mut harness = CaptureHarness::with_files(
        "inc-transitions",
        &[
            ("keep.txt", "keep\n"),
            ("flip.txt", "was-file\n"),
            ("dir/a.txt", "a\n"),
            ("dir/b.txt", "b\n"),
        ],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");

    // File -> directory: the old file hint plus the new child hint.
    fs::remove_file(harness.source.join("flip.txt")).expect("remove flipped file");
    fs::create_dir_all(harness.source.join("flip.txt")).expect("create flipped dir");
    fs::write(harness.source.join("flip.txt/inner.txt"), "inner\n").expect("write inner");
    let file_to_dir = harness.incremental(&baseline_commit, &["flip.txt", "flip.txt/inner.txt"]);
    let file_to_dir_commit = state_str(&file_to_dir, "commit");
    let file_to_dir_tree = state_str(&file_to_dir, "tree");
    let file_to_dir_paths = harness.paths(&file_to_dir_commit);
    assert!(file_to_dir_paths.contains("flip.txt/inner.txt"));
    assert!(
        !file_to_dir_paths.contains("flip.txt"),
        "file entry must not survive its transition to a directory"
    );
    let file_to_dir_full = harness.capture(Some(&file_to_dir_commit));
    let file_to_dir_full_tree = state_str(&file_to_dir_full, "tree");
    let file_to_dir_full_paths = harness.paths(&state_str(&file_to_dir_full, "commit"));
    assert_eq!(file_to_dir_tree, file_to_dir_full_tree);
    assert_eq!(file_to_dir_paths, file_to_dir_full_paths);

    // Directory -> file: the new file hint plus the removed children.
    fs::remove_dir_all(harness.source.join("dir")).expect("remove flipped dir");
    fs::write(harness.source.join("dir"), "now-file\n").expect("write flipped file");
    let dir_to_file = harness.incremental(
        &file_to_dir_commit,
        &["dir", "dir/a.txt", "dir/b.txt"],
    );
    let dir_to_file_commit = state_str(&dir_to_file, "commit");
    let dir_to_file_tree = state_str(&dir_to_file, "tree");
    let dir_to_file_paths = harness.paths(&dir_to_file_commit);
    assert!(dir_to_file_paths.contains("dir"));
    assert!(!dir_to_file_paths.contains("dir/a.txt"));
    assert!(!dir_to_file_paths.contains("dir/b.txt"));
    let dir_to_file_full = harness.capture(Some(&dir_to_file_commit));
    let dir_to_file_full_tree = state_str(&dir_to_file_full, "tree");
    let dir_to_file_full_paths = harness.paths(&state_str(&dir_to_file_full, "commit"));
    assert_eq!(dir_to_file_tree, dir_to_file_full_tree);
    assert_eq!(dir_to_file_paths, dir_to_file_full_paths);

    harness.shutdown();
}

#[test]
fn directory_hint_fails_loudly_and_preserves_subtree() {
    let mut harness = CaptureHarness::with_files(
        "inc-dir-hint",
        &[
            ("keep.txt", "keep\n"),
            ("dir/a.txt", "a\n"),
            ("dir/b.txt", "b\n"),
            ("dir/nested/c.txt", "c\n"),
        ],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    let baseline_tree = state_str(&baseline, "tree");
    let baseline_paths = harness.paths(&baseline_commit);

    let error = harness.incremental_err(&baseline_commit, &["dir"]);
    assert!(
        error.contains("directory"),
        "directory hint must fail closed: {error}"
    );

    // The failed capture must not publish a tree that dropped the subtree.
    let after_paths = harness.paths(&baseline_commit);
    assert_eq!(after_paths, baseline_paths);
    assert!(after_paths.contains("dir/a.txt"));
    assert!(after_paths.contains("dir/b.txt"));
    assert!(after_paths.contains("dir/nested/c.txt"));

    // A later full capture on the same parent still sees the live subtree.
    let full = harness.capture(Some(&baseline_commit));
    let full_tree = state_str(&full, "tree");
    let full_paths = harness.paths(&state_str(&full, "commit"));
    assert_eq!(full_tree, baseline_tree);
    assert_eq!(full_paths, baseline_paths);

    harness.shutdown();
}

#[test]
fn file_to_empty_dir_transition_matches_full() {
    let mut harness = CaptureHarness::with_files(
        "inc-empty-dir",
        &[("keep.txt", "keep\n"), ("flip.txt", "was-file\n")],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");

    fs::remove_file(harness.source.join("flip.txt")).expect("remove flipped file");
    fs::create_dir_all(harness.source.join("flip.txt")).expect("create empty dir");
    let empty_dir = harness.incremental(&baseline_commit, &["flip.txt"]);
    let empty_dir_commit = state_str(&empty_dir, "commit");
    let empty_dir_tree = state_str(&empty_dir, "tree");
    let empty_dir_paths = harness.paths(&empty_dir_commit);
    assert!(
        !empty_dir_paths.contains("flip.txt"),
        "empty directory must not keep the old file entry: {empty_dir_paths:?}"
    );
    assert!(empty_dir_paths.contains("keep.txt"));

    let full = harness.capture(Some(&empty_dir_commit));
    let full_tree = state_str(&full, "tree");
    let full_paths = harness.paths(&state_str(&full, "commit"));
    assert_eq!(empty_dir_tree, full_tree);
    assert_eq!(empty_dir_paths, full_paths);

    harness.shutdown();
}
