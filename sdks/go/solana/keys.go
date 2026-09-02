// Package solana adds Solana payments to the Trellis Go SDK: x402 `exact` per-call payments in USDC, tabs (an escrowed
// cap paid down with signed vouchers) and the session keys that sign them.
//
// It is a separate module so the main SDK stays dependency-free; this one builds on github.com/gagliardetto/solana-go.
// Import it as
//
//	import trellissol "example.com/trellis/sdk-go/solana"
//
// (the package name is solana, the same as solana-go's, so alias one of them when both are imported).
package solana

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"

	trellis "example.com/trellis/sdk-go"
	sol "github.com/gagliardetto/solana-go"
)

// PublicKey is a 32-byte Solana public key (solana-go's type, so the two libraries interoperate without conversion).
type PublicKey = sol.PublicKey

// Well-known program ids and mints.
var (
	// USDCMint is USDC on mainnet (6 decimals). Devnet USDC has another mint: take it from the 402's `asset`.
	USDCMint               = sol.MustPublicKeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	TokenProgram           = sol.TokenProgramID
	Token2022Program       = sol.Token2022ProgramID
	AssociatedTokenProgram = sol.SPLAssociatedTokenAccountProgramID
	SystemProgram          = sol.SystemProgramID
	ComputeBudgetProgram   = sol.ComputeBudget
)

// CAIP-2 network ids as the router names them.
const (
	NetworkMainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
	NetworkDevnet  = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
	// USDCDecimals is the decimals byte of every TransferChecked the router accepts.
	USDCDecimals = 6
)

// Signer signs transaction messages for one public key: a local keypair (KeySigner) or anything that can produce a
// detached ed25519 signature over arbitrary bytes, such as a hardware or remote wallet.
type Signer interface {
	PublicKey() PublicKey
	Sign(message []byte) ([]byte, error)
}

// KeySigner is a Signer over an ed25519 private key held in memory.
type KeySigner struct{ priv ed25519.PrivateKey }

// NewKeySigner wraps a 64-byte ed25519 private key (seed || public key, the layout Solana keygen files and solana-go use).
// A 32-byte seed is accepted too.
func NewKeySigner(priv []byte) (*KeySigner, error) {
	switch len(priv) {
	case ed25519.PrivateKeySize:
		return &KeySigner{priv: ed25519.PrivateKey(append([]byte(nil), priv...))}, nil
	case ed25519.SeedSize:
		return &KeySigner{priv: ed25519.NewKeyFromSeed(priv)}, nil
	}
	return nil, fmt.Errorf("trellis/solana: a private key is %d or %d bytes, got %d", ed25519.PrivateKeySize, ed25519.SeedSize, len(priv))
}

// PublicKey implements Signer.
func (k *KeySigner) PublicKey() PublicKey {
	return sol.PublicKeyFromBytes(k.priv.Public().(ed25519.PublicKey))
}

// Sign implements Signer.
func (k *KeySigner) Sign(message []byte) ([]byte, error) { return ed25519.Sign(k.priv, message), nil }

// SignCreditClosure adds payer's signature to a credits closure (trellis.CreditClosure.SignAsPayerWith) and returns
// the transaction (base64) ready to send. The closure arrives already signed by the API key's own keypair; payer, the
// transaction's fee payer, signs in slot 0 and every other byte, the key's signature included, stays as the router
// returned it. The payer only pays the fee: the refund goes back to the wallets that deposited to the key, and
// neither the payer nor the key chooses where.
func SignCreditClosure(cl *trellis.CreditClosure, payer Signer) (string, error) {
	if payer == nil {
		return "", errors.New("trellis/solana: a Signer is needed to sign the closure")
	}
	return cl.SignAsPayerWith(ed25519.PublicKey(payer.PublicKey().Bytes()), payer.Sign)
}

// SignCreditClosureCancel adds payer's signature to the cancellation of a credits closure
// (trellis.CreditClosureCancel.SignAsPayerWith) and returns the transaction (base64) ready to send. Like the closure it
// arrives already signed by the API key's own keypair; payer signs in slot 0 and nothing else changes.
func SignCreditClosureCancel(cc *trellis.CreditClosureCancel, payer Signer) (string, error) {
	if payer == nil {
		return "", errors.New("trellis/solana: a Signer is needed to sign the cancellation")
	}
	return cc.SignAsPayerWith(ed25519.PublicKey(payer.PublicKey().Bytes()), payer.Sign)
}

// SignRefundDestination signs a refund destination change (trellis.RefundDestinationTransaction.SignAsDepositorWith)
// with the depositor's own wallet and returns the transaction (base64) ready to send. Only the wallet that deposited
// can sign it: it is the fee payer and the only signer, and any other Signer is refused.
func SignRefundDestination(rd *trellis.RefundDestinationTransaction, depositor Signer) (string, error) {
	if depositor == nil {
		return "", errors.New("trellis/solana: a Signer is needed to sign the refund destination change")
	}
	return rd.SignAsDepositorWith(ed25519.PublicKey(depositor.PublicKey().Bytes()), depositor.Sign)
}

// GenerateSessionKey makes a fresh ed25519 keypair for signing tab vouchers. Its public key is the `session_key` of
// open_tab (SessionPublicKey); the wallet never signs vouchers.
func GenerateSessionKey() (ed25519.PrivateKey, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	return priv, err
}

// SessionPublicKey is the public key of a session key, as open_tab needs it.
func SessionPublicKey(sessionKey ed25519.PrivateKey) PublicKey {
	return sol.PublicKeyFromBytes(sessionKey.Public().(ed25519.PublicKey))
}

// AssociatedTokenAddress is owner's associated token account for mint under the SPL Token program:
// findProgramAddress([owner, TOKEN_PROGRAM, mint], ASSOCIATED_TOKEN_PROGRAM).
func AssociatedTokenAddress(owner, mint PublicKey) (PublicKey, error) {
	return AssociatedTokenAddressWithProgram(owner, mint, TokenProgram)
}

// AssociatedTokenAddressWithProgram is AssociatedTokenAddress for a given token program (Token or Token-2022).
func AssociatedTokenAddressWithProgram(owner, mint, tokenProgram PublicKey) (PublicKey, error) {
	ata, _, err := sol.FindAssociatedTokenAddressWithProgram(owner, mint, tokenProgram)
	return ata, err
}

// ParseAddress decodes a base58 address.
func ParseAddress(s string) (PublicKey, error) {
	pk, err := sol.PublicKeyFromBase58(s)
	if err != nil {
		return PublicKey{}, fmt.Errorf("trellis/solana: %q is not a base58 address: %w", s, err)
	}
	return pk, nil
}

var errNoFeePayer = errors.New("trellis/solana: the requirement names no fee payer (extra.feePayer is null), so a sponsored payment cannot be built; send the transfer yourself and present its finalized signature together with X-Wallet-Auth from the paying wallet (BindPaymentSignature)")
