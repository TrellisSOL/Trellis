package solana

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	trellis "example.com/trellis/sdk-go"
)

// Two things can go in X-PAYMENT, and holding them proves different things.
//
// A signed x402 payload is a transaction that has not landed: only the payer has it until the router submits it, and
// it can be claimed once, so presenting it is proof enough. This is what Transport sends when it pays a 402.
//
// A bare transaction signature names a transfer that already landed. It is on the public ledger, so whoever sends it
// first would get the payer's request: the router accepts it only together with X-Wallet-Auth from the wallet that
// paid, signed over that same request, and answers 401 `payment_not_bound_to_caller` without it
// (trellis.IsPaymentNotBound). Wherever this SDK presents a bare signature it sends the wallet header with it:
// Transport adds it to a request that carries one, BindPaymentSignature sets both on a request built by hand, and
// trellis.WithPaymentSignature does the same for one client call.

// Transport is an http.RoundTripper that pays x402 `exact` 402s: a request answered 402 is retried once with X-PAYMENT
// built from the requirement, a fresh blockhash and Signer. Use it as the client's transport, or PayPerCall to wrap an
// *http.Client for trellis.WithHTTPClient.
//
// A request that already carries a bare transaction signature in X-PAYMENT (a payment sent earlier) and no
// X-Wallet-Auth gets that header from Signer, the wallet that paid, before it is sent.
type Transport struct {
	// Base performs the requests; nil means http.DefaultTransport.
	Base http.RoundTripper
	// Signer is the paying wallet.
	Signer Signer
	// Host is the router's public host[:port], the host line of X-Wallet-Auth. Empty means the host of the request URL;
	// set it when the router is reached under another name than its public one.
	Host string
	// Now is the clock behind X-Wallet-Auth timestamps; nil means time.Now.
	Now func() time.Time
	// RPCURL is a Solana JSON-RPC endpoint used for getLatestBlockhash. Ignored when Blockhash is set.
	RPCURL string
	// Blockhash fetches a recent blockhash; nil uses LatestBlockhash over RPCURL with Base.
	Blockhash func(ctx context.Context) (string, error)
	// MaxAmount refuses to pay a requirement above this many USDC base units; 0 means no limit.
	MaxAmount uint64
	// Options tunes the built transaction (token program, destination account creation, compute budget), within what
	// the router's fee payer signs.
	Options ExactOptions
}

// WalletAuthHeader builds the X-Wallet-Auth value for req as it will be sent, signed by signer: its method, its
// request target (path and query string) and the hash the route binds for body, the JSON bytes it carries (nil for
// none); see trellis.WalletAuthRequestMessage. host is the router's public host[:port]; empty means the host of the
// request URL. It is trellis.WalletAuthRequestHeader for a Signer, so a wallet that signs elsewhere can authenticate.
func WalletAuthHeader(signer Signer, req *http.Request, body []byte, host string, now time.Time) (string, error) {
	if signer == nil {
		return "", errors.New("trellis/solana: a Signer is needed to sign " + trellis.HeaderWalletAuth)
	}
	ts := now.Unix()
	msg, err := trellis.WalletAuthRequestMessage(req, body, host, ts)
	if err != nil {
		return "", err
	}
	sig, err := signer.Sign([]byte(msg))
	if err != nil {
		return "", fmt.Errorf("trellis/solana: signing %s: %w", trellis.HeaderWalletAuth, err)
	}
	if len(sig) != 64 {
		return "", fmt.Errorf("trellis/solana: the signer returned %d bytes, want 64", len(sig))
	}
	return trellis.WalletAuthValue(signer.PublicKey().String(), ts, sig), nil
}

// BindPaymentSignature presents a payment that already landed on req: it sets X-PAYMENT to signature (the base58
// signature of the USDC transfer to the router's payTo) and X-Wallet-Auth to payer's signature over this same request
// (WalletAuthHeader). payer must be the wallet that made the transfer: the router redeems a bare signature only for
// its payer and answers `payment_not_bound_to_caller` otherwise. body is the JSON the request carries.
func BindPaymentSignature(req *http.Request, body []byte, signature string, payer Signer, host string, now time.Time) error {
	if !trellis.IsTransactionSignature(signature) {
		return fmt.Errorf("trellis/solana: %q is not a base58 transaction signature", signature)
	}
	auth, err := WalletAuthHeader(payer, req, body, host, now)
	if err != nil {
		return err
	}
	req.Header.Set(HeaderPayment, signature)
	req.Header.Set(trellis.HeaderWalletAuth, auth)
	return nil
}

// PayPerCall returns a copy of client whose transport pays 402s with signer, fetching blockhashes from rpcURL. A nil
// client starts from http.DefaultClient.
func PayPerCall(client *http.Client, signer Signer, rpcURL string) *http.Client {
	if client == nil {
		client = http.DefaultClient
	}
	c := *client
	c.Transport = &Transport{Base: client.Transport, Signer: signer, RPCURL: rpcURL}
	return &c
}

// ErrPaymentTooLarge is returned when a 402 asks for more than Transport.MaxAmount.
var ErrPaymentTooLarge = errors.New("trellis/solana: the 402 asks for more than the transport's MaxAmount")

func (t *Transport) base() http.RoundTripper {
	if t.Base != nil {
		return t.Base
	}
	return http.DefaultTransport
}

// RoundTrip implements http.RoundTripper.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.Signer == nil {
		return nil, errors.New("trellis/solana: Transport needs a Signer")
	}
	// The body is needed twice: once as sent, once on the paid retry.
	var body []byte
	if req.Body != nil && req.Body != http.NoBody {
		b, err := io.ReadAll(req.Body)
		req.Body.Close()
		if err != nil {
			return nil, err
		}
		body = b
	}
	first := req.Clone(req.Context())
	first.Body = bodyReader(body)
	first.GetBody = func() (io.ReadCloser, error) { return bodyReader(body), nil }
	if trellis.IsTransactionSignature(first.Header.Get(HeaderPayment)) && first.Header.Get(trellis.HeaderWalletAuth) == "" {
		// A bare signature of a landed payment: it is redeemed only with the paying wallet's signature over this request.
		clock := time.Now
		if t.Now != nil {
			clock = t.Now
		}
		auth, err := WalletAuthHeader(t.Signer, first, body, t.Host, clock())
		if err != nil {
			return nil, err
		}
		first.Header.Set(trellis.HeaderWalletAuth, auth)
	}
	res, err := t.base().RoundTrip(first)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusPaymentRequired || req.Header.Get(HeaderPayment) != "" {
		return res, nil
	}
	pr, err := ParsePaymentRequired(res)
	if err != nil {
		return res, nil // not an x402 402: hand it back as it is
	}
	exact, err := pr.Exact()
	if err != nil {
		return res, nil
	}
	res.Body.Close()
	if t.MaxAmount > 0 {
		if n, err := exact.AmountUnits(); err != nil || n > t.MaxAmount {
			return nil, fmt.Errorf("%w: %s units", ErrPaymentTooLarge, exact.MaxAmountRequired)
		}
	}
	blockhash, err := t.blockhash(req.Context())
	if err != nil {
		return nil, err
	}
	payment, err := BuildExactPayment(*exact, t.Signer, blockhash, &t.Options)
	if err != nil {
		return nil, err
	}
	retry := req.Clone(req.Context())
	retry.Body = bodyReader(body)
	retry.GetBody = func() (io.ReadCloser, error) { return bodyReader(body), nil }
	retry.Header.Set(HeaderPayment, payment.Header())
	// A signed payload needs no wallet signature, and the one the first attempt carried is spent: X-Wallet-Auth is
	// single use, so sending it again would be refused as a replay.
	retry.Header.Del(trellis.HeaderWalletAuth)
	return t.base().RoundTrip(retry)
}

func bodyReader(b []byte) io.ReadCloser {
	if b == nil {
		return http.NoBody
	}
	return io.NopCloser(bytes.NewReader(b))
}

func (t *Transport) blockhash(ctx context.Context) (string, error) {
	if t.Blockhash != nil {
		return t.Blockhash(ctx)
	}
	if t.RPCURL == "" {
		return "", errors.New("trellis/solana: Transport needs an RPCURL or a Blockhash function")
	}
	return LatestBlockhash(ctx, &http.Client{Transport: t.base()}, t.RPCURL)
}

// LatestBlockhash calls getLatestBlockhash (confirmed) on a Solana JSON-RPC endpoint and returns the blockhash. A nil
// client uses http.DefaultClient.
func LatestBlockhash(ctx context.Context, client *http.Client, rpcURL string) (string, error) {
	var out struct {
		Value struct {
			Blockhash string `json:"blockhash"`
		} `json:"value"`
	}
	if err := rpcCall(ctx, client, rpcURL, "getLatestBlockhash", []any{map[string]string{"commitment": "confirmed"}}, &out); err != nil {
		return "", err
	}
	if out.Value.Blockhash == "" {
		return "", errors.New("trellis/solana: getLatestBlockhash answered without a blockhash")
	}
	return out.Value.Blockhash, nil
}

// rpcCall posts one JSON-RPC request and decodes its result into out.
func rpcCall(ctx context.Context, client *http.Client, rpcURL, method string, params []any, out any) error {
	if client == nil {
		client = http.DefaultClient
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rpcURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("trellis/solana: %s: %w", method, err)
	}
	defer res.Body.Close()
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&env); err != nil {
		return fmt.Errorf("trellis/solana: %s: %w", method, err)
	}
	if env.Error != nil {
		return fmt.Errorf("trellis/solana: %s: rpc error %d: %s", method, env.Error.Code, env.Error.Message)
	}
	if len(env.Result) == 0 {
		return fmt.Errorf("trellis/solana: %s answered %d without a result", method, res.StatusCode)
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fmt.Errorf("trellis/solana: %s: %w", method, err)
	}
	return nil
}
