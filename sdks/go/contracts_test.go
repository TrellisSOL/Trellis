package trellis

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The contract fixtures (../fixtures/contracts.json) are produced by the router's own code: every message, signature
// and transaction in them comes from the module that verifies it on the server. The tests below read the file in
// place and require this SDK to reproduce it byte for byte. Nothing expected here is written by hand.

const contractFixturePath = "../fixtures/contracts.json"

type fixtureChallenge = WalletChallenge

type contractFixture struct {
	Keys   map[string]json.RawMessage `json:"keys"`
	Now    int64                      `json:"now"`
	Host   string                     `json:"host"`
	SignIn struct {
		Version              string           `json:"version"`
		ExpectedHost         string           `json:"expected_host"`
		Challenge            json.RawMessage  `json:"challenge"`
		Request              map[string]any   `json:"request"`
		Signature            string           `json:"signature"`
		OtherDomainChallenge fixtureChallenge `json:"other_domain_challenge"`
		RetiredV1Message     string           `json:"retired_v1_message"`
	} `json:"sign_in"`
	WalletAuth struct {
		Version     string `json:"version"`
		Address     string `json:"address"`
		EmptySHA256 string `json:"empty_sha256"`
		Cases       []struct {
			Name          string          `json:"name"`
			Method        string          `json:"method"`
			Host          string          `json:"host"`
			Path          string          `json:"path"`
			URL           string          `json:"url"`
			Timestamp     int64           `json:"timestamp"`
			SHA256        string          `json:"sha256"`
			Body          json.RawMessage `json:"body"`
			CanonicalJSON string          `json:"canonical_json"`
			HostID        string          `json:"host_id"`
			Resource      string          `json:"resource"`
			Message       string          `json:"message"`
			Signature     string          `json:"signature"`
			Header        string          `json:"header"`
		} `json:"cases"`
		RetiredV1Message string `json:"retired_v1_message"`
	} `json:"wallet_auth"`
	Tab struct {
		ProgramID string `json:"program_id"`
		Session   string `json:"session"`
		Tab       string `json:"tab"`
		Voucher   struct {
			Domain string `json:"domain"`
			Length int    `json:"length"`
			Layout []struct {
				Field  string `json:"field"`
				Offset int    `json:"offset"`
				Length int    `json:"length"`
			} `json:"layout"`
			Cases         []fixtureVoucher          `json:"cases"`
			NotForThisTab map[string]fixtureVoucher `json:"not_for_this_tab"`
		} `json:"voucher"`
	} `json:"tab"`
	Closure struct {
		KeyHash                   string          `json:"key_hash"`
		KeyAddress                string          `json:"key_address"`
		Request                   map[string]any  `json:"request"`
		Response                  json.RawMessage `json:"response"`
		ResponseAlreadyRegistered json.RawMessage `json:"response_already_registered"`
		RefusedWithRefundTo       fixtureEnvelope `json:"refused_with_refund_to"`
		fixtureKeySigned
		Deposit struct {
			Request  map[string]any  `json:"request"`
			Response json.RawMessage `json:"response"`
		} `json:"deposit"`
		Cancel struct {
			Request  map[string]any  `json:"request"`
			Response json.RawMessage `json:"response"`
			fixtureKeySigned
			Errors map[string]fixtureEnvelope `json:"errors"`
		} `json:"cancel"`
		Release struct {
			Request             map[string]any             `json:"request"`
			Response            json.RawMessage            `json:"response"`
			KeyDisabledResponse json.RawMessage            `json:"key_disabled_response"`
			Errors              map[string]fixtureEnvelope `json:"errors"`
		} `json:"release"`
		RefundDestination struct {
			Request                  map[string]any             `json:"request"`
			Response                 json.RawMessage            `json:"response"`
			Signers                  []string                   `json:"signers"`
			MessageBase64            string                     `json:"message_base64"`
			InstructionCount         int                        `json:"instruction_count"`
			SignedTransaction        string                     `json:"signed_transaction"`
			DepositorSignatureBase58 string                     `json:"depositor_signature_base58"`
			Errors                   map[string]fixtureEnvelope `json:"errors"`
		} `json:"refund_destination"`
		List struct {
			Statuses       []string        `json:"statuses"`
			Reasons        []string        `json:"reasons"`
			RefundStatuses []string        `json:"refund_statuses"`
			Response       json.RawMessage `json:"response"`
		} `json:"list"`
	} `json:"closure"`
	Errors map[string]json.RawMessage `json:"errors"`
}

type fixtureVoucher struct {
	CumulativeUsed  string            `json:"cumulative_used"`
	Seq             string            `json:"seq"`
	ProgramID       string            `json:"program_id"`
	CreatedAt       string            `json:"created_at"`
	MessageHex      string            `json:"message_hex"`
	MessageBase64   string            `json:"message_base64"`
	SignatureBase58 string            `json:"signature_base58"`
	SignatureBase64 string            `json:"signature_base64"`
	Headers         map[string]string `json:"headers"`
}

// fixtureKeySigned describes a transaction the router signed as the API key (a closure or its cancellation): who signs
// in which slot, the key's signature as issued, and the transaction after the payer signed it.
type fixtureKeySigned struct {
	Payer                string   `json:"payer"`
	Signers              []string `json:"signers"`
	KeySignatureIndex    int      `json:"key_signature_index"`
	KeySignatureBase58   string   `json:"key_signature_base58"`
	MessageBase64        string   `json:"message_base64"`
	InstructionCount     int      `json:"instruction_count"`
	SignedTransaction    string   `json:"signed_transaction"`
	PayerSignatureBase58 string   `json:"payer_signature_base58"`
}

// fixtureEnvelope is an error answer of one route: the request that draws it (when the fixture gives one), the status
// and the body as the router sends it.
type fixtureEnvelope struct {
	Request map[string]any  `json:"request"`
	Status  int             `json:"status"`
	Body    json.RawMessage `json:"body"`
}

type fixtureError struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

var (
	contractOnce sync.Once
	contractData contractFixture
	contractErr  error
)

func loadContracts(t *testing.T) *contractFixture {
	t.Helper()
	contractOnce.Do(func() {
		raw, err := os.ReadFile(contractFixturePath)
		if err != nil {
			contractErr = err
			return
		}
		contractErr = json.Unmarshal(raw, &contractData)
	})
	if contractErr != nil {
		t.Fatalf("reading %s: %v", contractFixturePath, contractErr)
	}
	return &contractData
}

// fixtureKey derives a test key from its label: the ed25519 key whose seed is SHA-256(seed_prefix + label). It checks
// the derivation against the address the fixture gives. No seed is stored anywhere.
func (f *contractFixture) key(t *testing.T, name string) ed25519.PrivateKey {
	t.Helper()
	var prefix string
	if err := json.Unmarshal(f.Keys["seed_prefix"], &prefix); err != nil {
		t.Fatal(err)
	}
	var entry struct{ Label, Address string }
	if err := json.Unmarshal(f.Keys[name], &entry); err != nil || entry.Label == "" {
		t.Fatalf("fixture key %q: %v", name, err)
	}
	seed := sha256.Sum256([]byte(prefix + entry.Label))
	priv := ed25519.NewKeyFromSeed(seed[:])
	if got := Base58Encode(priv.Public().(ed25519.PublicKey)); got != entry.Address {
		t.Fatalf("fixture key %q derives to another address than the fixture names", name)
	}
	return priv
}

func (f *contractFixture) apiError(t *testing.T, name string) fixtureError {
	t.Helper()
	var e fixtureError
	if err := json.Unmarshal(f.Errors[name], &e); err != nil || e.Status == 0 {
		t.Fatalf("fixture error %q: %v", name, err)
	}
	return e
}

func mustAddr(t *testing.T, s string) [32]byte {
	t.Helper()
	a, err := Base58Decode32(s)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// memRouter is a router that lives in the client's transport, so a test can talk to the fixture's own URLs
// (https://router.example/...) and see exactly what was sent.
type memRouter struct {
	mu     sync.Mutex
	calls  []memCall
	routes map[string]func(memCall) (int, string)
}

type memCall struct {
	Method string
	// URL is the full request URL; Target is the request target as sent (path and query).
	URL, Target string
	Header      http.Header
	Raw         []byte
}

func (m *memRouter) RoundTrip(r *http.Request) (*http.Response, error) {
	call := memCall{Method: r.Method, URL: r.URL.String(), Target: r.URL.RequestURI(), Header: r.Header.Clone()}
	if r.Body != nil {
		call.Raw, _ = io.ReadAll(r.Body)
		r.Body.Close()
	}
	m.mu.Lock()
	m.calls = append(m.calls, call)
	h := m.routes[r.Method+" "+r.URL.EscapedPath()]
	m.mu.Unlock()
	status, body := 404, `{"error":{"code":404,"message":"no route","type":"not_found"}}`
	if h != nil {
		status, body = h(call)
	}
	return &http.Response{StatusCode: status, Status: strconv.Itoa(status), Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
}

func (m *memRouter) on(route string, h func(memCall) (int, string)) { m.routes[route] = h }

func (m *memRouter) reply(route string, status int, body string) {
	m.on(route, func(memCall) (int, string) { return status, body })
}

func (m *memRouter) count() int { m.mu.Lock(); defer m.mu.Unlock(); return len(m.calls) }

func (m *memRouter) last(t *testing.T) memCall {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.calls) == 0 {
		t.Fatal("the router saw no request")
	}
	return m.calls[len(m.calls)-1]
}

// newMem builds a client for baseURL whose requests end in a memRouter. The clock is fixed at unix seconds.
func newMem(baseURL string, unix int64, opts ...Option) (*memRouter, *Client) {
	m := &memRouter{routes: map[string]func(memCall) (int, string){}}
	c := NewClient(append([]Option{WithAPIKey(""), WithBaseURL(baseURL), WithHTTPClient(&http.Client{Transport: m})}, opts...)...)
	c.now = func() time.Time { return time.Unix(unix, 0) }
	return m, c
}

func jsonEqual(t *testing.T, got []byte, want any) bool {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("not JSON: %q", got)
	}
	wb, _ := json.Marshal(want)
	_ = json.Unmarshal(wb, &w)
	return reflect.DeepEqual(g, w)
}

func TestContractFixtureKeys(t *testing.T) {
	f := loadContracts(t)
	for _, name := range []string{"wallet", "session", "fee_payer", "payee", "refund_to", "second_depositor"} {
		f.key(t, name)
	}
}

// 1. Wallet sign-in v2: the router writes the message, the client checks whose it is, signs it as returned.
func TestContractSignIn(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	address := Base58Encode(wallet.Public().(ed25519.PublicKey))
	var ch WalletChallenge
	if err := json.Unmarshal(f.SignIn.Challenge, &ch); err != nil {
		t.Fatal(err)
	}
	if WalletSignInVersion != f.SignIn.Version || ch.Version != f.SignIn.Version {
		t.Fatalf("version %q / %q, fixture %q", WalletSignInVersion, ch.Version, f.SignIn.Version)
	}
	if err := ch.Check(f.SignIn.ExpectedHost, address); err != nil {
		t.Fatalf("the router's own challenge was refused: %v", err)
	}
	sig, err := SignWalletChallenge(wallet, &ch, f.SignIn.ExpectedHost)
	if err != nil || sig != f.SignIn.Signature {
		t.Fatalf("signature %q (%v), fixture %q", sig, err, f.SignIn.Signature)
	}

	// Through the client: challenge, check, sign, exchange. The base URL is the router's, so the domain needs no option.
	m, c := newMem("https://"+f.SignIn.ExpectedHost+"/api/v1", f.Now)
	if c.WalletHost() != f.SignIn.ExpectedHost {
		t.Fatalf("WalletHost %q", c.WalletHost())
	}
	m.reply("POST /api/v1/auth/wallet/challenge", 200, `{"data":`+string(f.SignIn.Challenge)+`}`)
	m.reply("POST /api/v1/auth/wallet", 201, `{"data":{"hash":"fixture-key-hash","name":"SDK fixture key","label":"sk-test"},"key":"sk-test"}`)
	name, _ := f.SignIn.Request["name"].(string)
	key, err := c.SignInWithWallet(context.Background(), wallet, SignInOptions{Name: name})
	if err != nil {
		t.Fatal(err)
	}
	if key.Key != "sk-test" || key.Hash != "fixture-key-hash" || key.Name != name || len(key.Data) == 0 {
		t.Fatalf("key: %+v", key)
	}
	if m.count() != 2 {
		t.Fatalf("%d requests", m.count())
	}
	if !jsonEqual(t, m.calls[0].Raw, map[string]string{"address": address}) {
		t.Fatalf("challenge request %s", m.calls[0].Raw)
	}
	// The exchange is the fixture's request, member for member: no client-built message, no timestamp.
	if !jsonEqual(t, m.calls[1].Raw, f.SignIn.Request) {
		t.Fatalf("sign-in request\n got  %s\n want %v", m.calls[1].Raw, f.SignIn.Request)
	}
	if bytes.Contains(m.calls[1].Raw, []byte("timestamp")) {
		t.Fatal("the sign-in request carries a timestamp")
	}

	// A client that reaches the router under another name passes the domain it expects.
	m2, c2 := newMem("http://127.0.0.1:9", f.Now, WithWalletHost(strings.ToUpper(f.SignIn.ExpectedHost)))
	m2.reply("POST /api/v1/auth/wallet/challenge", 200, `{"data":`+string(f.SignIn.Challenge)+`}`)
	m2.reply("POST /api/v1/auth/wallet", 201, `{"data":{},"key":"sk-test"}`)
	if _, err := c2.SignInWithWallet(context.Background(), wallet, SignInOptions{}); err != nil {
		t.Fatalf("WithWalletHost: %v", err)
	}
	if !jsonEqual(t, m2.last(t).Raw, map[string]any{"address": address, "nonce": ch.Nonce, "signature": f.SignIn.Signature, "message": ch.Message}) {
		t.Fatalf("request without a name: %s", m2.last(t).Raw)
	}
	// Without it the challenge is for another host than the one the client talks to: refused, nothing exchanged.
	m3, c3 := newMem("http://127.0.0.1:9", f.Now)
	m3.reply("POST /api/v1/auth/wallet/challenge", 200, `{"data":`+string(f.SignIn.Challenge)+`}`)
	if _, err := c3.SignInWithWallet(context.Background(), wallet, SignInOptions{}); !errors.Is(err, ErrChallengeRefused) || m3.count() != 1 {
		t.Fatalf("a challenge for another host: %v (%d requests)", err, m3.count())
	}
	if _, err := c3.SignInWithWallet(context.Background(), wallet, SignInOptions{Domain: f.SignIn.ExpectedHost}); err == nil || errors.Is(err, ErrChallengeRefused) {
		t.Fatalf("SignInOptions.Domain should pass the check and fail at the exchange (no route): %v", err)
	}
}

func TestContractSignInRefusals(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	address := Base58Encode(wallet.Public().(ed25519.PublicKey))
	var ch WalletChallenge
	if err := json.Unmarshal(f.SignIn.Challenge, &ch); err != nil {
		t.Fatal(err)
	}
	refused := func(what string, c WalletChallenge, domain string, key ed25519.PrivateKey) {
		t.Helper()
		if err := c.Check(domain, Base58Encode(key.Public().(ed25519.PublicKey))); !errors.Is(err, ErrChallengeRefused) {
			t.Errorf("%s: Check = %v", what, err)
		}
		if sig, err := SignWalletChallenge(key, &c, domain); !errors.Is(err, ErrChallengeRefused) || sig != "" {
			t.Errorf("%s: signed (%v)", what, err)
		}
	}
	// The same challenge issued by another site, relayed to a client that talks to the router.
	other := f.SignIn.OtherDomainChallenge
	if other.Domain == f.SignIn.ExpectedHost || other.Message == "" {
		t.Fatal("the fixture's other-domain challenge is not one")
	}
	refused("another site's challenge", other, f.SignIn.ExpectedHost, wallet)
	// ... and dressed up with the router's domain while the message still names the other site.
	dressed := other
	dressed.Domain = f.SignIn.ExpectedHost
	refused("another site's message under the router's domain", dressed, f.SignIn.ExpectedHost, wallet)
	// The router's message under another domain field.
	swapped := ch
	swapped.Domain = other.Domain
	refused("the router's message under another domain", swapped, f.SignIn.ExpectedHost, wallet)
	// A challenge for another wallet.
	refused("another wallet's challenge", ch, f.SignIn.ExpectedHost, f.key(t, "session"))
	// The retired v1 text: it names no site, so nothing in this SDK signs it.
	v1 := ch
	v1.Message = f.SignIn.RetiredV1Message
	refused("the retired v1 message", v1, f.SignIn.ExpectedHost, wallet)
	v1.Version = "trellis:wallet:v1"
	refused("a v1 challenge", v1, f.SignIn.ExpectedHost, wallet)
	// Another nonce than the message carries, no domain to compare with, no challenge at all.
	renonced := ch
	renonced.Nonce = strings.Repeat("0", len(ch.Nonce))
	refused("a nonce the message does not carry", renonced, f.SignIn.ExpectedHost, wallet)
	refused("no expected domain", ch, "", wallet)
	if err := (*WalletChallenge)(nil).Check(f.SignIn.ExpectedHost, address); !errors.Is(err, ErrChallengeRefused) {
		t.Errorf("nil challenge: %v", err)
	}
	// What the SDK does sign is not a signature over the retired text.
	sig, _ := Base58Decode(f.SignIn.Signature)
	if ed25519.Verify(wallet.Public().(ed25519.PublicKey), []byte(f.SignIn.RetiredV1Message), sig) {
		t.Fatal("the sign-in signature verifies over the retired v1 message")
	}

	// Through the client: the other site's challenge is never signed and never exchanged.
	m, c := newMem("https://"+f.SignIn.ExpectedHost, f.Now)
	otherJSON, _ := json.Marshal(other)
	m.reply("POST /api/v1/auth/wallet/challenge", 200, `{"data":`+string(otherJSON)+`}`)
	m.reply("POST /api/v1/auth/wallet", 201, `{"data":{},"key":"sk-test"}`)
	if _, err := c.SignInWithWallet(context.Background(), wallet, SignInOptions{}); !errors.Is(err, ErrChallengeRefused) {
		t.Fatalf("client signed another site's challenge: %v", err)
	}
	if m.count() != 1 {
		t.Fatalf("%d requests: the refused challenge was exchanged", m.count())
	}
}

// 2. X-Wallet-Auth v2: one signature for one method, host, path and bound hash.
func TestContractWalletAuth(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	pub := wallet.Public().(ed25519.PublicKey)
	if WalletAuthVersion != f.WalletAuth.Version || Base58Encode(pub) != f.WalletAuth.Address {
		t.Fatalf("version %q, address %q", WalletAuthVersion, Base58Encode(pub))
	}
	if len(f.WalletAuth.Cases) < 7 {
		t.Fatalf("only %d cases", len(f.WalletAuth.Cases))
	}
	for _, c := range f.WalletAuth.Cases {
		var body []byte
		if len(c.Body) > 0 && string(c.Body) != "null" {
			body = c.Body
		}
		now := time.Unix(c.Timestamp, 0)
		// The hash the route binds, from the body as the fixture gives it.
		sum, err := WalletAuthHash(c.Method, c.Path, body)
		if err != nil || sum != c.SHA256 {
			t.Errorf("%s: hash %s (%v), fixture %s", c.Name, sum, err, c.SHA256)
			continue
		}
		if c.CanonicalJSON != "" {
			got, err := canonicalJSONWithout(body, "stream", "stream_options")
			if c.Name != "chat_request" {
				got, err = CanonicalJSON(body)
			}
			if err != nil || string(got) != c.CanonicalJSON {
				t.Errorf("%s: canonical json\n got  %s\n want %s (%v)", c.Name, got, c.CanonicalJSON, err)
			}
			if sha256Hex(got) != c.SHA256 {
				t.Errorf("%s: sha256 of the canonical json differs", c.Name)
			}
		}
		if c.Resource != "" && sha256Hex([]byte(c.Resource)) != c.SHA256 {
			t.Errorf("%s: the fixture's resource does not hash to its sha256", c.Name)
		}
		msg, err := WalletAuthMessage(c.Method, c.Host, c.Path, c.Timestamp, sum)
		if err != nil || msg != c.Message {
			t.Errorf("%s: message %q (%v)\n want %q", c.Name, msg, err, c.Message)
		}
		// Method and host are written in upper and lower case whatever the caller passes.
		if m2, _ := WalletAuthMessage(strings.ToLower(c.Method), strings.ToUpper(c.Host), c.Path, c.Timestamp, strings.ToUpper(sum)); m2 != c.Message {
			t.Errorf("%s: case of method / host / hash changes the message", c.Name)
		}
		h, err := WalletAuthHeader(wallet, c.Method, c.Host, c.Path, sum, now)
		if err != nil || h != c.Header {
			t.Errorf("%s: header %q (%v)\n want %q", c.Name, h, err, c.Header)
		}
		parts := strings.Split(h, ":")
		if len(parts) != 3 || parts[2] != c.Signature {
			t.Errorf("%s: signature %q, fixture %q", c.Name, parts, c.Signature)
		}
		// From a request as it is sent: method, URL and body alone give the same header (the host comes from the URL).
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequest(c.Method, c.URL, rdr)
		if err != nil {
			t.Fatal(err)
		}
		if req.URL.RequestURI() != c.Path {
			t.Errorf("%s: request target %q, fixture path %q", c.Name, req.URL.RequestURI(), c.Path)
		}
		rh, err := WalletAuthRequestHeader(wallet, req, body, "", now)
		if err != nil || rh != c.Header {
			t.Errorf("%s: request header %q (%v)\n want %q", c.Name, rh, err, c.Header)
		}
		rm, err := WalletAuthRequestMessage(req, body, strings.ToUpper(c.Host), c.Timestamp)
		if err != nil || rm != c.Message {
			t.Errorf("%s: request message with an explicit host: %q (%v)", c.Name, rm, err)
		}
		sig, _ := Base58Decode(c.Signature)
		if WalletAuthValue(Base58Encode(pub), c.Timestamp, sig) != c.Header {
			t.Errorf("%s: WalletAuthValue", c.Name)
		}

		// Through the client: the header it attaches is the fixture's, for the request it actually sent.
		base := strings.TrimSuffix(c.URL, c.Path)
		m, cl := newMem(base, c.Timestamp, WithWalletKey(wallet))
		m.reply(c.Method+" "+strings.SplitN(c.Path, "?", 2)[0], 200, `{}`)
		var sent any
		if body != nil {
			sent = json.RawMessage(body)
		}
		var out json.RawMessage
		if _, err := cl.doJSON(context.Background(), c.Method, c.Path, sent, &out, nil); err != nil {
			t.Errorf("%s: client: %v", c.Name, err)
			continue
		}
		got := m.last(t)
		if got.Header.Get(HeaderWalletAuth) != c.Header {
			t.Errorf("%s: the client sent %q\n want %q", c.Name, got.Header.Get(HeaderWalletAuth), c.Header)
		}
		if got.URL != c.URL || got.Target != c.Path || got.Method != c.Method || got.Header.Get("Authorization") != "" {
			t.Errorf("%s: the client sent %s %s", c.Name, got.Method, got.URL)
		}
	}
}

func TestContractWalletAuthChatThroughClient(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	for _, c := range f.WalletAuth.Cases {
		if c.Name != "chat_request" {
			continue
		}
		// The fixture's body as a ChatRequest: the named fields, and the rest as Extra.
		var req ChatRequest
		if err := json.Unmarshal(c.Body, &req); err != nil {
			t.Fatal(err)
		}
		var all map[string]any
		_ = json.Unmarshal(c.Body, &all)
		req.Extra = map[string]any{"usage": all["usage"]}
		streamOptions := all["stream_options"]
		if !req.Stream || streamOptions == nil || req.Temperature == nil || req.TopP == nil || req.MaxTokens == nil {
			t.Fatalf("the fixture's chat body lost its shape: %s", c.Body)
		}
		m, cl := newMem(strings.TrimSuffix(c.URL, c.Path), c.Timestamp, WithWalletKey(wallet))
		m.reply("POST "+c.Path, 200, `{"id":"gen-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`)

		// Streamed, with stream_options: the signature does not cover the stream flags.
		streamed := req
		streamed.Extra = map[string]any{"usage": all["usage"], "stream_options": streamOptions}
		s, err := cl.ChatStream(context.Background(), streamed)
		if err != nil {
			t.Fatal(err)
		}
		s.Close()
		got := m.last(t)
		if !jsonEqual(t, got.Raw, all) {
			t.Fatalf("the streamed body is not the fixture's:\n got  %s\n want %s", got.Raw, c.Body)
		}
		if got.Header.Get(HeaderWalletAuth) != c.Header {
			t.Fatalf("streamed: header %q\n want %q", got.Header.Get(HeaderWalletAuth), c.Header)
		}
		// Not streamed: the same request, the same bound hash, the same header.
		plain := req
		plain.Stream = false
		if _, err := cl.Chat(context.Background(), plain); err != nil {
			t.Fatal(err)
		}
		got = m.last(t)
		if bytes.Contains(got.Raw, []byte(`"stream"`)) {
			t.Fatalf("stream sent on Chat: %s", got.Raw)
		}
		if got.Header.Get(HeaderWalletAuth) != c.Header {
			t.Fatalf("not streamed: header %q\n want %q", got.Header.Get(HeaderWalletAuth), c.Header)
		}
		// A per-call key signs the same way, and any other member of the body changes what is signed.
		_, anon := newMem(strings.TrimSuffix(c.URL, c.Path), c.Timestamp)
		anon.http = cl.http
		if _, err := anon.Chat(context.Background(), plain, WithRequestWalletKey(wallet)); err != nil || m.last(t).Header.Get(HeaderWalletAuth) != c.Header {
			t.Fatalf("WithRequestWalletKey: %v", err)
		}
		changed := plain
		changed.User = "someone"
		if _, err := cl.Chat(context.Background(), changed); err != nil || m.last(t).Header.Get(HeaderWalletAuth) == c.Header {
			t.Fatalf("a changed body kept its signature (%v)", err)
		}
		return
	}
	t.Fatal("no chat_request case in the fixture")
}

func TestContractWalletAuthRetiredAndEdges(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	pub := wallet.Public().(ed25519.PublicKey)
	first := f.WalletAuth.Cases[0]
	// The retired v1 text is not what any signature here covers.
	if first.Message == f.WalletAuth.RetiredV1Message || !strings.HasPrefix(first.Message, WalletAuthVersion+"\n") {
		t.Fatal("the v2 message is the retired one")
	}
	for _, c := range f.WalletAuth.Cases {
		sig, _ := Base58Decode(c.Signature)
		if !ed25519.Verify(pub, []byte(c.Message), sig) || ed25519.Verify(pub, []byte(f.WalletAuth.RetiredV1Message), sig) {
			t.Fatalf("%s: the signature must cover the v2 message and only it", c.Name)
		}
	}
	if sum, _ := WalletAuthHash("GET", "/api/v1/refunds", nil); sum != f.WalletAuth.EmptySHA256 {
		t.Fatalf("empty hash %s", sum)
	}
	// Default ports are left out of the host, as a URL's host leaves them out; other ports stay.
	for url, want := range map[string]string{
		"https://" + first.Host + ":443" + first.Path:         first.Header,
		"https://" + strings.ToUpper(first.Host) + first.Path: first.Header,
	} {
		req, _ := http.NewRequest(first.Method, url, nil)
		if h, err := WalletAuthRequestHeader(wallet, req, nil, "", time.Unix(first.Timestamp, 0)); err != nil || h != want {
			t.Errorf("%s: %q (%v)", url, h, err)
		}
	}
	req, _ := http.NewRequest(first.Method, "http://"+first.Host+":443"+first.Path, nil)
	if h, _ := WalletAuthRequestHeader(wallet, req, nil, "", time.Unix(first.Timestamp, 0)); h == first.Header {
		t.Error("port 443 on http is not a default port and must be signed")
	}
	// The host resource hash follows the id in the path, not the query; other paths under /hosts/ bind the empty body.
	for _, c := range f.WalletAuth.Cases {
		if c.HostID == "" {
			continue
		}
		if sum, _ := WalletAuthHash("GET", c.Path+"?x=1", nil); sum != c.SHA256 {
			t.Errorf("query changed the host resource hash")
		}
		if sum, _ := WalletAuthHash("GET", "/api/v1/hosts/"+encodeURIComponent(c.HostID), nil); sum != c.SHA256 {
			t.Errorf("encodeURIComponent(%q) does not give the fixture's path", c.HostID)
		}
		if sum, _ := WalletAuthHash("GET", c.Path+"/earnings", nil); sum != f.WalletAuth.EmptySHA256 {
			t.Errorf("a deeper path took the host resource hash")
		}
		if sum, _ := WalletAuthHash("POST", c.Path, nil); sum != f.WalletAuth.EmptySHA256 {
			t.Errorf("a POST took the host resource hash")
		}
	}
	// Fields that would let two requests share a signature are refused.
	for _, bad := range [][3]string{{"GET\nPOST", "h", "/p"}, {"GET", "h\r\nx", "/p"}, {"GET", "h", "/p\n/q"}, {"", "h", "/p"}, {"GET", "", "/p"}, {"GET", "h", "p"}} {
		if _, err := WalletAuthMessage(bad[0], bad[1], bad[2], 1, f.WalletAuth.EmptySHA256); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if _, err := WalletAuthMessage("GET", "h", "/p", 1, "not-a-hash"); err == nil {
		t.Error("accepted a bad hash")
	}
	if _, err := WalletAuthHash("POST", "/api/v1/chat/completions", []byte("{not json")); err == nil {
		t.Error("hashed a body that is not JSON")
	}
	if _, err := WalletAuthHeader(wallet[:10], "GET", "h", "/p", f.WalletAuth.EmptySHA256, time.Unix(1, 0)); err == nil {
		t.Error("signed with a short key")
	}
}

// 3. A bare transaction signature in X-PAYMENT goes out with X-Wallet-Auth; without it the router answers 401.
func TestContractPaymentSignature(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	pub := wallet.Public().(ed25519.PublicKey)
	fe := f.apiError(t, "payment_not_bound_to_caller")
	var env struct {
		Error struct {
			Type     string
			Metadata struct{ Tx string }
		}
	}
	if err := json.Unmarshal(fe.Body, &env); err != nil || env.Error.Type != ErrorTypePaymentNotBound || env.Error.Metadata.Tx == "" {
		t.Fatalf("fixture: %s", fe.Body)
	}
	signature := env.Error.Metadata.Tx
	if !IsTransactionSignature(signature) || IsTransactionSignature("eyJ4NDAyVmVyc2lvbiI6MX0=") || IsTransactionSignature(signature+strings.Repeat("5", 10)) {
		t.Fatal("IsTransactionSignature")
	}
	chat := ChatRequest{Model: "example/model", Messages: []Message{UserMessage("hi")}}
	m, c := newMem("https://"+f.Host, f.Now)
	// The router as the fixture describes it: a bare signature without the wallet header is 401.
	m.on("POST /api/v1/chat/completions", func(call memCall) (int, string) {
		if IsTransactionSignature(call.Header.Get(HeaderPayment)) && call.Header.Get(HeaderWalletAuth) == "" {
			return fe.Status, string(fe.Body)
		}
		return 200, `{"id":"gen-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`
	})
	// Presented by hand, without the wallet: refused, and recognisable.
	_, err := c.Chat(context.Background(), chat, WithRequestHeader(HeaderPayment, signature))
	var apiErr *APIError
	if !IsPaymentNotBound(err) || !errors.As(err, &apiErr) || apiErr.StatusCode != 401 || apiErr.Type != ErrorTypePaymentNotBound || apiErr.Metadata["tx"] != signature {
		t.Fatalf("payment_not_bound_to_caller: %v", err)
	}
	if IsPaymentNotBound(errors.New("other")) || IsPaymentNotBound(nil) || IsCreditsClosing(err) {
		t.Fatal("IsPaymentNotBound on other errors")
	}
	// With the SDK's option: X-PAYMENT and the wallet's signature over that same request.
	if _, err := c.Chat(context.Background(), chat, WithPaymentSignature(signature, wallet)); err != nil {
		t.Fatal(err)
	}
	got := m.last(t)
	if got.Header.Get(HeaderPayment) != signature {
		t.Fatalf("X-PAYMENT %q", got.Header.Get(HeaderPayment))
	}
	sum, err := WalletAuthHash(got.Method, got.Target, got.Raw)
	if err != nil {
		t.Fatal(err)
	}
	want, err := WalletAuthMessage("POST", f.Host, "/api/v1/chat/completions", f.Now, sum)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(got.Header.Get(HeaderWalletAuth), ":")
	if len(parts) != 3 || parts[0] != Base58Encode(pub) || parts[1] != strconv.FormatInt(f.Now, 10) {
		t.Fatalf("X-Wallet-Auth %q", got.Header.Get(HeaderWalletAuth))
	}
	sig, _ := Base58Decode(parts[2])
	if !ed25519.Verify(pub, []byte(want), sig) {
		t.Fatal("X-Wallet-Auth does not cover the request that carries the payment")
	}
	// The option cannot be used to present a signature without the wallet, or something that is not a signature.
	before := m.count()
	if _, err := c.Chat(context.Background(), chat, WithPaymentSignature(signature, nil)); err == nil {
		t.Fatal("a payment signature without the wallet was sent")
	}
	if _, err := c.Chat(context.Background(), chat, WithPaymentSignature("not a signature", wallet)); err == nil {
		t.Fatal("a malformed signature was sent")
	}
	if m.count() != before {
		t.Fatal("a refused option still reached the router")
	}
}

// fixtureDiff compares an SDK value (marshalled back to JSON) with the fixture's JSON for the same answer and returns
// the path of the first thing the SDK value does not carry, or "". Every field the router sends has to be there with
// the same value; a null in the fixture is the zero value of the SDK's field.
func fixtureDiff(got, want any, path string) string {
	switch w := want.(type) {
	case nil:
		if got == nil {
			return ""
		}
		v := reflect.ValueOf(got)
		if v.IsZero() || ((v.Kind() == reflect.Map || v.Kind() == reflect.Slice) && v.Len() == 0) {
			return ""
		}
		return path
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return path
		}
		for k, wv := range w {
			gv, has := g[k]
			if !has {
				return path + "." + k
			}
			if d := fixtureDiff(gv, wv, path+"."+k); d != "" {
				return d
			}
		}
		return ""
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return path
		}
		for i := range w {
			if d := fixtureDiff(g[i], w[i], path+"["+strconv.Itoa(i)+"]"); d != "" {
				return d
			}
		}
		return ""
	}
	if !reflect.DeepEqual(got, want) {
		return path
	}
	return ""
}

// carriesFixture fails unless decoded (what the SDK returned) carries every field of raw (what the router sent).
func carriesFixture(t *testing.T, what string, decoded any, raw json.RawMessage) {
	t.Helper()
	b, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &w); err != nil || w == nil {
		t.Fatalf("%s: fixture %s (%v)", what, raw, err)
	}
	if d := fixtureDiff(g, w, what); d != "" {
		t.Fatalf("the SDK's value does not carry the fixture's %s\n got  %s\n want %s", d, b, raw)
	}
}

func (f *contractFixture) address(t *testing.T, name string) string {
	t.Helper()
	return Base58Encode(f.key(t, name).Public().(ed25519.PublicKey))
}

// wantAPIError requires err to be the fixture's error envelope, surfaced as *APIError with its status, code, machine
// reason and message.
func wantAPIError(t *testing.T, what string, err error, env fixtureEnvelope, reason string) *APIError {
	t.Helper()
	var want struct {
		Error struct {
			Code          int
			Message, Type string
		}
	}
	if e := json.Unmarshal(env.Body, &want); e != nil || env.Status == 0 || want.Error.Type != reason || want.Error.Message == "" {
		t.Fatalf("%s: fixture envelope %d %s", what, env.Status, env.Body)
	}
	var e *APIError
	if !errors.As(err, &e) || e.StatusCode != env.Status || e.Code != want.Error.Code || e.Type != reason || e.Message != want.Error.Message {
		t.Fatalf("%s: %v", what, err)
	}
	if _, ok := RetryAfter(err); ok {
		t.Fatalf("%s: not an error to wait out", what)
	}
	return e
}

// refusingRefundTo answers like the router: a close or cancel request that names a destination is refused with the
// fixture's 400 `refund_destination_fixed`; any other gets status and data.
func (f *contractFixture) refusingRefundTo(status int, data json.RawMessage) func(memCall) (int, string) {
	return func(call memCall) (int, string) {
		var body map[string]any
		_ = json.Unmarshal(call.Raw, &body)
		if _, named := body["refund_to"]; named {
			return f.Closure.RefusedWithRefundTo.Status, string(f.Closure.RefusedWithRefundTo.Body)
		}
		return status, `{"data":` + string(data) + `}`
	}
}

// payerSigned is a transaction the router signed as the key, for a payer to sign: a closure or its cancellation.
type payerSigned interface {
	SignAsPayer(ed25519.PrivateKey) (string, error)
	SignAsPayerWith(ed25519.PublicKey, func([]byte) ([]byte, error)) (string, error)
}

// checkKeySigned holds a closure or a cancellation to the contract of a transaction the router signed as the key: the
// payer (the fixture's wallet) adds its signature in slot 0 and reproduces the fixture's signed transaction byte for
// byte; the key's signature and the message arrive unchanged; anybody else, and any transaction whose key signature is
// not in place, is refused. with builds the SDK value for a transaction and the payer the answer names.
func checkKeySigned(t *testing.T, f *contractFixture, what string, lay fixtureKeySigned, transaction string, with func(transaction, payer string) payerSigned) {
	t.Helper()
	wallet, session := f.key(t, "wallet"), f.key(t, "session")
	walletPub := wallet.Public().(ed25519.PublicKey)
	byWallet := func(msg []byte) ([]byte, error) { return ed25519.Sign(wallet, msg), nil }
	if lay.Payer != Base58Encode(walletPub) || lay.InstructionCount != 1 || lay.SignedTransaction == "" {
		t.Fatalf("%s: fixture layout %+v", what, lay)
	}
	it := with(transaction, lay.Payer)

	// The payer signs: exactly the fixture's signed transaction.
	signed, err := it.SignAsPayer(wallet)
	if err != nil {
		t.Fatalf("%s: %v", what, err)
	}
	if signed != lay.SignedTransaction {
		t.Fatalf("%s: signed transaction\n got  %s\n want %s", what, signed, lay.SignedTransaction)
	}
	before, err := parseSignedTx(transaction)
	if err != nil {
		t.Fatal(err)
	}
	after, err := parseSignedTx(signed)
	if err != nil {
		t.Fatal(err)
	}
	k := lay.KeySignatureIndex
	if len(after.signers) != len(lay.Signers) || k < 1 || k >= len(after.signers) {
		t.Fatalf("%s: %d signers, key index %d", what, len(after.signers), k)
	}
	for i, s := range lay.Signers {
		if Base58Encode(after.signers[i]) != s {
			t.Fatalf("%s: signer %d is %s", what, i, Base58Encode(after.signers[i]))
		}
	}
	// Slot 0 is the payer, the other signer is the API key's own address and nobody else signs.
	if len(lay.Signers) != 2 || lay.Signers[0] != lay.Payer || lay.Signers[k] != f.Closure.KeyAddress {
		t.Fatalf("%s: signers %v", what, lay.Signers)
	}
	// The key's signature is the one the router put there, byte for byte, and still verifies.
	if !bytes.Equal(before.slot(k), after.slot(k)) || Base58Encode(after.slot(k)) != lay.KeySignatureBase58 || !ed25519.Verify(after.signers[k], after.message, after.slot(k)) {
		t.Fatalf("%s: the key's signature changed", what)
	}
	if !bytes.Equal(before.slot(0), make([]byte, 64)) || Base58Encode(after.slot(0)) != lay.PayerSignatureBase58 || !ed25519.Verify(walletPub, after.message, after.slot(0)) {
		t.Fatalf("%s: the payer's slot", what)
	}
	if !bytes.Equal(before.message, after.message) || base64.StdEncoding.EncodeToString(after.message) != lay.MessageBase64 {
		t.Fatalf("%s: the message changed", what)
	}
	// The generic helper and a wallet that signs elsewhere give the same bytes; signing twice changes nothing.
	if s, err := SignTransaction(transaction, wallet); err != nil || s != lay.SignedTransaction {
		t.Fatalf("%s: SignTransaction: %v", what, err)
	}
	if s, err := it.SignAsPayerWith(walletPub, byWallet); err != nil || s != lay.SignedTransaction {
		t.Fatalf("%s: SignAsPayerWith: %v", what, err)
	}
	if s, err := SignTransaction(signed, wallet); err != nil || s != lay.SignedTransaction {
		t.Fatalf("%s: signing again: %v", what, err)
	}
	if s, err := with(signed, lay.Payer).SignAsPayer(wallet); err != nil || s != lay.SignedTransaction {
		t.Fatalf("%s: signing the signed transaction again: %v", what, err)
	}
	// An answer that names no payer is still signed only by the transaction's fee payer.
	if s, err := with(transaction, "").SignAsPayer(wallet); err != nil || s != lay.SignedTransaction {
		t.Fatalf("%s: without a named payer: %v", what, err)
	}

	// Refusals: a wallet that is not the payer (named or not, and when the answer names it but the transaction does
	// not), a signer that returns another key's signature, a transaction whose key signature was damaged or is
	// missing, a wallet that is no signer at all, a key or a transaction that is not one.
	sessionAddress := Base58Encode(session.Public().(ed25519.PublicKey))
	if _, err := it.SignAsPayer(session); err == nil {
		t.Fatalf("%s: another wallet signed as payer", what)
	}
	if _, err := with(transaction, "").SignAsPayer(session); err == nil {
		t.Fatalf("%s: a wallet that is not the fee payer signed", what)
	}
	if _, err := with(transaction, sessionAddress).SignAsPayer(session); err == nil {
		t.Fatalf("%s: a wallet the answer names but the transaction does not signed", what)
	}
	if _, err := with(transaction, sessionAddress).SignAsPayer(wallet); err == nil {
		t.Fatalf("%s: the fee payer signed an answer that names another payer", what)
	}
	if _, err := it.SignAsPayerWith(walletPub, func(msg []byte) ([]byte, error) { return ed25519.Sign(session, msg), nil }); err == nil {
		t.Fatalf("%s: a foreign signature was placed in the payer's slot", what)
	}
	if _, err := it.SignAsPayerWith(walletPub, func([]byte) ([]byte, error) { return nil, errors.New("declined") }); err == nil {
		t.Fatalf("%s: a signer that declined still produced a transaction", what)
	}
	if _, err := SignTransaction(transaction, session); err == nil {
		t.Fatalf("%s: a wallet that is not a required signer signed", what)
	}
	if _, err := it.SignAsPayer(wallet[:32]); err == nil {
		t.Fatalf("%s: a 32-byte key signed", what)
	}
	if _, err := it.SignAsPayerWith(walletPub[:31], byWallet); err == nil {
		t.Fatalf("%s: a short public key signed", what)
	}
	raw, _ := base64.StdEncoding.DecodeString(transaction)
	raw[before.sigAt+64*k] ^= 1
	if _, err := with(base64.StdEncoding.EncodeToString(raw), lay.Payer).SignAsPayer(wallet); err == nil {
		t.Fatalf("%s: a transaction without the key's valid signature was signed", what)
	}
	unsigned, _ := base64.StdEncoding.DecodeString(transaction)
	copy(unsigned[before.sigAt+64*k:before.sigAt+64*k+64], make([]byte, 64))
	if _, err := with(base64.StdEncoding.EncodeToString(unsigned), lay.Payer).SignAsPayer(wallet); err == nil {
		t.Fatalf("%s: a transaction the key never signed was signed", what)
	}
	for _, bad := range []string{"", "@@", base64.StdEncoding.EncodeToString([]byte{2, 0, 0}), base64.StdEncoding.EncodeToString(raw[:80])} {
		if _, err := SignTransaction(bad, wallet); err == nil {
			t.Errorf("%s: signed %q", what, bad)
		}
		if _, err := with(bad, lay.Payer).SignAsPayer(wallet); err == nil {
			t.Errorf("%s: signed %q as payer", what, bad)
		}
	}
}

// 4. A closure names no destination and arrives signed by the key; the payer adds its signature in slot 0 and nothing
// else changes. What is left returns to the wallets that deposited.
func TestContractClosure(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	payer, _ := f.Closure.Request["payer"].(string)
	if payer == "" || payer != f.Closure.Payer || len(f.Closure.Request) != 1 {
		t.Fatalf("fixture request %v: a closure request is the payer and nothing else", f.Closure.Request)
	}
	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-test"))
	m.on("POST /api/v1/credits/close", f.refusingRefundTo(201, f.Closure.Response))
	cl, err := c.CloseCredits(context.Background(), payer)
	if err != nil {
		t.Fatal(err)
	}
	got := m.last(t)
	if got.Method != "POST" || got.Target != "/api/v1/credits/close" || !jsonEqual(t, got.Raw, f.Closure.Request) || got.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("request %s %s %s", got.Method, got.Target, got.Raw)
	}
	var want map[string]any
	_ = json.Unmarshal(f.Closure.Response, &want)
	if !cl.Created || cl.ID != want["id"] || cl.Status != want["status"] || cl.Status != ClosureStatusQueued || cl.Payer != payer || cl.Authority != want["authority"] || cl.PayableAt != want["payable_at"] ||
		cl.Transaction != want["transaction"] || cl.Message != want["message"] || float64(cl.ExpiresAtBlockHeight) != want["expires_at_block_height"] || !cl.SignedByKey || cl.Note != want["note"] || cl.Note == "" ||
		cl.Accounts["refundRequest"] == "" {
		t.Fatalf("closure %+v", cl)
	}
	carriesFixture(t, "closure.response", cl, f.Closure.Response)
	// The answer names no destination of its own: only the wallets that deposited, each with the account it is paid to.
	if _, has := want["refund_to"]; has {
		t.Fatal("the fixture's closure names a destination")
	}
	first, second := f.address(t, "wallet"), f.address(t, "second_depositor")
	if len(cl.Refunds) != 2 || cl.Refunds[0].Depositor != first || cl.Refunds[1].Depositor != second || cl.Refunds[0].RefundTo == "" || cl.Refunds[1].RefundTo == "" || cl.Refunds[0].RefundTo == cl.Refunds[1].RefundTo ||
		cl.Refunds[0].DepositedUnits != "25000000" || cl.Refunds[1].DepositedUnits != "5000000" || cl.Refunds[0].RefundedUnits != "0" || cl.Refunds[1].RefundedUnits != "0" {
		t.Fatalf("refunds %+v", cl.Refunds)
	}

	// The payer signs: exactly the fixture's signed transaction, with the key's signature as the router issued it.
	signed, err := cl.SignAsPayer(wallet)
	if err != nil {
		t.Fatal(err)
	}
	if signed != f.Closure.SignedTransaction {
		t.Fatalf("signed transaction\n got  %s\n want %s", signed, f.Closure.SignedTransaction)
	}
	checkKeySigned(t, f, "closure", f.Closure.fixtureKeySigned, cl.Transaction, func(transaction, payer string) payerSigned {
		other := *cl
		other.Transaction, other.Payer = transaction, payer
		return &other
	})

	// Already registered: 200, nothing to sign. The request is the same: the payer and nothing else.
	m.on("POST /api/v1/credits/close", f.refusingRefundTo(200, f.Closure.ResponseAlreadyRegistered))
	reg, err := c.CloseCredits(context.Background(), payer)
	if err != nil {
		t.Fatal(err)
	}
	if reg.Created || reg.Transaction != "" || reg.Status != ClosureStatusRegistered || reg.Payer != payer || reg.SignedByKey || reg.ExpiresAtBlockHeight != 0 || len(reg.Refunds) != 2 || reg.Refunds[1].Depositor != second {
		t.Fatalf("registered closure %+v", reg)
	}
	carriesFixture(t, "closure.response_already_registered", reg, f.Closure.ResponseAlreadyRegistered)
	if _, err := reg.SignAsPayer(wallet); !errors.Is(err, ErrNothingToSign) {
		t.Fatalf("nothing to sign: %v", err)
	}
	if _, err := (*CreditClosure)(nil).SignAsPayer(wallet); !errors.Is(err, ErrNothingToSign) {
		t.Fatalf("no closure: %v", err)
	}
	if !jsonEqual(t, m.last(t).Raw, f.Closure.Request) {
		t.Fatalf("second request: %s", m.last(t).Raw)
	}

	// Without a payer nothing is sent: the SDK says the payer is required and where the refund goes.
	sent := m.count()
	_, err = c.CloseCredits(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "payer is required") || !strings.Contains(err.Error(), "returns to the wallets that funded the key") {
		t.Fatalf("empty payer: %v", err)
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) || m.count() != sent {
		t.Fatalf("an empty payer reached the router (%d requests, %v)", m.count()-sent, err)
	}
}

// 4a. A request that names a destination is refused by the router, and no call of this SDK can make one.
func TestContractClosureDestinationFixed(t *testing.T) {
	f := loadContracts(t)
	refused := f.Closure.RefusedWithRefundTo
	payer, _ := refused.Request["payer"].(string)
	if _, named := refused.Request["refund_to"]; !named || payer == "" || refused.Status != 400 {
		t.Fatalf("fixture: %v %d", refused.Request, refused.Status)
	}
	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-test"))
	// A router that refuses refund_to, as the real one does: the SDK's requests pass because they name none.
	m.on("POST /api/v1/credits/close", f.refusingRefundTo(201, f.Closure.Response))
	m.on("POST /api/v1/credits/close/cancel", f.refusingRefundTo(200, f.Closure.Cancel.Response))
	if _, err := c.CloseCredits(context.Background(), payer); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := c.CancelCreditClosure(context.Background(), payer); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	for _, call := range m.calls {
		var body map[string]any
		if err := json.Unmarshal(call.Raw, &body); err != nil || len(body) != 1 || body["payer"] != payer {
			t.Fatalf("%s carried %s: only the payer is sent", call.Target, call.Raw)
		}
	}
	// The refusal itself, as the router words it, is the SDK's API error with its own recogniser.
	m.reply("POST /api/v1/credits/close", refused.Status, string(refused.Body))
	m.reply("POST /api/v1/credits/close/cancel", refused.Status, string(refused.Body))
	sent := m.count()
	_, err := c.CloseCredits(context.Background(), payer)
	wantAPIError(t, "close", err, refused, ErrorTypeRefundDestinationFixed)
	_, cancelErr := c.CancelCreditClosure(context.Background(), payer)
	wantAPIError(t, "cancel", cancelErr, refused, ErrorTypeRefundDestinationFixed)
	if m.count() != sent+2 {
		t.Fatalf("%d requests for 2 refused calls: a refusal is not retried", m.count()-sent)
	}
	if !IsRefundDestinationFixed(err) || IsNothingToCancel(err) || IsRefundInProgress(err) || IsCreditsClosing(err) || IsRateLimited(err) || IsPaymentNotBound(err) {
		t.Fatal("not recognised as refund_destination_fixed alone")
	}
	if IsRefundDestinationFixed(nil) || IsRefundDestinationFixed(errors.New("refund_destination_fixed")) || IsRefundDestinationFixed(&APIError{StatusCode: 400, Type: "invalid_request"}) {
		t.Fatal("IsRefundDestinationFixed on other errors")
	}
}

// 4b. Cancelling a closure: the same shape as the closure, signed by the key, for the payer to sign in slot 0.
func TestContractClosureCancel(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	payer, _ := f.Closure.Cancel.Request["payer"].(string)
	if payer == "" || payer != f.Closure.Cancel.Payer || len(f.Closure.Cancel.Request) != 1 {
		t.Fatalf("fixture request %v", f.Closure.Cancel.Request)
	}
	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-test"))
	m.on("POST /api/v1/credits/close/cancel", f.refusingRefundTo(200, f.Closure.Cancel.Response))
	cc, err := c.CancelCreditClosure(context.Background(), payer)
	if err != nil {
		t.Fatal(err)
	}
	got := m.last(t)
	if got.Method != "POST" || got.Target != "/api/v1/credits/close/cancel" || !jsonEqual(t, got.Raw, f.Closure.Cancel.Request) || got.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("request %s %s %s", got.Method, got.Target, got.Raw)
	}
	var want map[string]any
	_ = json.Unmarshal(f.Closure.Cancel.Response, &want)
	if cc.Transaction != want["transaction"] || cc.Transaction == "" || cc.Message != want["message"] || cc.Payer != payer || float64(cc.ExpiresAtBlockHeight) != want["expires_at_block_height"] || !cc.SignedByKey ||
		cc.Note != want["note"] || cc.Note == "" || cc.Accounts["refundRequest"] == "" {
		t.Fatalf("cancellation %+v", cc)
	}
	carriesFixture(t, "closure.cancel.response", cc, f.Closure.Cancel.Response)
	// It withdraws the very refund request the closure registered, and it is another transaction than the closure.
	var closure CreditClosure
	if err := json.Unmarshal(f.Closure.Response, &closure); err != nil || cc.Accounts["refundRequest"] != closure.Accounts["refundRequest"] || cc.Transaction == closure.Transaction {
		t.Fatalf("cancellation accounts %v, closure accounts %v (%v)", cc.Accounts, closure.Accounts, err)
	}

	// The payer signs: exactly the fixture's signed transaction, and the key's signature is unchanged.
	signed, err := cc.SignAsPayer(wallet)
	if err != nil {
		t.Fatal(err)
	}
	if signed != f.Closure.Cancel.SignedTransaction {
		t.Fatalf("signed transaction\n got  %s\n want %s", signed, f.Closure.Cancel.SignedTransaction)
	}
	checkKeySigned(t, f, "cancellation", f.Closure.Cancel.fixtureKeySigned, cc.Transaction, func(transaction, payer string) payerSigned {
		other := *cc
		other.Transaction, other.Payer = transaction, payer
		return &other
	})
	if _, err := (*CreditClosureCancel)(nil).SignAsPayer(wallet); err == nil {
		t.Fatal("no cancellation was signed")
	}

	// 400 nothing_to_cancel and 409 refund_in_progress, as the router sends them; neither is retried.
	sent := m.count()
	nothing := f.Closure.Cancel.Errors["nothing_to_cancel"]
	m.reply("POST /api/v1/credits/close/cancel", nothing.Status, string(nothing.Body))
	_, err = c.CancelCreditClosure(context.Background(), payer)
	if e := wantAPIError(t, "nothing_to_cancel", err, nothing, ErrorTypeNothingToCancel); e.StatusCode != 400 {
		t.Fatalf("status %d", e.StatusCode)
	}
	if !IsNothingToCancel(err) || IsRefundInProgress(err) || IsRefundDestinationFixed(err) || IsCreditsClosing(err) || IsRateLimited(err) {
		t.Fatal("not recognised as nothing_to_cancel alone")
	}
	progress := f.Closure.Cancel.Errors["refund_in_progress"]
	m.reply("POST /api/v1/credits/close/cancel", progress.Status, string(progress.Body))
	_, err = c.CancelCreditClosure(context.Background(), payer)
	if e := wantAPIError(t, "refund_in_progress", err, progress, ErrorTypeRefundInProgress); e.StatusCode != 409 {
		t.Fatalf("status %d", e.StatusCode)
	}
	if !IsRefundInProgress(err) || IsNothingToCancel(err) || IsRefundDestinationFixed(err) || IsCreditsClosing(err) || IsRateLimited(err) {
		t.Fatal("not recognised as refund_in_progress alone")
	}
	if _, ok := ClosureID(err); ok {
		t.Fatal("ClosureID on refund_in_progress")
	}
	if m.count() != sent+2 {
		t.Fatalf("%d requests for 2 refused calls", m.count()-sent)
	}
	for _, other := range []error{nil, errors.New("nothing_to_cancel"), &APIError{StatusCode: 409, Type: ErrorTypeCreditsClosing}} {
		if IsNothingToCancel(other) || IsRefundInProgress(other) {
			t.Fatalf("recognised %v", other)
		}
	}

	// Without a payer nothing is sent.
	if _, err := c.CancelCreditClosure(context.Background(), ""); err == nil || !strings.Contains(err.Error(), "payer is required") || m.count() != sent+2 {
		t.Fatalf("empty payer: %v (%d requests)", err, m.count()-sent-2)
	}
}

// 4c. Releasing a closure held because its key was disabled: an owner's call, by the key's hash.
func TestContractClosureRelease(t *testing.T) {
	f := loadContracts(t)
	keyHash, _ := f.Closure.Release.Request["key"].(string)
	if keyHash == "" || keyHash != f.Closure.KeyHash || len(f.Closure.Release.Request) != 1 {
		t.Fatalf("fixture request %v", f.Closure.Release.Request)
	}
	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-owner"))
	m.reply("POST /api/v1/credits/close/release", 200, `{"data":`+string(f.Closure.Release.Response)+`}`)
	released, err := c.ReleaseCreditClosure(context.Background(), keyHash)
	if err != nil {
		t.Fatal(err)
	}
	got := m.last(t)
	if got.Method != "POST" || got.Target != "/api/v1/credits/close/release" || !jsonEqual(t, got.Raw, f.Closure.Release.Request) || got.Header.Get("Authorization") != "Bearer sk-owner" {
		t.Fatalf("request %s %s %s", got.Method, got.Target, got.Raw)
	}
	if len(released) != 1 || released[0].ID != "close_fixture" || released[0].Status != ClosureStatusRegistered || !released[0].Released || released[0].PayableAt == "" {
		t.Fatalf("released %+v", released)
	}
	carriesFixture(t, "closure.release.response", released, f.Closure.Release.Response)
	// The closure it lets go is the one that disabling the key put on hold, for the reason the list names.
	var disabled struct {
		Data struct {
			Hash        string
			ClosureHeld struct{ ID, Reason, Release string } `json:"closure_held"`
		}
	}
	if err := json.Unmarshal(f.Closure.Release.KeyDisabledResponse, &disabled); err != nil || disabled.Data.Hash != keyHash || disabled.Data.ClosureHeld.ID != released[0].ID ||
		disabled.Data.ClosureHeld.Reason != ClosureReasonKeyDisabled || disabled.Data.ClosureHeld.Release != got.Method+" "+got.Target {
		t.Fatalf("key_disabled_response %+v (%v)", disabled, err)
	}

	// 404 when the key has no open closure.
	notFound := f.Closure.Release.Errors["not_found"]
	m.reply("POST /api/v1/credits/close/release", notFound.Status, string(notFound.Body))
	_, err = c.ReleaseCreditClosure(context.Background(), keyHash)
	if e := wantAPIError(t, "release not_found", err, notFound, "not_found"); e.StatusCode != 404 {
		t.Fatalf("status %d", e.StatusCode)
	}

	// The key itself, or anything else that is not its hash, is refused before it leaves the process.
	sent := m.count()
	for _, bad := range []string{"", "sk-test", keyHash[:63], keyHash + "0", strings.ToUpper(keyHash), "0x" + keyHash[2:], f.Closure.KeyAddress} {
		if _, err := c.ReleaseCreditClosure(context.Background(), bad); err == nil || !strings.Contains(err.Error(), "the key's hash") {
			t.Errorf("released %q: %v", bad, err)
		}
	}
	if m.count() != sent {
		t.Fatalf("%d refused releases reached the router", m.count()-sent)
	}
}

// 4d. Where a depositor's refund goes is that depositor's decision: an unsigned transaction only its wallet can sign.
func TestContractRefundDestination(t *testing.T) {
	f := loadContracts(t)
	rdf := &f.Closure.RefundDestination
	wallet := f.key(t, "wallet")
	walletPub := wallet.Public().(ed25519.PublicKey)
	depositor, _ := rdf.Request["depositor"].(string)
	refundTo, _ := rdf.Request["refund_to"].(string)
	if depositor != f.address(t, "wallet") || refundTo != f.address(t, "refund_to") || len(rdf.Request) != 2 {
		t.Fatalf("fixture request %v", rdf.Request)
	}
	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-test"))
	m.reply("POST /api/v1/credits/refund-destination-tx", 200, `{"data":`+string(rdf.Response)+`}`)
	rd, err := c.RefundDestinationTx(context.Background(), depositor, refundTo)
	if err != nil {
		t.Fatal(err)
	}
	got := m.last(t)
	if got.Method != "POST" || got.Target != "/api/v1/credits/refund-destination-tx" || !jsonEqual(t, got.Raw, rdf.Request) || got.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("request %s %s %s", got.Method, got.Target, got.Raw)
	}
	var want map[string]any
	_ = json.Unmarshal(rdf.Response, &want)
	if rd.Transaction != want["transaction"] || rd.Transaction == "" || rd.Message != want["message"] || rd.Depositor != depositor || rd.RefundTo != refundTo || rd.CurrentRefundTo != want["current_refund_to"] ||
		rd.CurrentRefundTo == "" || float64(rd.ExpiresAtBlockHeight) != want["expires_at_block_height"] || rd.Note != want["note"] || rd.Note == "" || rd.Accounts["share"] == "" || rd.Accounts["refundToToken"] == "" ||
		rd.Accounts["refundToToken"] == rd.CurrentRefundTo {
		t.Fatalf("refund destination %+v", rd)
	}
	carriesFixture(t, "closure.refund_destination.response", rd, rdf.Response)

	// The depositor signs: exactly the fixture's signed transaction. It is the fee payer and the only signer; the API
	// key is not in it.
	before, err := parseSignedTx(rd.Transaction)
	if err != nil {
		t.Fatal(err)
	}
	if len(rdf.Signers) != 1 || rdf.Signers[0] != depositor || len(before.signers) != 1 || Base58Encode(before.signers[0]) != depositor || depositor == f.Closure.KeyAddress || !bytes.Equal(before.slot(0), make([]byte, 64)) {
		t.Fatalf("signers %v", rdf.Signers)
	}
	signed, err := rd.SignAsDepositor(wallet)
	if err != nil {
		t.Fatal(err)
	}
	if signed != rdf.SignedTransaction {
		t.Fatalf("signed transaction\n got  %s\n want %s", signed, rdf.SignedTransaction)
	}
	after, err := parseSignedTx(signed)
	if err != nil {
		t.Fatal(err)
	}
	if Base58Encode(after.slot(0)) != rdf.DepositorSignatureBase58 || !ed25519.Verify(walletPub, after.message, after.slot(0)) {
		t.Fatal("the depositor's signature")
	}
	if !bytes.Equal(before.message, after.message) || base64.StdEncoding.EncodeToString(after.message) != rdf.MessageBase64 {
		t.Fatal("the message changed")
	}
	byWallet := func(msg []byte) ([]byte, error) { return ed25519.Sign(wallet, msg), nil }
	if s, err := rd.SignAsDepositorWith(walletPub, byWallet); err != nil || s != rdf.SignedTransaction {
		t.Fatalf("SignAsDepositorWith: %v", err)
	}
	if s, err := SignTransaction(rd.Transaction, wallet); err != nil || s != rdf.SignedTransaction {
		t.Fatalf("SignTransaction: %v", err)
	}
	if s, err := SignTransaction(signed, wallet); err != nil || s != rdf.SignedTransaction {
		t.Fatalf("signing again: %v", err)
	}

	// Nobody else can sign it: not the wallet the refund would go to, not another depositor, not any other wallet.
	for _, name := range []string{"refund_to", "second_depositor", "session", "fee_payer"} {
		other := f.key(t, name)
		if _, err := rd.SignAsDepositor(other); err == nil {
			t.Fatalf("%s signed another wallet's refund destination", name)
		}
		if _, err := SignTransaction(rd.Transaction, other); err == nil {
			t.Fatalf("%s is no signer of the transaction and signed it", name)
		}
		// An answer rewritten to name that wallet does not make it a signer of the transaction.
		renamed := *rd
		renamed.Depositor = f.address(t, name)
		if _, err := renamed.SignAsDepositor(other); err == nil {
			t.Fatalf("%s signed after the answer was renamed to it", name)
		}
		if _, err := renamed.SignAsDepositor(wallet); err == nil {
			t.Fatalf("the wallet signed an answer that names %s as depositor", name)
		}
	}
	unnamed := *rd
	unnamed.Depositor = ""
	if _, err := unnamed.SignAsDepositor(wallet); err == nil {
		t.Fatal("an answer that names no depositor was signed")
	}
	if _, err := rd.SignAsDepositorWith(walletPub, func(msg []byte) ([]byte, error) { return ed25519.Sign(f.key(t, "session"), msg), nil }); err == nil {
		t.Fatal("a foreign signature was placed in the depositor's slot")
	}
	if _, err := rd.SignAsDepositor(wallet[:32]); err == nil {
		t.Fatal("a 32-byte key signed")
	}
	if _, err := rd.SignAsDepositorWith(walletPub[:31], byWallet); err == nil {
		t.Fatal("a short public key signed")
	}
	// A transaction with a second signer is not a refund destination change (here: the closure, which the key signs).
	var closure CreditClosure
	if err := json.Unmarshal(f.Closure.Response, &closure); err != nil {
		t.Fatal(err)
	}
	swapped := *rd
	swapped.Transaction = closure.Transaction
	if _, err := swapped.SignAsDepositor(wallet); err == nil {
		t.Fatal("a transaction with two signers was signed as a refund destination change")
	}
	for _, bad := range []string{"", "@@", base64.StdEncoding.EncodeToString([]byte{1, 0, 0})} {
		broken := *rd
		broken.Transaction = bad
		if _, err := broken.SignAsDepositor(wallet); err == nil {
			t.Errorf("signed %q", bad)
		}
	}
	if _, err := (*RefundDestinationTransaction)(nil).SignAsDepositor(wallet); err == nil {
		t.Fatal("no transaction was signed")
	}

	// 404 when that wallet never deposited to the key.
	notFound := rdf.Errors["not_found"]
	stranger, _ := notFound.Request["depositor"].(string)
	to, _ := notFound.Request["refund_to"].(string)
	m.reply("POST /api/v1/credits/refund-destination-tx", notFound.Status, string(notFound.Body))
	_, err = c.RefundDestinationTx(context.Background(), stranger, to)
	if e := wantAPIError(t, "refund destination not_found", err, notFound, "not_found"); e.StatusCode != 404 {
		t.Fatalf("status %d", e.StatusCode)
	}
	if stranger == "" || !jsonEqual(t, m.last(t).Raw, notFound.Request) {
		t.Fatalf("request %s", m.last(t).Raw)
	}
	sent := m.count()
	if _, err := c.RefundDestinationTx(context.Background(), "", refundTo); err == nil {
		t.Fatal("no depositor")
	}
	if _, err := c.RefundDestinationTx(context.Background(), depositor, ""); err == nil {
		t.Fatal("no destination")
	}
	if m.count() != sent {
		t.Fatal("an incomplete request reached the router")
	}
}

// 4e. A deposit says where its refund would return to, and names the depositor's on-chain share.
func TestContractDepositRefundTo(t *testing.T) {
	f := loadContracts(t)
	wallet := f.key(t, "wallet")
	amount, _ := f.Closure.Deposit.Request["amount"].(string)
	payer, _ := f.Closure.Deposit.Request["payer"].(string)
	if amount == "" || payer != f.address(t, "wallet") || len(f.Closure.Deposit.Request) != 2 {
		t.Fatalf("fixture request %v", f.Closure.Deposit.Request)
	}
	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-test"))
	m.reply("POST /api/v1/credits/deposit-tx", 200, `{"data":`+string(f.Closure.Deposit.Response)+`}`)
	d, err := c.DepositTx(context.Background(), amount, payer)
	if err != nil {
		t.Fatal(err)
	}
	got := m.last(t)
	if got.Method != "POST" || got.Target != "/api/v1/credits/deposit-tx" || !jsonEqual(t, got.Raw, f.Closure.Deposit.Request) || got.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("request %s %s %s", got.Method, got.Target, got.Raw)
	}
	var want map[string]any
	_ = json.Unmarshal(f.Closure.Deposit.Response, &want)
	if d.Transaction != want["transaction"] || d.Transaction == "" || d.Message != want["message"] || d.Network != want["network"] || d.AmountUSDC != amount || d.AmountUnits != "25000000" ||
		float64(d.ExpiresAtBlockHeight) != want["expires_at_block_height"] || d.KeyHash != want["key_hash"] || d.KeyHash == "" || d.Note != want["note"] || d.Note == "" {
		t.Fatalf("deposit %+v", d)
	}
	carriesFixture(t, "closure.deposit.response", d, f.Closure.Deposit.Response)
	// refund_to is the token account the deposit is paid from; accounts.share is this wallet's record for the key, the
	// same one a refund destination change edits; and a closure pays this depositor back to that same account.
	if d.RefundTo == "" || d.RefundTo != want["refund_to"] || d.RefundTo != d.Accounts["depositorToken"] || d.Accounts["share"] == "" || d.Accounts["credit"] == "" || d.Accounts["vault"] == "" {
		t.Fatalf("refund_to %q, accounts %v", d.RefundTo, d.Accounts)
	}
	var rd RefundDestinationTransaction
	var closure CreditClosure
	if err := json.Unmarshal(f.Closure.RefundDestination.Response, &rd); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(f.Closure.Response, &closure); err != nil {
		t.Fatal(err)
	}
	if d.Accounts["share"] != rd.Accounts["share"] || d.RefundTo != rd.CurrentRefundTo || closure.Refunds[0].Depositor != payer || closure.Refunds[0].RefundTo != d.RefundTo {
		t.Fatalf("share %q / %q, refund_to %q / %q / %q", d.Accounts["share"], rd.Accounts["share"], d.RefundTo, rd.CurrentRefundTo, closure.Refunds[0].RefundTo)
	}
	// It is unsigned and for the payer's wallet alone.
	tx, err := parseSignedTx(d.Transaction)
	if err != nil || len(tx.signers) != 1 || Base58Encode(tx.signers[0]) != payer || !bytes.Equal(tx.slot(0), make([]byte, 64)) {
		t.Fatalf("deposit transaction signers (%v)", err)
	}
	if _, err := SignTransaction(d.Transaction, wallet); err != nil {
		t.Fatal(err)
	}
	if _, err := SignTransaction(d.Transaction, f.key(t, "session")); err == nil {
		t.Fatal("another wallet signed the deposit")
	}
}

// 4f. The list: who was paid, what is waiting and why, what was taken back, what is held.
func TestContractClosureList(t *testing.T) {
	f := loadContracts(t)
	// The constants are the router's vocabulary, all of it.
	same := func(what string, got, want []string) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: SDK %v, fixture %v", what, got, want)
		}
	}
	same("statuses", []string{ClosureStatusQueued, ClosureStatusRegistered, ClosureStatusPaid, ClosureStatusRefused, ClosureStatusFailed, ClosureStatusCancelled}, f.Closure.List.Statuses)
	same("reasons", []string{ClosureReasonKeyDisabled, ClosureReasonRefundRateLimited, ClosureReasonRefundDestinationUnavailable, ClosureReasonDepositorsUnknown, ClosureReasonCancelledOnChain, ClosureReasonSanctionedAddress, ClosureReasonSubmissionFailed, ClosureReasonRefundWorkCapped, ClosureReasonRequestGone}, f.Closure.List.Reasons)
	same("refund statuses", []string{RefundStatusPlanned, RefundStatusPaid, RefundStatusRefused, RefundStatusReversed}, f.Closure.List.RefundStatuses)

	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-test"))
	m.reply("GET /api/v1/credits/close", 200, `{"data":`+string(f.Closure.List.Response)+`}`)
	rows, err := c.CreditClosures(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := m.last(t); got.Method != "GET" || got.Target != "/api/v1/credits/close" || len(got.Raw) != 0 || got.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("request %s %s %q", got.Method, got.Target, got.Raw)
	}
	carriesFixture(t, "closure.list.response", rows, f.Closure.List.Response)
	if len(rows) != 4 {
		t.Fatalf("%d rows", len(rows))
	}
	first, second, moved := f.address(t, "wallet"), f.address(t, "second_depositor"), f.address(t, "refund_to")
	held, waiting, cancelled, paid := rows[0], rows[1], rows[2], rows[3]

	// Held: its key was disabled. Open, nothing planned, nothing paid, waiting for an owner.
	if held.Status != ClosureStatusRegistered || held.Reason != ClosureReasonKeyDisabled || !held.Open() || !held.Held() || len(held.Refunds) != 0 || held.RefundTo != "" || held.AmountUnits != "" ||
		held.PaidAt != "" || held.PayTx != "" || held.CancelTx != "" || held.ReleasedAt != "" || held.RegisterTx == "" || held.RequestedAt == "" || held.PayableAt == "" {
		t.Fatalf("held row %+v", held)
	}
	// Waiting on the payout rate: one depositor paid, the other planned, per depositor. Open but not held.
	if waiting.Status != ClosureStatusRegistered || waiting.Reason != ClosureReasonRefundRateLimited || !waiting.Open() || waiting.Held() || waiting.AmountUnits != "24000000" || waiting.RefundTo != "" ||
		waiting.PaidAt != "" || waiting.PayTx == "" || waiting.ReleasedAt == "" || len(waiting.Refunds) != 2 {
		t.Fatalf("waiting row %+v", waiting)
	}
	if a, b := waiting.Refunds[0], waiting.Refunds[1]; a.Depositor != first || a.Owner != first || a.RefundTo == "" || a.AmountUnits != "20000000" || a.Status != RefundStatusPaid || a.Reason != "" || a.Tx == "" || a.Tx != waiting.PayTx ||
		b.Depositor != second || b.Owner != moved || b.RefundTo == "" || b.RefundTo == a.RefundTo || b.AmountUnits != "4000000" || b.Status != RefundStatusPlanned || b.Reason != ClosureReasonRefundRateLimited || b.Tx != "" {
		t.Fatalf("waiting refunds %+v", waiting.Refunds)
	}
	// Cancelled: taken back on chain, with the transaction that did it. Neither open nor held.
	if cancelled.Status != ClosureStatusCancelled || cancelled.Reason != ClosureReasonCancelledOnChain || cancelled.Open() || cancelled.Held() || cancelled.CancelTx == "" || cancelled.RegisterTx == "" ||
		cancelled.CancelTx == cancelled.RegisterTx || len(cancelled.Refunds) != 0 || cancelled.PayTx != "" || cancelled.PaidAt != "" || cancelled.RefundTo != "" {
		t.Fatalf("cancelled row %+v", cancelled)
	}
	// Paid: each depositor to the account it named; refund_to is the wallets paid, comma-separated.
	if paid.Status != ClosureStatusPaid || paid.Reason != "" || paid.Open() || paid.Held() || paid.RefundTo != first+","+moved || paid.AmountUnits != "24000000" || paid.PaidAt == "" || paid.PayTx == "" ||
		paid.CancelTx != "" || len(paid.Refunds) != 2 {
		t.Fatalf("paid row %+v", paid)
	}
	if a, b := paid.Refunds[0], paid.Refunds[1]; a.Depositor != first || a.Owner != first || a.Status != RefundStatusPaid || a.Tx == "" || a.AmountUnits != "20000000" ||
		b.Depositor != second || b.Owner != moved || b.Status != RefundStatusPaid || b.Tx == "" || b.Tx == a.Tx || b.Tx != paid.PayTx || b.AmountUnits != "4000000" || b.RefundTo == a.RefundTo {
		t.Fatalf("paid refunds %+v", paid.Refunds)
	}

	// Held is the key_disabled reason on an open closure and nothing else.
	for _, row := range []CreditClosureSummary{
		{Status: ClosureStatusQueued, Reason: ClosureReasonKeyDisabled},
		{Status: ClosureStatusRegistered, Reason: ClosureReasonKeyDisabled},
	} {
		if !row.Held() || !row.Open() {
			t.Fatalf("%+v is held", row)
		}
	}
	for _, row := range []CreditClosureSummary{
		{Status: ClosureStatusQueued},
		{Status: ClosureStatusRegistered, Reason: ClosureReasonDepositorsUnknown},
		{Status: ClosureStatusPaid, Reason: ClosureReasonKeyDisabled},
		{Status: ClosureStatusCancelled, Reason: ClosureReasonKeyDisabled},
		{Status: ClosureStatusRefused, Reason: ClosureReasonSanctionedAddress},
		{Status: ClosureStatusFailed, Reason: ClosureReasonSubmissionFailed},
		{},
	} {
		if row.Held() {
			t.Fatalf("%+v is not held", row)
		}
	}
}

// 5. Vouchers: 110 bytes, domain-separated, bound to the tab program and to this opening of the tab.
func TestContractVouchers(t *testing.T) {
	f := loadContracts(t)
	session := f.key(t, "session")
	pub := session.Public().(ed25519.PublicKey)
	if Base58Encode(pub) != f.Tab.Session {
		t.Fatal("session key")
	}
	v := f.Tab.Voucher
	if VoucherDomain != v.Domain || VoucherMessageLen != v.Length || len(v.Cases) < 3 {
		t.Fatalf("domain %q, length %d, %d cases", VoucherDomain, VoucherMessageLen, len(v.Cases))
	}
	offsets := map[string]int{"domain": 0, "program_id": voucherProgramAt, "tab": voucherTabAt, "created_at": voucherCreatedAt, "cumulative_used": voucherUsedAt, "seq": voucherSeqAt}
	end := 0
	for _, l := range v.Layout {
		if at, ok := offsets[l.Field]; !ok || at != l.Offset || l.Offset != end {
			t.Errorf("layout: %s at %d, fixture %d", l.Field, at, l.Offset)
		}
		end = l.Offset + l.Length
	}
	if end != VoucherMessageLen || len(v.Layout) != len(offsets) {
		t.Fatalf("layout covers %d bytes", end)
	}
	program, tab := mustAddr(t, f.Tab.ProgramID), mustAddr(t, f.Tab.Tab)
	u := func(s string) uint64 {
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	var createdAt int64
	for _, c := range v.Cases {
		if c.ProgramID != f.Tab.ProgramID {
			t.Fatal("a fixture case for another program")
		}
		createdAt = int64(u(c.CreatedAt))
		used, seq := u(c.CumulativeUsed), u(c.Seq)
		msg := VoucherMessage(program, tab, createdAt, used, seq)
		if hex.EncodeToString(msg) != c.MessageHex {
			t.Errorf("message\n got  %x\n want %s", msg, c.MessageHex)
		}
		m2, sig := SignVoucher(session, program, tab, createdAt, used, seq)
		if !bytes.Equal(m2, msg) || Base58Encode(sig) != c.SignatureBase58 {
			t.Errorf("signature %s, fixture %s", Base58Encode(sig), c.SignatureBase58)
		}
		if h := VoucherHeader(msg, sig); h != c.Headers[HeaderTabVoucher] {
			t.Errorf("header\n got  %s\n want %s", h, c.Headers[HeaderTabVoucher])
		}
		if c.Headers[HeaderTab] != f.Tab.Tab {
			t.Errorf("fixture tab header %q", c.Headers[HeaderTab])
		}
		pm, ps, err := ParseVoucherHeader(c.Headers[HeaderTabVoucher])
		if err != nil || !bytes.Equal(pm, msg) || !bytes.Equal(ps, sig) {
			t.Errorf("parse: %v", err)
		}
		fields, err := DecodeVoucherMessage(pm)
		if err != nil || fields != (VoucherFields{ProgramID: program, Tab: tab, CreatedAt: createdAt, CumulativeUsed: used, Seq: seq}) {
			t.Errorf("decode: %+v %v", fields, err)
		}
		if !VerifyVoucher(pub, program, tab, createdAt, used, seq, sig) || !VerifyVoucherMessage(pub, program, createdAt, msg, sig) {
			t.Error("the fixture's voucher does not verify")
		}
		// Any field off by one is another voucher.
		if VerifyVoucher(pub, program, tab, createdAt+1, used, seq, sig) || VerifyVoucher(pub, tab, tab, createdAt, used, seq, sig) || VerifyVoucher(pub, program, program, createdAt, used, seq, sig) ||
			VerifyVoucher(pub, program, tab, createdAt, used+1, seq, sig) || VerifyVoucher(pub, program, tab, createdAt, used, seq-1, sig) {
			t.Error("a changed field verified")
		}
		if VerifyVoucherMessage(pub, program, createdAt+1, msg, sig) || VerifyVoucherMessage(pub, tab, createdAt, msg, sig) {
			t.Error("a voucher verified for another opening or another program")
		}
	}

	// Signed with the same session key for the same tab address, but for something else: none is a voucher for the
	// fixture's tab (this program id, this created_at).
	if len(v.NotForThisTab) < 3 {
		t.Fatalf("only %d not_for_this_tab cases", len(v.NotForThisTab))
	}
	first := v.Cases[0]
	for name, c := range v.NotForThisTab {
		msg, err := hex.DecodeString(c.MessageHex)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := Base58Decode(c.SignatureBase58)
		if err != nil || len(sig) != 64 {
			t.Fatal(name, err)
		}
		// The signature is genuine (the session key made it): it is refused for what it covers, not for being forged.
		if !ed25519.Verify(pub, msg, sig) {
			t.Fatalf("%s: the fixture signature is not the session key's", name)
		}
		if VerifyVoucherMessage(pub, program, createdAt, msg, sig) {
			t.Errorf("%s verified for the fixture's tab", name)
		}
		if VerifyVoucher(pub, program, tab, createdAt, u(first.CumulativeUsed), u(first.Seq), sig) {
			t.Errorf("%s: its signature verified as the fixture tab's voucher", name)
		}
	}
	// The retired 48-byte form is not a voucher message anywhere in the SDK.
	old := v.NotForThisTab["retired_48_byte_form"]
	oldMsg, _ := hex.DecodeString(old.MessageHex)
	oldSig, _ := Base58Decode(old.SignatureBase58)
	if len(oldMsg) != 48 {
		t.Fatalf("fixture: retired form is %d bytes", len(oldMsg))
	}
	if _, err := DecodeVoucherMessage(oldMsg); err == nil {
		t.Error("the 48-byte form decoded")
	}
	if _, _, err := ParseVoucherHeader(VoucherHeader(oldMsg, oldSig)); err == nil {
		t.Error("the 48-byte form parsed as a voucher header")
	}
	if _, _, err := ParseVoucherHeader(old.MessageBase64 + "." + old.SignatureBase64); err == nil {
		t.Error("the fixture's 48-byte header parsed")
	}
	// 110 bytes without the domain are not a voucher either.
	fake := append([]byte(strings.Repeat("x", len(VoucherDomain))), VoucherMessage(program, tab, createdAt, 1, 1)[len(VoucherDomain):]...)
	if _, err := DecodeVoucherMessage(fake); err == nil || VerifyVoucherMessage(pub, program, createdAt, fake, ed25519.Sign(session, fake)) {
		t.Error("a message without the domain passed")
	}
}

// 7. 409 credits_closing: the key is frozen; recognisable, and never retried.
func TestContractCreditsClosing(t *testing.T) {
	f := loadContracts(t)
	fe := f.apiError(t, "credits_closing")
	var env struct {
		Error struct {
			Type, Message string
			Metadata      struct{ Closure string }
		}
	}
	if err := json.Unmarshal(fe.Body, &env); err != nil || fe.Status != 409 || env.Error.Type != ErrorTypeCreditsClosing || env.Error.Metadata.Closure == "" {
		t.Fatalf("fixture: %d %s", fe.Status, fe.Body)
	}
	m, c := newMem("https://"+f.Host, f.Now, WithAPIKey("sk-test"))
	for _, route := range []string{"POST /api/v1/chat/completions", "POST /api/v1/embeddings", "POST /api/v1/batches"} {
		m.reply(route, fe.Status, string(fe.Body))
	}
	check := func(what string, err error) {
		t.Helper()
		var e *APIError
		if !errors.As(err, &e) || e.StatusCode != 409 || e.Code != 409 || e.Type != ErrorTypeCreditsClosing || e.Message != env.Error.Message {
			t.Fatalf("%s: %v", what, err)
		}
		if !IsCreditsClosing(err) || IsRateLimited(err) || IsPaymentNotBound(err) {
			t.Fatalf("%s: not recognised as credits_closing", what)
		}
		if id, ok := ClosureID(err); !ok || id != env.Error.Metadata.Closure {
			t.Fatalf("%s: closure id %q", what, id)
		}
		if _, ok := RetryAfter(err); ok {
			t.Fatalf("%s: a frozen key is not asked to wait", what)
		}
	}
	chat := ChatRequest{Model: "example/model", Messages: []Message{UserMessage("hi")}}
	_, err := c.Chat(context.Background(), chat)
	check("chat", err)
	if m.count() != 1 {
		t.Fatalf("chat was sent %d times: a frozen key must not be retried", m.count())
	}
	_, err = c.ChatStream(context.Background(), chat)
	check("stream", err)
	_, err = c.Embeddings(context.Background(), EmbeddingsRequest{Model: "example/embed", Input: []string{"a"}})
	check("embeddings", err)
	_, err = c.CreateBatch(context.Background(), CreateBatchRequest{Requests: []BatchRequestItem{{CustomID: "a", Method: "POST", URL: "/v1/chat/completions", Body: chat}}})
	check("batch", err)
	if m.count() != 4 {
		t.Fatalf("%d requests for 4 calls", m.count())
	}
	// Other errors are not it, and carry no closure.
	other := &APIError{StatusCode: 409, Type: "conflict", Metadata: map[string]any{"closure": "close_x"}}
	if IsCreditsClosing(other) || IsCreditsClosing(nil) || IsCreditsClosing(errors.New("credits_closing")) {
		t.Fatal("IsCreditsClosing on other errors")
	}
	if _, ok := ClosureID(other); ok {
		t.Fatal("ClosureID on another error")
	}
	if _, ok := ClosureID(&APIError{StatusCode: 409, Type: ErrorTypeCreditsClosing}); ok {
		t.Fatal("ClosureID without metadata")
	}
}
