//! Merkle tree definition shared by the receipt anchor, the settlement spend roots and the
//! public verifier script.
//!
//! - hash function: sha256 only (never keccak).
//! - leaf  = sha256(sha256(receipt_bytes))         (double hash: second-preimage guard)
//! - node  = sha256(min(a, b) || max(a, b))        (sorted pair, so proofs carry no
//!                                                  left/right flags)
//! - an odd trailing node is promoted unchanged to the next level.
//!
//! `verify_inclusion` is a pure function (no instruction) that CPI callers and tests can use.

use solana_sha256_hasher::hashv;

pub fn leaf_hash(bytes: &[u8]) -> [u8; 32] {
    let inner = hashv(&[bytes]).to_bytes();
    hashv(&[&inner]).to_bytes()
}

pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    if a <= b {
        hashv(&[a, b]).to_bytes()
    } else {
        hashv(&[b, a]).to_bytes()
    }
}

/// Returns true when `leaf` is included in the tree with `root` given the sibling `proof`.
pub fn verify_inclusion(root: &[u8; 32], leaf: &[u8; 32], proof: &[[u8; 32]]) -> bool {
    let mut acc = *leaf;
    for sibling in proof {
        acc = node_hash(&acc, sibling);
    }
    &acc == root
}

/// Computes the root of `leaves` with the rules above. Empty input yields the all-zero root.
pub fn compute_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            if pair.len() == 2 {
                next.push(node_hash(&pair[0], &pair[1]));
            } else {
                next.push(pair[0]);
            }
        }
        level = next;
    }
    level[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_leaf_root_is_leaf() {
        let l = leaf_hash(b"receipt-1");
        assert_eq!(compute_root(&[l]), l);
        assert!(verify_inclusion(&l, &l, &[]));
    }

    #[test]
    fn three_leaves_verify_with_sorted_pairs() {
        let leaves: Vec<[u8; 32]> = (0u8..3).map(|i| leaf_hash(&[i])).collect();
        let root = compute_root(&leaves);
        // leaf 0: sibling leaf 1, then promoted leaf 2.
        assert!(verify_inclusion(&root, &leaves[0], &[leaves[1], leaves[2]]));
        // leaf 2 is promoted: sibling is node(0,1).
        let n01 = node_hash(&leaves[0], &leaves[1]);
        assert!(verify_inclusion(&root, &leaves[2], &[n01]));
        assert!(!verify_inclusion(&root, &leaves[2], &[leaves[0]]));
    }
}
