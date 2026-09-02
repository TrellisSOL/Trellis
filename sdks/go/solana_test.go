package trellis

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBase58Vectors(t *testing.T) {
	cases := []struct{ hex, b58 string }{
		{"", ""},
		{"00", "1"},
		{"0000", "11"},
		{"61", "2g"},
		{"626262", "a3gV"},
		{"636363", "aPEr"},
		{"73696d706c792061206c6f6e6720737472696e67", "2cFupjhnEsSn59qHXstmK2ffpLv2"},
		{"00eb15231dfceb60925886b67d065299925915aeb172c06647", "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L"},
		{"516b6fcd0f", "ABnLTmg"},
		{"bf4f89001e670274dd", "3SEo3LWLoPntC"},
		{"572e4794", "3EFU7m"},
		{"ecac89cad93923c02321", "EJDM8drfXA6uyA"},
		{"10c8511e", "Rt5zm"},
		{"00000000000000000000", "1111111111"},
		// 32 zero bytes: the system program id. 32 repeated 0x01 bytes: a placeholder address.
		{strings.Repeat("00", 32), "11111111111111111111111111111111"},
		{strings.Repeat("01", 32), "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"},
	}
	for _, c := range cases {
		raw, _ := hex.DecodeString(c.hex)
		if got := Base58Encode(raw); got != c.b58 {
			t.Errorf("encode(%s) = %q, want %q", c.hex, got, c.b58)
		}
		dec, err := Base58Decode(c.b58)
		if err != nil || !bytes.Equal(dec, raw) {
			t.Errorf("decode(%q) = %x, %v; want %s", c.b58, dec, err, c.hex)
		}
	}
	if _, err := Base58Decode("0OIl"); err == nil {
		t.Error("characters outside the alphabet accepted")
	}
	if _, err := Base58Decode32("2g"); err == nil {
		t.Error("a short address passed Base58Decode32")
	}
	// Round trip random 64-byte signatures.
	for i := 0; i < 20; i++ {
		raw := make([]byte, 64)
		rand.Read(raw)
		dec, err := Base58Decode(Base58Encode(raw))
		if err != nil || !bytes.Equal(dec, raw) {
			t.Fatalf("round trip %x: %x %v", raw, dec, err)
		}
	}
}

func TestVoucherRoundTrip(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	var program, tab [32]byte
	for i := range tab {
		program[i] = 0x05
		tab[i] = 0x07
	}
	const createdAt = 1_790_000_000
	msg := VoucherMessage(program, tab, createdAt, 1_234_567, 42)
	if len(msg) != VoucherMessageLen || VoucherMessageLen != 110 || string(msg[:22]) != VoucherDomain || !bytes.Equal(msg[22:54], program[:]) || !bytes.Equal(msg[54:86], tab[:]) {
		t.Fatalf("message %x", msg)
	}
	// i64 / u64 little endian: created_at 1790000000 = 0x6AB13B80, 1234567 = 0x12D687, seq 42.
	if !bytes.Equal(msg[86:94], []byte{0x80, 0x3b, 0xb1, 0x6a, 0, 0, 0, 0}) || !bytes.Equal(msg[94:102], []byte{0x87, 0xd6, 0x12, 0, 0, 0, 0, 0}) || !bytes.Equal(msg[102:], []byte{42, 0, 0, 0, 0, 0, 0, 0}) {
		t.Fatalf("fields %x", msg[86:])
	}
	// A negative created_at is two's complement, as an i64 is.
	if neg := VoucherMessage(program, tab, -2, 0, 0); !bytes.Equal(neg[86:94], []byte{0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}) {
		t.Fatalf("negative created_at %x", neg[86:94])
	}
	got, err := DecodeVoucherMessage(msg)
	if err != nil || got.ProgramID != program || got.Tab != tab || got.CreatedAt != createdAt || got.CumulativeUsed != 1_234_567 || got.Seq != 42 {
		t.Fatalf("decode: %+v %v", got, err)
	}
	if neg, err := DecodeVoucherMessage(VoucherMessage(program, tab, -2, 0, 0)); err != nil || neg.CreatedAt != -2 {
		t.Fatalf("decode negative created_at: %+v %v", neg, err)
	}
	// Only the 110-byte domain-separated form is a voucher message: not a short one, and not the 48 bytes
	// tab || cumulative_used || seq that vouchers used to be.
	if _, err := DecodeVoucherMessage(msg[:109]); err == nil {
		t.Fatal("short message decoded")
	}
	if _, err := DecodeVoucherMessage(msg[62:]); err == nil {
		t.Fatal("the 48-byte tail decoded as a voucher")
	}
	m2, sig := SignVoucher(priv, program, tab, createdAt, 1_234_567, 42)
	if !bytes.Equal(m2, msg) || len(sig) != 64 || !VerifyVoucher(pub, program, tab, createdAt, 1_234_567, 42, sig) || !VerifyVoucherMessage(pub, program, createdAt, msg, sig) {
		t.Fatal("signature does not verify")
	}
	if VerifyVoucher(pub, program, tab, createdAt, 1_234_568, 42, sig) || VerifyVoucher(pub, program, tab, createdAt+1, 1_234_567, 42, sig) || VerifyVoucher(pub, tab, tab, createdAt, 1_234_567, 42, sig) ||
		VerifyVoucher(pub, program, tab, createdAt, 1_234_567, 42, sig[:63]) || VerifyVoucher(pub[:31], program, tab, createdAt, 1_234_567, 42, sig) {
		t.Fatal("a changed amount, opening or program, a short signature or a short key verified")
	}
	if VerifyVoucherMessage(pub, program, createdAt, msg[:109], sig) || VerifyVoucherMessage(pub, program, createdAt+1, msg, sig) || VerifyVoucherMessage(pub, tab, createdAt, msg, sig) ||
		VerifyVoucherMessage(pub[:31], program, createdAt, msg, sig) || VerifyVoucherMessage(pub, program, createdAt, msg, sig[:63]) {
		t.Fatal("a short message, another opening, another program, a short key or a short signature verified")
	}
	// A valid signature over the 48-byte form is not a voucher.
	legacy := msg[62:]
	if VerifyVoucherMessage(pub, program, createdAt, legacy, ed25519.Sign(priv, legacy)) {
		t.Fatal("the 48-byte form verified")
	}

	h := VoucherHeader(msg, sig)
	parts := strings.Split(h, ".")
	if len(parts) != 2 || parts[0] != base64.StdEncoding.EncodeToString(msg) || parts[1] != base64.StdEncoding.EncodeToString(sig) {
		t.Fatalf("header %q", h)
	}
	pm, ps, err := ParseVoucherHeader(h)
	if err != nil || !bytes.Equal(pm, msg) || !bytes.Equal(ps, sig) {
		t.Fatalf("parse: %v", err)
	}
	for _, bad := range []string{"", "abc", h + ".x", "AAAA.AAAA", "!!.!!", VoucherHeader(legacy, sig), VoucherHeader(msg, sig[:63])} {
		if _, _, err := ParseVoucherHeader(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestWalletAuthHeader(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	body := []byte(`{"model":"example/model"}`)
	now := time.Unix(1_790_000_000, 500)
	sum := sha256.Sum256(body) // already canonical: one member, no whitespace
	bound, err := WalletAuthHash("POST", "/api/v1/embeddings", body)
	if err != nil || bound != hex.EncodeToString(sum[:]) {
		t.Fatalf("hash %s %v", bound, err)
	}
	// Whitespace and member order do not change what a JSON route binds; the stream flags do, outside the chat routes.
	if spaced, _ := WalletAuthHash("POST", "/api/v1/embeddings", []byte("{ \"model\" :\n\"example/model\" }\n")); spaced != bound {
		t.Fatal("whitespace changed the bound hash")
	}
	streamed := []byte(`{"stream":true,"model":"example/model","stream_options":{"include_usage":true}}`)
	if chat, _ := WalletAuthHash("POST", "/api/v1/chat/completions?x=1", streamed); chat != bound {
		t.Fatal("a chat route must bind the body without stream and stream_options")
	}
	for _, route := range []string{"/api/v1/completions", "/v1/chat/completions", "/v1/completions"} {
		if chat, _ := WalletAuthHash("POST", route, streamed); chat != bound {
			t.Fatalf("%s is a chat route", route)
		}
	}
	if other, _ := WalletAuthHash("POST", "/api/v1/embeddings", streamed); other == bound {
		t.Fatal("another route must bind the whole body")
	}
	// Only top-level stream flags are left out.
	if nested, _ := WalletAuthHash("POST", "/api/v1/chat/completions", []byte(`{"model":"example/model","extra":{"stream":true}}`)); nested == bound {
		t.Fatal("a nested stream member was dropped")
	}

	h, err := WalletAuthHeader(priv, "post", "Router.Example:8443", "/api/v1/embeddings", bound, now)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(h, ":")
	if len(parts) != 3 {
		t.Fatalf("header %q", h)
	}
	if parts[0] != Base58Encode(pub) || parts[1] != "1790000000" {
		t.Fatalf("address/timestamp: %q", h)
	}
	sig, err := Base58Decode(parts[2])
	if err != nil || len(sig) != 64 {
		t.Fatalf("signature: %v", err)
	}
	want := "trellis:wallet-auth:v2\nPOST\nrouter.example:8443\n/api/v1/embeddings\n1790000000\n" + hex.EncodeToString(sum[:])
	if msg, err := WalletAuthMessage("POST", "router.example:8443", "/api/v1/embeddings", 1790000000, bound); err != nil || msg != want {
		t.Fatalf("message %q %v", msg, err)
	}
	if !ed25519.Verify(pub, []byte(want), sig) {
		t.Fatal("signature does not verify over the message")
	}
	// The signature is for this method, host, path and body: any other request is another message.
	for _, other := range []string{
		"trellis:wallet-auth:v2\nGET\nrouter.example:8443\n/api/v1/embeddings\n1790000000\n" + bound,
		"trellis:wallet-auth:v2\nPOST\nother.example\n/api/v1/embeddings\n1790000000\n" + bound,
		"trellis:wallet-auth:v2\nPOST\nrouter.example:8443\n/api/v1/rerank\n1790000000\n" + bound,
		"trellis:wallet-auth:v2\nPOST\nrouter.example:8443\n/api/v1/embeddings\n1790000000\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"trellis:1790000000:" + bound, // the retired form
	} {
		if ed25519.Verify(pub, []byte(other), sig) {
			t.Fatalf("signature verified over %q", other)
		}
	}
	// No body hashes the empty string.
	if empty, _ := WalletAuthHash("GET", "/api/v1/credits/close", nil); empty != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("empty body: %s", empty)
	}
}

func TestClientWalletAuth(t *testing.T) {
	f, c := newFake(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	host := strings.TrimPrefix(c.BaseURL(), "http://") // the fake router's own 127.0.0.1:<port>
	if c.WalletHost() != host {
		t.Fatalf("WalletHost %q, base URL %q", c.WalletHost(), c.BaseURL())
	}
	// verify recomputes the message from what the server received: the method, the request target, the body bytes.
	verify := func(what string, r recorded, wantHost string) {
		t.Helper()
		parts := strings.Split(r.Header.Get(HeaderWalletAuth), ":")
		if len(parts) != 3 || parts[0] != Base58Encode(pub) {
			t.Fatalf("%s: header %q", what, r.Header.Get(HeaderWalletAuth))
		}
		ts, _ := strconv.ParseInt(parts[1], 10, 64)
		if d := time.Since(time.Unix(ts, 0)); d < -time.Minute || d > time.Minute {
			t.Fatalf("%s: timestamp %d", what, ts)
		}
		target := r.Path
		if r.Query != "" {
			target += "?" + r.Query
		}
		sum, err := WalletAuthHash(r.Method, target, r.Raw)
		if err != nil {
			t.Fatal(err)
		}
		msg, err := WalletAuthMessage(r.Method, wantHost, target, ts, sum)
		if err != nil {
			t.Fatal(err)
		}
		sig, _ := Base58Decode(parts[2])
		if !ed25519.Verify(pub, []byte(msg), sig) {
			t.Fatalf("%s: the signature does not cover the request that was sent (%s %s, body %q)", what, r.Method, target, r.Raw)
		}
	}
	f.on("POST /api/v1/chat/completions", jsonReply(`{"id":"gen-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`))
	if _, err := c.Chat(context.Background(), ChatRequest{Model: "example/model", Messages: []Message{UserMessage("hi")}}, WithRequestWalletKey(priv)); err != nil {
		t.Fatal(err)
	}
	last := f.last()
	if last.Body["model"] != "example/model" {
		t.Fatalf("body %v", last.Body)
	}
	verify("chat", last, host)
	// The chat routes bind the canonical body without the stream flags, not the raw bytes.
	raw := sha256.Sum256(f.rawLast())
	if sum, _ := WalletAuthHash("POST", "/api/v1/chat/completions", f.rawLast()); sum == hex.EncodeToString(raw[:]) {
		t.Fatal("the bound hash is the hash of the raw bytes")
	}
	// The client-wide option signs too; a GET binds the empty body and its query string is part of the signed path.
	c2 := NewClient(WithAPIKey(""), WithBaseURL(c.BaseURL()), WithHTTPClient(c.http), WithWalletKey(priv))
	f.on("GET /api/v1/credits/close", jsonReply(`{"data":[]}`))
	if _, err := c2.CreditClosures(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := f.last()
	if g.Header.Get("Authorization") != "" {
		t.Fatalf("GET headers %v", g.Header)
	}
	verify("GET", g, host)
	f.on("GET /api/v1/models", jsonReply(`{"data":[]}`))
	if _, err := c2.Models(context.Background(), ModelsQuery{Lane: LaneAttested}); err != nil {
		t.Fatal(err)
	}
	if q := f.last(); q.Query == "" {
		t.Fatal("the models query carried no query string")
	} else {
		verify("GET with a query", q, host)
	}
	f.on("POST /api/v1/embeddings", jsonReply(`{"object":"list","data":[]}`))
	if _, err := c2.Embeddings(context.Background(), EmbeddingsRequest{Model: "example/embed", Input: []string{"a", "b"}}); err != nil {
		t.Fatal(err)
	}
	verify("embeddings", f.last(), host)
	// A router reached under another name than its public one: the public host is what is signed.
	c3 := NewClient(WithAPIKey(""), WithBaseURL(c.BaseURL()), WithHTTPClient(c.http), WithWalletKey(priv), WithWalletHost("Router.Example"))
	if _, err := c3.CreditClosures(context.Background()); err != nil {
		t.Fatal(err)
	}
	verify("explicit host", f.last(), "router.example")
}

func TestDepositTxAndClose(t *testing.T) {
	f, c := newFake(t)
	f.on("POST /api/v1/credits/deposit-tx", jsonReply(`{"data":{"transaction":"AQAB","message":"Trellis credits: deposit 12.5 USDC","network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		"amount_usdc":"12.50","amount_units":"12500000","accounts":{"credit":"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi","vault":"11111111111111111111111111111111","depositorToken":"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi","share":"8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"},
		"refund_to":"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi","expires_at_block_height":123456789,"key_hash":"0xabab","note":"refunded to the account it is paid from"}}`))
	d, err := c.DepositTx(context.Background(), "12.50", "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi")
	if err != nil {
		t.Fatal(err)
	}
	if d.Transaction != "AQAB" || d.AmountUnits != "12500000" || d.ExpiresAtBlockHeight != 123456789 || d.Accounts["vault"] != "11111111111111111111111111111111" || d.KeyHash != "0xabab" ||
		d.RefundTo != "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" || d.RefundTo != d.Accounts["depositorToken"] || d.Accounts["share"] != "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR" || d.Note == "" {
		t.Fatalf("deposit: %+v", d)
	}
	got := f.last()
	if got.Body["amount"] != "12.50" || got.Body["payer"] != "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" || len(got.Body) != 2 || got.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("request: %+v", got)
	}
	f.on("POST /api/v1/credits/deposit-tx", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"code":400,"message":"above the cap","type":"deposit_refused"}}`)
	})
	_, err = c.DepositTx(context.Background(), "1000000", "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi")
	if e, ok := err.(*APIError); !ok || e.Type != "deposit_refused" || e.StatusCode != 400 {
		t.Fatalf("error: %v", err)
	}

	// A closure is requested with the key itself and comes back signed by the key; the payer only pays the fee, and
	// the request names no destination: the refund returns to the wallets that deposited. (The exact transaction, and
	// signing it, are in TestContractClosure, against the router's fixture.)
	f.on("POST /api/v1/credits/close", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		io.WriteString(w, `{"data":{"id":"close_1","status":"queued","payer":"8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR","authority":"8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
			"payable_at":"2026-10-13T00:00:00.000Z","transaction":"AQAC","message":"close","accounts":{"refundRequest":"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"},"expires_at_block_height":5,"signed_by_key":true,
			"refunds":[{"depositor":"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi","refund_to":"11111111111111111111111111111111","deposited_units":"12500000","refunded_units":"0"}],"note":"sign it"}}`)
	})
	cl, err := c.CloseCredits(context.Background(), "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR")
	if err != nil {
		t.Fatal(err)
	}
	if !cl.Created || cl.ID != "close_1" || cl.Status != "queued" || cl.Transaction != "AQAC" || cl.ExpiresAtBlockHeight != 5 || !cl.SignedByKey || cl.Payer != "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR" || cl.Accounts["refundRequest"] == "" ||
		len(cl.Refunds) != 1 || cl.Refunds[0].Depositor != "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" || cl.Refunds[0].RefundTo != "11111111111111111111111111111111" || cl.Refunds[0].DepositedUnits != "12500000" || cl.Refunds[0].RefundedUnits != "0" {
		t.Fatalf("closure: %+v", cl)
	}
	got = f.last()
	if got.Path != "/api/v1/credits/close" || got.Body["payer"] != "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR" || len(got.Body) != 1 || got.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("request: %+v", got)
	}
	if _, has := got.Body["refund_to"]; has {
		t.Fatalf("a closure request named a destination: %+v", got.Body)
	}
	// An already open closure answers 200 with transaction null.
	f.on("POST /api/v1/credits/close", jsonReply(`{"data":{"id":"close_1","status":"registered","payer":"y","authority":"y","payable_at":"2026-10-13T00:00:00.000Z","transaction":null,"message":null,"accounts":null,"expires_at_block_height":null,"signed_by_key":false,"refunds":[]}}`))
	cl, err = c.CloseCredits(context.Background(), "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR")
	if err != nil || cl.Created || cl.Transaction != "" || cl.Status != "registered" || cl.SignedByKey || cl.ExpiresAtBlockHeight != 0 || len(cl.Refunds) != 0 {
		t.Fatalf("existing closure: %+v %v", cl, err)
	}
	if _, err := cl.SignAsPayer(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))); !errors.Is(err, ErrNothingToSign) {
		t.Fatalf("nothing to sign: %v", err)
	}
	// The payer is required: without one nothing is sent.
	f.mu.Lock()
	sent := len(f.calls)
	f.mu.Unlock()
	if _, err := c.CloseCredits(context.Background(), ""); err == nil || !strings.Contains(err.Error(), "payer is required") {
		t.Fatalf("empty payer: %v", err)
	}
	f.mu.Lock()
	now := len(f.calls)
	f.mu.Unlock()
	if now != sent {
		t.Fatal("a closure without a payer reached the router")
	}
	f.on("GET /api/v1/credits/close", jsonReply(`{"data":[{"id":"close_1","status":"paid","reason":null,"refund_to":"x","refunds":[{"depositor":"x","refund_to":"xt","owner":"x","amount_units":"100","status":"paid","reason":null,"tx":"sig2"}],"amount_units":"100","requested_at":"2026-10-10T00:00:00.000Z","payable_at":"2026-10-13T00:00:00.000Z","paid_at":"2026-10-13T01:00:00.000Z","register_tx":"sig1","pay_tx":"sig2","cancel_tx":null,"released_at":null}]}`))
	rows, err := c.CreditClosures(context.Background())
	if err != nil || len(rows) != 1 || rows[0].Status != "paid" || rows[0].AmountUnits != "100" || rows[0].PayTx != "sig2" || rows[0].Reason != "" || rows[0].RefundTo != "x" || rows[0].CancelTx != "" || rows[0].ReleasedAt != "" ||
		len(rows[0].Refunds) != 1 || rows[0].Refunds[0].Owner != "x" || rows[0].Refunds[0].RefundTo != "xt" || rows[0].Refunds[0].Status != "paid" || rows[0].Refunds[0].Tx != "sig2" || rows[0].Held() || rows[0].Open() {
		t.Fatalf("list: %+v %v", rows, err)
	}
}
