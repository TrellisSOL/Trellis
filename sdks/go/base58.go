package trellis

import (
	"errors"
	"strings"
)

// Base58 (the Bitcoin alphabet) is how Solana writes addresses, transaction signatures and raw ed25519 signatures. The
// encoder here is what X-Wallet-Auth needs; the solana sub-module reuses it so the two never disagree.

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

var base58Index = func() [256]int8 {
	var idx [256]int8
	for i := range idx {
		idx[i] = -1
	}
	for i := 0; i < len(base58Alphabet); i++ {
		idx[base58Alphabet[i]] = int8(i)
	}
	return idx
}()

// Base58Encode writes b in base58; every leading zero byte becomes a leading '1'.
func Base58Encode(b []byte) string {
	zeros := 0
	for zeros < len(b) && b[zeros] == 0 {
		zeros++
	}
	// Each input byte expands to at most log(256)/log(58) ~ 1.37 output digits.
	digits := make([]byte, 0, len(b)*138/100+1)
	for _, c := range b[zeros:] {
		carry := int(c)
		for i := range digits {
			carry += int(digits[i]) << 8
			digits[i] = byte(carry % 58)
			carry /= 58
		}
		for carry > 0 {
			digits = append(digits, byte(carry%58))
			carry /= 58
		}
	}
	var sb strings.Builder
	sb.Grow(zeros + len(digits))
	for i := 0; i < zeros; i++ {
		sb.WriteByte('1')
	}
	for i := len(digits) - 1; i >= 0; i-- {
		sb.WriteByte(base58Alphabet[digits[i]])
	}
	return sb.String()
}

// ErrBase58 is returned by Base58Decode for a character outside the alphabet.
var ErrBase58 = errors.New("trellis: invalid base58")

// Base58Decode reads a base58 string; every leading '1' becomes a leading zero byte.
func Base58Decode(s string) ([]byte, error) {
	zeros := 0
	for zeros < len(s) && s[zeros] == '1' {
		zeros++
	}
	out := make([]byte, 0, len(s)*733/1000+1) // log(58)/log(256) ~ 0.73
	for i := zeros; i < len(s); i++ {
		d := base58Index[s[i]]
		if d < 0 {
			return nil, ErrBase58
		}
		carry := int(d)
		for j := range out {
			carry += int(out[j]) * 58
			out[j] = byte(carry & 0xff)
			carry >>= 8
		}
		for carry > 0 {
			out = append(out, byte(carry&0xff))
			carry >>= 8
		}
	}
	res := make([]byte, zeros+len(out))
	for i, j := zeros, len(out)-1; j >= 0; i, j = i+1, j-1 {
		res[i] = out[j]
	}
	return res, nil
}

// Base58Decode32 decodes a Solana address and checks it is 32 bytes.
func Base58Decode32(s string) ([32]byte, error) {
	var out [32]byte
	b, err := Base58Decode(s)
	if err != nil {
		return out, err
	}
	if len(b) != 32 {
		return out, wrapf("expected a 32-byte base58 address, got %d bytes", len(b))
	}
	copy(out[:], b)
	return out, nil
}
