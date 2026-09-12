//! Memoized flat tree maps across serial requests.
use std::collections::HashMap;
use std::sync::Mutex;

use git2::{Oid, Repository};
use crate::TREE_MAP_CACHE_SIZE;

use super::trees::FlatEntry;
use super::walk::collect_tree_map;

type TreeMap = HashMap<String, FlatEntry>;
type TreeMapCache = HashMap<Oid, std::sync::Arc<TreeMap>>;

fn tree_map_cache() -> &'static Mutex<TreeMapCache> {
    static CACHE: std::sync::OnceLock<Mutex<TreeMapCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached flat map of a tree. The core process handles requests one at a
/// time, so the parent tree of the next capture is usually cached.
pub(crate) fn collect_tree_map_cached(
    repo: &Repository,
    tree_oid: Oid,
) -> Result<std::sync::Arc<TreeMap>, String> {
    if let Some(hit) = tree_map_cache()
        .lock()
        .expect("tree-map cache mutex is never poisoned: core handles requests one at a time")
        .get(&tree_oid)
    {
        return Ok(hit.clone());
    }
    let map = std::sync::Arc::new(collect_tree_map(repo, tree_oid)?);
    let mut cache = tree_map_cache()
        .lock()
        .expect("tree-map cache mutex is never poisoned: core handles requests one at a time");
    if cache.len() >= TREE_MAP_CACHE_SIZE {
        // Evict one arbitrary entry. Any policy beats a full walk here.
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(tree_oid, map.clone());
    Ok(map)
}

/// Remember the flat map of a freshly written tree.
pub(crate) fn cache_tree_map(tree_oid: Oid, map: std::sync::Arc<TreeMap>) {
    let mut cache = tree_map_cache()
        .lock()
        .expect("tree-map cache mutex is never poisoned: core handles requests one at a time");
    if cache.len() >= TREE_MAP_CACHE_SIZE {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(tree_oid, map);
}
