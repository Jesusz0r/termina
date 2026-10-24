use super::durable_identity::{durable_directory_identity, resolve_root_record};
use super::ops::op_promotion_bound_root_transaction;
use crate::test_fixture::TestTempDir;
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

fn raw_identity(path: &std::path::Path) -> Value {
    let stat = fs::metadata(path).unwrap();
    json!({"dev": stat.dev().to_string(), "ino": stat.ino().to_string()})
}

fn request(fixture: &TestTempDir) -> Value {
    json!({"path": fixture.join("root"),
        "trustedParent": {"path": fixture.path(), "identity": raw_identity(fixture.path()), "name": "root"},
        "provenance": {"name": "provenance.json", "parent": {"path": fixture.path(), "identity": raw_identity(fixture.path())}},
    })
}

#[test]
fn root_transaction_persists_durable_identity_and_reopens_without_request_identity() {
    let fixture = TestTempDir::new("durable-root");
    let req = request(&fixture);
    let first = op_promotion_bound_root_transaction(&req).unwrap();
    let bytes = fs::read(fixture.join("provenance.json")).unwrap();
    let record: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(record["version"], 2);
    #[cfg(target_os = "macos")]
    {
        assert!(
            record["root"]["dev"].is_null(),
            "a transient mount number must never be persisted"
        );
        assert_eq!(record["root"]["volume"].as_str().unwrap().len(), 32);
    }
    assert_eq!(
        record["root"],
        durable_directory_identity(&fs::File::open(fixture.join("root")).unwrap()).unwrap()
    );
    let second = op_promotion_bound_root_transaction(&req).unwrap();
    assert_eq!(first["result"]["dev"], second["result"]["dev"]);
    assert_eq!(first["result"]["ino"], second["result"]["ino"]);
    assert_eq!(fs::read(fixture.join("provenance.json")).unwrap(), bytes);
}

#[test]
fn root_transaction_migrates_authenticated_v1_provenance_and_state() {
    let fixture = TestTempDir::new("durable-migrate");
    fs::create_dir(fixture.join("root")).unwrap();
    let record = json!({"version": 1, "path": fixture.join("root"), "parent": raw_identity(fixture.path()), "root": raw_identity(&fixture.join("root"))});
    let mut state = record.clone();
    state["state"] = json!("bound");
    for (name, value) in [
        ("provenance.json", record),
        ("provenance.json.state", state),
    ] {
        fs::write(fixture.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
        fs::set_permissions(fixture.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    op_promotion_bound_root_transaction(&request(&fixture)).unwrap();
    for name in ["provenance.json", "provenance.json.state"] {
        let migrated: Value =
            serde_json::from_slice(&fs::read(fixture.join(name)).unwrap()).unwrap();
        assert_eq!(migrated["version"], 2);
    }
    op_promotion_bound_root_transaction(&request(&fixture)).unwrap();
}

#[test]
fn durable_record_rejects_replaced_directory_and_foreign_volume() {
    let fixture = TestTempDir::new("durable-replaced");
    let req = request(&fixture);
    op_promotion_bound_root_transaction(&req).unwrap();
    let record: Value =
        serde_json::from_slice(&fs::read(fixture.join("provenance.json")).unwrap()).unwrap();
    let mut foreign = record.clone();
    #[cfg(target_os = "macos")]
    {
        foreign["root"]["volume"] = json!("00000000000000000000000000000001");
    }
    #[cfg(not(target_os = "macos"))]
    {
        foreign["root"]["dev"] = json!("0");
    }
    assert!(resolve_root_record(&foreign, "test", false).is_err());
    fs::rename(fixture.join("root"), fixture.join("original")).unwrap();
    fs::create_dir(fixture.join("root")).unwrap();
    assert!(
        op_promotion_bound_root_transaction(&req)
            .unwrap_err()
            .contains("identity changed")
    );
    fs::remove_dir(fixture.join("root")).unwrap();
    std::os::unix::fs::symlink(fixture.join("original"), fixture.join("root")).unwrap();
    assert!(op_promotion_bound_root_transaction(&req).is_err());
}

#[test]
fn legacy_mount_mismatch_is_never_automatically_trusted_or_rewritten() {
    let fixture = TestTempDir::new("durable-legacy");
    fs::create_dir(fixture.join("root")).unwrap();
    let mut record = json!({"version": 1, "path": fixture.join("root"), "parent": raw_identity(fixture.path()), "root": raw_identity(&fixture.join("root"))});
    record["parent"]["dev"] = json!("0");
    let bytes = serde_json::to_vec(&record).unwrap();
    fs::write(fixture.join("provenance.json"), &bytes).unwrap();
    fs::set_permissions(
        fixture.join("provenance.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(
        op_promotion_bound_root_transaction(&request(&fixture))
            .unwrap_err()
            .contains("identity changed")
    );
    assert_eq!(fs::read(fixture.join("provenance.json")).unwrap(), bytes);
    assert!(!fixture.join("provenance.json.state").exists());
}

#[test]
fn upgrade_resumes_legacy_metadata_temporaries_at_each_publication_boundary() {
    for stage in ["pending-state", "provenance", "bound-state"] {
        let fixture = TestTempDir::new("durable-interrupted-upgrade");
        fs::create_dir(fixture.join("root")).unwrap();
        let record = json!({"version": 1, "path": fixture.join("root"), "parent": raw_identity(fixture.path()), "root": raw_identity(&fixture.join("root"))});
        let mut pending = record.clone();
        pending["state"] = json!("pending");
        let mut bound = record.clone();
        bound["state"] = json!("bound");
        let files = match stage {
            "pending-state" => vec![("provenance.json.state.tmp", pending)],
            "provenance" => vec![
                ("provenance.json.state", pending),
                ("provenance.json.tmp", record),
            ],
            _ => vec![
                ("provenance.json.state", pending),
                ("provenance.json", record),
                ("provenance.json.tmp", bound),
            ],
        };
        for (name, value) in files {
            fs::write(fixture.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
            fs::set_permissions(fixture.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        op_promotion_bound_root_transaction(&request(&fixture))
            .unwrap_or_else(|e| panic!("{stage}: {e}"));
        op_promotion_bound_root_transaction(&request(&fixture)).unwrap();
        for name in ["provenance.json", "provenance.json.state"] {
            let value: Value =
                serde_json::from_slice(&fs::read(fixture.join(name)).unwrap()).unwrap();
            assert_eq!(value["version"], 2);
        }
    }
}
