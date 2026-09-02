package trellis

import "crypto/sha256"

// Receipt anchor leaves and Merkle nodes are SHA-256: leaf = SHA256(SHA256(bytes)), node = SHA256(min(a,b) || max(a,b)).
// The router's Merkle code and the Trellis anchor program on Solana must use exactly these rules.

// SHA256 hashes the concatenation of parts.
func SHA256(parts ...[]byte) []byte {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// SHA256d is SHA256(SHA256(parts...)): the double hash anchor leaves use.
func SHA256d(parts ...[]byte) []byte {
	return SHA256(SHA256(parts...))
}
