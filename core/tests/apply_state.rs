//! Apply through the descriptor-bound target and commit the materialized bytes.
mod common;

use common::{CoreProcess, TempFixture, identity_json};
use git2::{Repository, Signature};
use serde_json::json;
use std::fs;
use std::path::Path;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(10);

fn seed_repository(path: &Path, bytes: &[u8]) -> Repository {
    let repo = Repository::init(path).unwrap();
    fs::write(path.join("file.txt"), bytes).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("file.txt")).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let signature = Signature::now("Fixture", "fixture@example.invalid").unwrap();
    {
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "base", &tree, &[])
            .unwrap();
    }
    repo
}

fn check_materialized_commit(ignored_addition: bool, template: bool) {
    let fixture = TempFixture::new("apply-state");
    let home = fixture.join("home");
    fs::create_dir(&home).unwrap();
    let source = fixture.join("source");
    let target = fixture.join("target");
    let source_repo = seed_repository(&source, b"snapshot bytes\n");
    if ignored_addition {
        fs::write(source.join(".gitignore"), b"ignored.txt\n").unwrap();
        fs::write(source.join("ignored.txt"), b"tracked despite ignore rule\n").unwrap();
        let mut index = source_repo.index().unwrap();
        index.add_path(Path::new(".gitignore")).unwrap();
        index.add_path(Path::new("ignored.txt")).unwrap();
        index.write().unwrap();
    }
    if template {
        fs::create_dir(&target).unwrap();
    } else {
        seed_repository(&target, b"original bytes\n");
    }
    let store = fixture.join("store");
    let mut core = CoreProcess::spawn(&home, fixture.path());
    let created = core
        .request_ok(
            "store-create",
            json!({
                "storeDir": store, "sourceGitDir": source.join(".git"), "objectFormat": "sha1",
            }),
            DEADLINE,
        )
        .unwrap();
    let mut payload = json!({
        "storeDir": store, "sourceRoot": source, "sourceGitDir": source.join(".git"),
        "objectFormat": "sha1",
    });
    for (key, value) in created.as_object().unwrap() {
        if key.starts_with("store") {
            payload[key] = value.clone();
        }
    }
    let snapshot = core
        .request_ok("capture", payload.clone(), DEADLINE)
        .unwrap();
    payload["stateId"] = snapshot["state"]["commit"].clone();
    payload["targetDir"] = json!(target);
    payload["boundRootIdentity"] = identity_json(&target);
    payload["sourceObjectsDir"] = json!(source.join(".git/objects"));
    let mut applied_commit = None;
    for _ in 0..if template { 1 } else { 2 } {
        core.request_ok(
            if template { "template" } else { "apply-state" },
            payload.clone(),
            DEADLINE,
        )
        .unwrap();
        assert_eq!(
            fs::read(target.join("file.txt")).unwrap(),
            b"snapshot bytes\n"
        );
        let repo = Repository::open(&target).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = commit.tree().unwrap();
        assert_eq!(
            tree.id().to_string(),
            snapshot["state"]["tree"].as_str().unwrap(),
            "committed tree must include every snapshot path, even ignored additions"
        );
        let entry = tree.get_path(Path::new("file.txt")).unwrap();
        assert_eq!(
            repo.find_blob(entry.id()).unwrap().content(),
            b"snapshot bytes\n"
        );
        assert_eq!(commit.parent_count(), if template { 0 } else { 1 });
        assert_eq!(commit.author().name().unwrap(), "termina");
        if let Some(previous) = applied_commit {
            assert_eq!(
                commit.id(),
                previous,
                "unchanged apply must not add a commit"
            );
        }
        applied_commit = Some(commit.id());
    }
    core.shutdown();
}

#[test]
fn apply_state_updates_worktree_and_commit_and_can_repeat() {
    check_materialized_commit(false, false);
}

#[test]
fn apply_state_commits_ignored_files_present_in_the_snapshot() {
    check_materialized_commit(true, false);
}

#[test]
fn template_commits_ignored_files_present_in_the_snapshot() {
    check_materialized_commit(true, true);
}
