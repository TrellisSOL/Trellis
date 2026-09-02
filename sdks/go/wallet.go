package trellis

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// X-Wallet-Auth lets a Solana wallet spend the change left from its per-call payments (and lets host operators act)
// without an API key:
//
//	X-Wallet-Auth: <base58 address>:<unixSeconds>:<base58 signature>
//
// where the signature is ed25519 over the UTF-8 bytes of
//
//	trellis:wallet-auth:v2\n<METHOD>\n<host>\n<path>\n<unixSeconds>\n<sha256 hex>
//
// (no trailing newline). METHOD is upper case; host is the router's public host[:port] in lower case; path is the
// request target as sent, from the first "/" through the query string; the last field is what the route binds
// (WalletAuthHash). A signature therefore stands for one method, one path and one router. The router accepts it for 5
// minutes and once per (address, timestamp, method, host, path, hash). Only this form is accepted: the earlier
// "trellis:<unixSeconds>:<sha256>" named no method, path or host and is refused.

const (
	// HeaderWalletAuth is the wallet authentication header.
	HeaderWalletAuth = "X-Wallet-Auth"
	// HeaderPayment carries a per-call payment: a signed x402 payload (base64 JSON), or the base58 signature of a
	// payment that already landed. The second form is accepted only together with HeaderWalletAuth from the wallet
	// that paid (WithPaymentSignature).
	HeaderPayment = "X-PAYMENT"
	// WalletAuthVersion is the first line of the text behind an X-Wallet-Auth signature.
	WalletAuthVersion = "trellis:wallet-auth:v2"
)

// WalletAuthMessage is the text a wallet signs for X-Wallet-Auth: the version line, the method (written in upper
// case), the router's host[:port] (written in lower case), the path with its query string, the unix time and a SHA-256
// in hex, joined by "\n". It refuses a field that is empty or carries a line break, since one field per line is what
// keeps two requests from sharing a signature.
func WalletAuthMessage(method, host, path string, unixSeconds int64, sha256Hex string) (string, error) {
	sum := strings.ToLower(sha256Hex)
	if !isSHA256Hex(sum) {
		return "", wrapf("%s: the bound hash must be 64 hex characters", HeaderWalletAuth)
	}
	if method == "" || host == "" || !strings.HasPrefix(path, "/") {
		return "", wrapf("%s: a method, the router's host and a path starting with / are required", HeaderWalletAuth)
	}
	fields := []string{WalletAuthVersion, strings.ToUpper(method), strings.ToLower(host), path, strconv.FormatInt(unixSeconds, 10), sum}
	for _, f := range fields {
		if strings.ContainsAny(f, "\r\n") {
			return "", wrapf("%s: fields must not contain line breaks", HeaderWalletAuth)
		}
	}
	return strings.Join(fields, "\n"), nil
}

func isSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// WalletAuthHost is the host[:port] of a router URL as X-Wallet-Auth names it: lower case, with the scheme's default
// port (80 for http, 443 for https) left out, the way a URL's host omits it.
func WalletAuthHost(u *url.URL) string {
	if u == nil {
		return ""
	}
	host := strings.ToLower(u.Host)
	switch port := u.Port(); {
	case port == "":
	case (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80"):
		host = strings.TrimSuffix(host, ":"+port)
	}
	return host
}

// The chat routes bind the request without its stream flags, so one signature covers a call whether or not it streams.
var walletAuthChatRoutes = map[string]bool{
	"/api/v1/chat/completions": true,
	"/api/v1/completions":      true,
	"/v1/chat/completions":     true,
	"/v1/completions":          true,
}

const walletAuthHostsPrefix = "/api/v1/hosts/"

// WalletAuthHash is the SHA-256 (hex) a route binds an X-Wallet-Auth signature to, for a request with this method,
// path (the query string, if any, is ignored here) and JSON body (nil or empty for none):
//
//   - the chat routes (/api/v1/chat/completions, /api/v1/completions and their /v1 forms): the canonical JSON
//     (CanonicalJSON: keys sorted recursively, no whitespace) of the body without its top-level `stream` and
//     `stream_options` members;
//   - any other request with a JSON body: the canonical JSON of the body;
//   - GET /api/v1/hosts/{id}: the text "GET /api/v1/hosts/<url-encoded id>", so the signature names the host it reads;
//   - any other request without a body: the empty string.
func WalletAuthHash(method, path string, body []byte) (string, error) {
	pathname, _, _ := strings.Cut(path, "?")
	if len(bytes.TrimSpace(body)) > 0 {
		var canonical []byte
		var err error
		if walletAuthChatRoutes[pathname] {
			canonical, err = canonicalJSONWithout(body, "stream", "stream_options")
		} else {
			canonical, err = CanonicalJSON(body)
		}
		if err != nil {
			return "", wrapf("%s: the body is not JSON: %v", HeaderWalletAuth, err)
		}
		return sha256Hex(canonical), nil
	}
	if strings.EqualFold(method, http.MethodGet) && strings.HasPrefix(pathname, walletAuthHostsPrefix) {
		if seg := pathname[len(walletAuthHostsPrefix):]; seg != "" && !strings.Contains(seg, "/") {
			// The router reads the id out of the path and encodes it again; an id it cannot decode stays as it is.
			id := seg
			if dec, err := url.PathUnescape(seg); err == nil && utf8.ValidString(dec) {
				id = dec
			}
			return sha256Hex([]byte("GET " + walletAuthHostsPrefix + encodeURIComponent(id))), nil
		}
	}
	return sha256Hex(nil), nil
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// canonicalJSONWithout is CanonicalJSON of a JSON text with the named top-level members of its object removed.
func canonicalJSONWithout(text []byte, drop ...string) ([]byte, error) {
	p := &jsonParser{s: text}
	p.skipSpace()
	val, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.i != len(p.s) {
		return nil, p.fail("trailing data")
	}
	if obj, ok := val.(*jsonObject); ok {
		kept := make([]jsonMember, 0, len(obj.members))
	members:
		for _, m := range obj.members {
			for _, d := range drop {
				if u16Equal(m.key, d) {
					continue members
				}
			}
			kept = append(kept, m)
		}
		val = &jsonObject{members: kept}
	}
	var out bytes.Buffer
	writeCanonical(&out, val)
	return out.Bytes(), nil
}

// u16Equal reports whether a parsed JSON string equals an ASCII name.
func u16Equal(k u16, name string) bool {
	if len(k) != len(name) {
		return false
	}
	for i := range k {
		if k[i] != uint16(name[i]) {
			return false
		}
	}
	return true
}

// IsTransactionSignature reports whether s has the shape of a Solana transaction signature: 64 to 88 base58
// characters. In X-PAYMENT the router reads such a value as the bare signature of a landed payment, as opposed to a
// signed x402 payload (base64 JSON).
func IsTransactionSignature(s string) bool {
	if len(s) < 64 || len(s) > 88 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if base58Index[s[i]] < 0 {
			return false
		}
	}
	return true
}

const upperHex = "0123456789ABCDEF"

// encodeURIComponent escapes s the way JavaScript's encodeURIComponent does: every byte of its UTF-8 form except
// A-Z a-z 0-9 - _ . ! ~ * ' ( ) becomes %XX.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', strings.IndexByte("-_.!~*'()", c) >= 0:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(upperHex[c>>4])
			b.WriteByte(upperHex[c&0xF])
		}
	}
	return b.String()
}

// WalletAuthValue assembles the header value from its parts: "<base58 address>:<unixSeconds>:<base58 signature>". Use
// it with WalletAuthMessage (or WalletAuthRequestMessage) when the wallet signs somewhere else, such as a hardware or
// remote signer.
func WalletAuthValue(address string, unixSeconds int64, signature []byte) string {
	return address + ":" + strconv.FormatInt(unixSeconds, 10) + ":" + Base58Encode(signature)
}

// WalletAuthHeader builds the X-Wallet-Auth value for one request, signed by the wallet's ed25519 private key at time
// now: method, host (the router's public host[:port]), path (with the query string) and the hash the route binds
// (WalletAuthHash).
func WalletAuthHeader(priv ed25519.PrivateKey, method, host, path, sha256Hex string, now time.Time) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", wrapf("%s: the wallet key must be a %d-byte ed25519 private key", HeaderWalletAuth, ed25519.PrivateKeySize)
	}
	ts := now.Unix()
	msg, err := WalletAuthMessage(method, host, path, ts, sha256Hex)
	if err != nil {
		return "", err
	}
	return WalletAuthValue(Base58Encode(priv.Public().(ed25519.PublicKey)), ts, ed25519.Sign(priv, []byte(msg))), nil
}

// WalletAuthRequestMessage is WalletAuthMessage for an *http.Request as it will be sent: its method, its request
// target (req.URL.RequestURI(): the path and the query string) and the hash of body, the JSON bytes it carries (nil for
// none). host is the router's public host[:port]; empty means the host of the request URL (WalletAuthHost). The
// router checks the signature against the path it receives, so the request has to reach it with its path unchanged.
func WalletAuthRequestMessage(req *http.Request, body []byte, host string, unixSeconds int64) (string, error) {
	if req == nil || req.URL == nil {
		return "", wrapf("%s: no request to sign", HeaderWalletAuth)
	}
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	if host == "" {
		host = WalletAuthHost(req.URL)
	}
	path := req.URL.RequestURI()
	sum, err := WalletAuthHash(method, path, body)
	if err != nil {
		return "", err
	}
	return WalletAuthMessage(method, host, path, unixSeconds, sum)
}

// WalletAuthRequestHeader builds the X-Wallet-Auth value for an *http.Request as it will be sent (see
// WalletAuthRequestMessage), signed by the wallet's ed25519 private key at time now.
func WalletAuthRequestHeader(priv ed25519.PrivateKey, req *http.Request, body []byte, host string, now time.Time) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", wrapf("%s: the wallet key must be a %d-byte ed25519 private key", HeaderWalletAuth, ed25519.PrivateKeySize)
	}
	ts := now.Unix()
	msg, err := WalletAuthRequestMessage(req, body, host, ts)
	if err != nil {
		return "", err
	}
	return WalletAuthValue(Base58Encode(priv.Public().(ed25519.PublicKey)), ts, ed25519.Sign(priv, []byte(msg))), nil
}
