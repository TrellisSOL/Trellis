package trellis

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Wallet sign-in exchanges a signature by a Solana wallet for an API key on the wallet's account:
//
//	POST /api/v1/auth/wallet/challenge {address}                          -> the challenge, with the message to sign
//	POST /api/v1/auth/wallet {address, nonce, signature, message, name?}  -> the key
//
// The router writes the message: a Sign-In-With-Solana text whose first line names the router's own domain and whose
// second line is the wallet's address. The wallet signs its UTF-8 bytes exactly as returned. There is no message built
// by the client and no timestamp in the request: the validity is part of the signed text, and the earlier
// "trellis:wallet:v1" text, which named no site, signs nothing in.
//
// A signature over that message is a login at the domain it names, so the client checks the domain before it signs
// (WalletChallenge.Check): a page or proxy that relays another site's challenge is refused.

// WalletSignInVersion is the sign-in scheme the challenge route reports, and the only one this SDK signs.
const WalletSignInVersion = "trellis:wallet:v2"

// walletSignInIntro follows the domain on the first line of a sign-in message.
const walletSignInIntro = " wants you to sign in with your Solana account:"

// ErrChallengeRefused is wrapped by every error that says a sign-in challenge was not signed: it is not this router's,
// not for this wallet, or not in the form this SDK knows.
var ErrChallengeRefused = errors.New("trellis: sign-in challenge refused")

// WalletChallenge is the `data` of POST /api/v1/auth/wallet/challenge.
type WalletChallenge struct {
	// Nonce names the challenge (single use).
	Nonce string `json:"nonce"`
	// Message is the exact text to sign.
	Message string `json:"message"`
	// Domain is the router's public host[:port]; the first line of Message names it.
	Domain  string `json:"domain"`
	URI     string `json:"uri"`
	ChainID string `json:"chain_id"`
	// IssuedAt and ExpiresAt are ISO 8601 times; the challenge is accepted for 5 minutes.
	IssuedAt  string `json:"issued_at"`
	ExpiresAt string `json:"expires_at"`
	Version   string `json:"version"`
}

// Check reports whether the challenge may be signed by the wallet at address (base58) for the router at domain
// (host[:port], compared in lower case): the version is WalletSignInVersion, the challenge's domain is that domain,
// the first line of the message names the same domain, the second line is the address, and the message carries the
// challenge's nonce. Any other challenge is refused with an error wrapping ErrChallengeRefused.
func (ch *WalletChallenge) Check(domain, address string) error {
	refuse := func(format string, a ...any) error {
		return fmt.Errorf("%w: %s", ErrChallengeRefused, fmt.Sprintf(format, a...))
	}
	if ch == nil {
		return refuse("no challenge")
	}
	if ch.Version != WalletSignInVersion {
		return refuse("version %q is not %s", ch.Version, WalletSignInVersion)
	}
	want := strings.ToLower(strings.TrimSpace(domain))
	if want == "" || address == "" {
		return refuse("the router's domain and the wallet's address are needed to check it")
	}
	if ch.Domain != want {
		return refuse("it is for %q, this client talks to %q", ch.Domain, want)
	}
	lines := strings.Split(ch.Message, "\n")
	if len(lines) < 2 || lines[0] != want+walletSignInIntro {
		return refuse("the message does not open with a sign-in at %q", want)
	}
	if lines[1] != address {
		return refuse("the message is not for this wallet's address")
	}
	nonce := false
	for _, l := range lines[2:] {
		if ch.Nonce != "" && l == "Nonce: "+ch.Nonce {
			nonce = true
		}
	}
	if !nonce {
		return refuse("the message does not carry the challenge's nonce")
	}
	return nil
}

// SignWalletChallenge checks the challenge for the router at domain (WalletChallenge.Check, with the address of priv)
// and returns the wallet's base58 signature over the UTF-8 bytes of its message, exactly as the router returned it. It
// signs nothing when the check fails.
func SignWalletChallenge(priv ed25519.PrivateKey, ch *WalletChallenge, domain string) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", wrapf("the wallet key must be a %d-byte ed25519 private key", ed25519.PrivateKeySize)
	}
	if err := ch.Check(domain, Base58Encode(priv.Public().(ed25519.PublicKey))); err != nil {
		return "", err
	}
	return Base58Encode(ed25519.Sign(priv, []byte(ch.Message))), nil
}

// WalletSignInRequest is the body of POST /api/v1/auth/wallet.
type WalletSignInRequest struct {
	Address string `json:"address"`
	Nonce   string `json:"nonce"`
	// Signature is base58 of the wallet's 64-byte signature over the UTF-8 bytes of Message.
	Signature string `json:"signature"`
	// Message is the challenge's message, as signed.
	Message string `json:"message"`
	// Name labels the new key (optional).
	Name string `json:"name,omitempty"`
}

// WalletSignInResult is the answer of POST /api/v1/auth/wallet: a new API key on the wallet's account.
type WalletSignInResult struct {
	// Key is the API key. The router shows it once; pass it to WithAPIKey.
	Key string `json:"key"`
	// Hash, Name and Label describe the key.
	Hash  string `json:"-"`
	Name  string `json:"-"`
	Label string `json:"-"`
	// Data is the key as the router describes it (the `data` of the response).
	Data json.RawMessage `json:"data"`
}

// WalletHost is the router's public host[:port] as wallet signatures name it: the value set with WithWalletHost, else
// the host of the base URL in lower case with a default port left out.
func (c *Client) WalletHost() string {
	if c.walletHost != "" {
		return c.walletHost
	}
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return ""
	}
	return WalletAuthHost(u)
}

// WalletChallenge asks the router for a sign-in challenge for the wallet at address (base58).
func (c *Client) WalletChallenge(ctx context.Context, address string, opts ...RequestOption) (*WalletChallenge, error) {
	var env struct {
		Data *WalletChallenge `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/auth/wallet/challenge", map[string]string{"address": address}, &env, opts); err != nil {
		return nil, err
	}
	if env.Data == nil {
		return nil, wrapf("auth/wallet/challenge: no data in the response")
	}
	return env.Data, nil
}

// WalletSignIn posts a signed challenge and returns the new key. Use it with WalletChallenge and
// WalletChallenge.Check when the wallet signs somewhere else; SignInWithWallet does all three steps for a key held in
// memory.
func (c *Client) WalletSignIn(ctx context.Context, req WalletSignInRequest, opts ...RequestOption) (*WalletSignInResult, error) {
	var out WalletSignInResult
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/auth/wallet", req, &out, opts); err != nil {
		return nil, err
	}
	if out.Key == "" {
		return nil, wrapf("auth/wallet: no key in the response")
	}
	var info struct {
		Hash  string `json:"hash"`
		Name  string `json:"name"`
		Label string `json:"label"`
	}
	if len(out.Data) > 0 && json.Unmarshal(out.Data, &info) == nil {
		out.Hash, out.Name, out.Label = info.Hash, info.Name, info.Label
	}
	return &out, nil
}

// SignInOptions tunes SignInWithWallet. The zero value is fine.
type SignInOptions struct {
	// Name labels the new key.
	Name string
	// Domain is the host[:port] the challenge must be for. Empty means the client's WalletHost: the host of the base
	// URL. Set it when the client reaches the router under another name (a local proxy, an internal address).
	Domain string
}

// SignInWithWallet signs the wallet in and returns a new API key on its account: it asks for a challenge, checks that
// the challenge is this router's own and for this wallet (WalletChallenge.Check; nothing is signed otherwise), signs
// the message as returned and exchanges the signature for the key.
func (c *Client) SignInWithWallet(ctx context.Context, priv ed25519.PrivateKey, in SignInOptions, opts ...RequestOption) (*WalletSignInResult, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, wrapf("the wallet key must be a %d-byte ed25519 private key", ed25519.PrivateKeySize)
	}
	domain := in.Domain
	if domain == "" {
		domain = c.WalletHost()
	}
	address := Base58Encode(priv.Public().(ed25519.PublicKey))
	ch, err := c.WalletChallenge(ctx, address, opts...)
	if err != nil {
		return nil, err
	}
	sig, err := SignWalletChallenge(priv, ch, domain)
	if err != nil {
		return nil, err
	}
	return c.WalletSignIn(ctx, WalletSignInRequest{Address: address, Nonce: ch.Nonce, Signature: sig, Message: ch.Message, Name: in.Name}, opts...)
}
