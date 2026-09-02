package trellis

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"strings"
)

// Tab vouchers (the `tab` x402 scheme): per request the payer's session key signs the 110 bytes
//
//	"trellis:tab:voucher:v1" (22) || tab program id (32) || tab (32) || created_at i64 LE || cumulative_used u64 LE || seq u64 LE
//
// The first three fields say what the voucher is for: a tab voucher and nothing else, on this deployment of the tab
// program (the id differs per cluster), for this opening of the tab. created_at is the open tab's Tab.created_at, which
// the payer reads from the chain after open_tab lands: a tab address can be opened again later with the same session
// key, and a voucher for the earlier opening is then worth nothing. Only this form is accepted; the earlier 48 bytes
// (tab || cumulative_used || seq) are refused by the router and cannot be produced here.
//
// The chain-side pieces (opening a tab, PDAs, reading the Tab account) live in the solana sub-module; the message,
// signature and header primitives need no chain library and are here so both share them.

const (
	// HeaderTab carries the tab PDA (base58) on a request paid by a tab.
	HeaderTab = "X-Trellis-Tab"
	// HeaderTabVoucher carries `<base64 110-byte message>.<base64 64-byte signature>`.
	HeaderTabVoucher = "X-Trellis-Tab-Voucher"
	// VoucherDomain is the domain separator every voucher message starts with (22 ASCII bytes).
	VoucherDomain = "trellis:tab:voucher:v1"
	// VoucherMessageLen is the length of the signed voucher message: 22 + 32 + 32 + 8 + 8 + 8.
	VoucherMessageLen = 110
)

// Offsets of the fields in a voucher message.
const (
	voucherProgramAt = len(VoucherDomain)
	voucherTabAt     = voucherProgramAt + 32
	voucherCreatedAt = voucherTabAt + 32
	voucherUsedAt    = voucherCreatedAt + 8
	voucherSeqAt     = voucherUsedAt + 8
)

// VoucherFields is a voucher message read back into its fields.
type VoucherFields struct {
	// ProgramID is the tab program the voucher is for.
	ProgramID [32]byte
	// Tab is the tab's address.
	Tab [32]byte
	// CreatedAt is the Tab.created_at of the opening the voucher is for (unix seconds).
	CreatedAt int64
	// CumulativeUsed is everything served so far, in USDC base units.
	CumulativeUsed uint64
	Seq            uint64
}

// VoucherMessage is the exact bytes a session key signs: the domain, the tab program's id, the tab's address, the
// open tab's created_at (i64 LE), cumulative_used (u64 LE) and seq (u64 LE). The program id and created_at are part of
// what is signed and have no default: take the id from the router (GET /facilitator/supported or GET /api/v1/status)
// and created_at from the Tab account on chain.
func VoucherMessage(programID, tab [32]byte, createdAt int64, cumulativeUsed, seq uint64) []byte {
	m := make([]byte, VoucherMessageLen)
	copy(m, VoucherDomain)
	copy(m[voucherProgramAt:], programID[:])
	copy(m[voucherTabAt:], tab[:])
	binary.LittleEndian.PutUint64(m[voucherCreatedAt:], uint64(createdAt))
	binary.LittleEndian.PutUint64(m[voucherUsedAt:], cumulativeUsed)
	binary.LittleEndian.PutUint64(m[voucherSeqAt:], seq)
	return m
}

// isVoucherMessage reports whether message has the length and the domain of a voucher message.
func isVoucherMessage(message []byte) bool {
	return len(message) == VoucherMessageLen && bytes.HasPrefix(message, []byte(VoucherDomain))
}

// DecodeVoucherMessage splits a voucher message into its fields. Anything that is not 110 bytes starting with the
// voucher domain is refused.
func DecodeVoucherMessage(message []byte) (VoucherFields, error) {
	var f VoucherFields
	if !isVoucherMessage(message) {
		return f, wrapf("a voucher message is %d bytes starting with %q, got %d bytes", VoucherMessageLen, VoucherDomain, len(message))
	}
	copy(f.ProgramID[:], message[voucherProgramAt:voucherTabAt])
	copy(f.Tab[:], message[voucherTabAt:voucherCreatedAt])
	f.CreatedAt = int64(binary.LittleEndian.Uint64(message[voucherCreatedAt:voucherUsedAt]))
	f.CumulativeUsed = binary.LittleEndian.Uint64(message[voucherUsedAt:voucherSeqAt])
	f.Seq = binary.LittleEndian.Uint64(message[voucherSeqAt:])
	return f, nil
}

// SignVoucher builds the voucher message for these fields (VoucherMessage) and signs it with the session key
// (detached ed25519, 64 bytes). It returns both: the message goes in the header beside the signature.
func SignVoucher(sessionKey ed25519.PrivateKey, programID, tab [32]byte, createdAt int64, cumulativeUsed, seq uint64) (message, signature []byte) {
	message = VoucherMessage(programID, tab, createdAt, cumulativeUsed, seq)
	return message, ed25519.Sign(sessionKey, message)
}

// VerifyVoucher reports whether signature is sessionKey's ed25519 signature over the voucher for this tab program,
// this tab, this opening of it (createdAt) and these amounts. It never panics: a key or signature of the wrong length
// is simply not valid.
func VerifyVoucher(sessionKey ed25519.PublicKey, programID, tab [32]byte, createdAt int64, cumulativeUsed, seq uint64, signature []byte) bool {
	if len(sessionKey) != ed25519.PublicKeySize || len(signature) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(sessionKey, VoucherMessage(programID, tab, createdAt, cumulativeUsed, seq), signature)
}

// VerifyVoucherMessage reports whether message is a voucher message for this tab program and this opening of the tab
// (createdAt), signed by sessionKey. A message for another program, for another opening of the same tab address, or in
// any other form (the earlier 48 bytes among them) is not valid, whatever its signature.
func VerifyVoucherMessage(sessionKey ed25519.PublicKey, programID [32]byte, createdAt int64, message, signature []byte) bool {
	f, err := DecodeVoucherMessage(message)
	if err != nil || f.ProgramID != programID || f.CreatedAt != createdAt {
		return false
	}
	if len(sessionKey) != ed25519.PublicKeySize || len(signature) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(sessionKey, message, signature)
}

// VoucherHeader is the X-Trellis-Tab-Voucher value: base64(message) + "." + base64(signature).
func VoucherHeader(message, signature []byte) string {
	return base64.StdEncoding.EncodeToString(message) + "." + base64.StdEncoding.EncodeToString(signature)
}

// ParseVoucherHeader splits an X-Trellis-Tab-Voucher value into the 110-byte voucher message and the 64-byte
// signature. A message of another length or without the voucher domain is refused.
func ParseVoucherHeader(value string) (message, signature []byte, err error) {
	parts := strings.Split(strings.TrimSpace(value), ".")
	if len(parts) != 2 {
		return nil, nil, wrapf("%s must be <base64 message>.<base64 signature>", HeaderTabVoucher)
	}
	if message, err = base64.StdEncoding.DecodeString(parts[0]); err != nil {
		return nil, nil, wrapf("%s message: %v", HeaderTabVoucher, err)
	}
	if signature, err = base64.StdEncoding.DecodeString(parts[1]); err != nil {
		return nil, nil, wrapf("%s signature: %v", HeaderTabVoucher, err)
	}
	if !isVoucherMessage(message) || len(signature) != ed25519.SignatureSize {
		return nil, nil, wrapf("%s must carry a %d-byte %q message and a %d-byte signature", HeaderTabVoucher, VoucherMessageLen, VoucherDomain, ed25519.SignatureSize)
	}
	return message, signature, nil
}
