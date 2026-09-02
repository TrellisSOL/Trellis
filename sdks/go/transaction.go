package trellis

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
)

// The router hands out Solana transactions as base64 (deposits, closures and their cancellation, refund destination
// changes) for a wallet to sign and send. Adding a
// signature needs no chain library: a serialized transaction is its signature slots followed by the message they sign,
// and the message lists the signers in slot order. The functions here fill one slot and leave every other byte as it
// came, so a signature that is already in place (the API key's, on a closure) arrives unchanged.

// signedTx is a serialized transaction split into its parts. The slices alias raw.
type signedTx struct {
	raw []byte
	// sigAt is the offset of the first 64-byte signature slot; there are len(signers) of them.
	sigAt int
	// message is what every signature covers.
	message []byte
	// signers are the required signers in slot order (the first is the fee payer).
	signers [][]byte
}

// shortVec reads Solana's compact-u16 length at b[i:] and returns it with the offset after it.
func shortVec(b []byte, i int) (n, next int, ok bool) {
	for shift := 0; shift < 21; shift += 7 {
		if i >= len(b) {
			return 0, 0, false
		}
		c := b[i]
		i++
		n |= int(c&0x7f) << shift
		if c&0x80 == 0 {
			return n, i, n <= 0xffff
		}
	}
	return 0, 0, false
}

func parseSignedTx(txBase64 string) (*signedTx, error) {
	raw, err := base64.StdEncoding.DecodeString(txBase64)
	if err != nil {
		return nil, wrapf("the transaction is not base64: %v", err)
	}
	bad := errors.New("trellis: the transaction is malformed")
	nsig, at, ok := shortVec(raw, 0)
	if !ok || nsig == 0 || len(raw) < at+64*nsig+4 {
		return nil, bad
	}
	t := &signedTx{raw: raw, sigAt: at, message: raw[at+64*nsig:]}
	m := t.message
	h := 0
	if m[0]&0x80 != 0 { // a versioned message: one version byte before the header
		h = 1
	}
	if len(m) < h+3 || int(m[h]) != nsig {
		return nil, bad
	}
	nkeys, k, ok := shortVec(m, h+3)
	if !ok || nkeys < nsig || len(m) < k+32*nkeys {
		return nil, bad
	}
	for i := 0; i < nsig; i++ {
		t.signers = append(t.signers, m[k+32*i:k+32*i+32])
	}
	return t, nil
}

func (t *signedTx) slot(i int) []byte { return t.raw[t.sigAt+64*i : t.sigAt+64*i+64] }

func (t *signedTx) indexOf(signer []byte) int {
	for i, k := range t.signers {
		if bytes.Equal(k, signer) {
			return i
		}
	}
	return -1
}

// SignTransactionWith adds one signature to a serialized Solana transaction (base64) and returns it re-encoded: sign
// receives the message bytes and returns signer's 64-byte ed25519 signature over them, which goes in signer's slot.
// Nothing else changes: the message and every other signature slot keep their bytes. signer must be one of the
// transaction's required signers. Use it for a wallet that signs somewhere else; SignTransaction takes a key held in
// memory.
func SignTransactionWith(txBase64 string, signer ed25519.PublicKey, sign func(message []byte) ([]byte, error)) (string, error) {
	t, err := parseSignedTx(txBase64)
	if err != nil {
		return "", err
	}
	i := t.indexOf(signer)
	if i < 0 {
		return "", wrapf("%s is not a required signer of the transaction", Base58Encode(signer))
	}
	sig, err := sign(append([]byte(nil), t.message...))
	if err != nil {
		return "", wrapf("signing the transaction: %v", err)
	}
	if len(sig) != ed25519.SignatureSize || !ed25519.Verify(signer, t.message, sig) {
		return "", wrapf("the signer did not return %s's signature over the transaction message", Base58Encode(signer))
	}
	copy(t.slot(i), sig)
	return base64.StdEncoding.EncodeToString(t.raw), nil
}

// SignTransaction is SignTransactionWith for an ed25519 private key held in memory.
func SignTransaction(txBase64 string, priv ed25519.PrivateKey) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", wrapf("the signing key must be a %d-byte ed25519 private key", ed25519.PrivateKeySize)
	}
	return SignTransactionWith(txBase64, priv.Public().(ed25519.PublicKey), func(m []byte) ([]byte, error) { return ed25519.Sign(priv, m), nil })
}
