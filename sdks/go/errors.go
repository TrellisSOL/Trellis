package trellis

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// APIError is a non-2xx answer from the router, parsed from its error envelope
// {"error": {"code", "message", "type", "metadata"}}.
type APIError struct {
	// StatusCode is the HTTP status.
	StatusCode int
	// Code is error.code from the body (normally the same as StatusCode).
	Code int
	// Type is the stable machine reason, for example rate_limited, model_not_found or invalid_request.
	Type     string
	Message  string
	Metadata map[string]any
	// RetryAfter is parsed from the Retry-After header (seconds or an HTTP date); 0 when absent.
	RetryAfter time.Duration
	// Header and Body are the raw response, for anything the fields above do not cover.
	Header http.Header
	Body   []byte
}

func (e *APIError) Error() string {
	var b strings.Builder
	b.WriteString("trellis: ")
	b.WriteString(strconv.Itoa(e.StatusCode))
	if e.Type != "" {
		b.WriteString(" " + e.Type)
	}
	if e.Message != "" {
		b.WriteString(": " + e.Message)
	}
	return b.String()
}

// IsRateLimited reports whether err is an *APIError for a 429 or a rate_limited reason.
func IsRateLimited(err error) bool {
	var e *APIError
	return errors.As(err, &e) && (e.StatusCode == http.StatusTooManyRequests || e.Type == "rate_limited")
}

// Machine reasons (APIError.Type) a caller has to tell apart from the rest.
const (
	// ErrorTypeCreditsClosing is the 409 a key answers once the closure of its credits is registered on chain: the key
	// is frozen and cannot start new spending, unless the closure is taken back before anything is paid.
	ErrorTypeCreditsClosing = "credits_closing"
	// ErrorTypePaymentNotBound is the answer to a bare transaction signature in X-PAYMENT that came without
	// X-Wallet-Auth from the wallet that paid (401), or with another wallet's (402): a landed payment is public, so the
	// signature alone does not show who is asking.
	ErrorTypePaymentNotBound = "payment_not_bound_to_caller"
	// ErrorTypeRefundDestinationFixed is the 400 a close (or cancel) request answers when it names a refund destination:
	// a closure refund returns to the wallets that deposited to the key and the key cannot choose or change that. This
	// SDK never sends one.
	ErrorTypeRefundDestinationFixed = "refund_destination_fixed"
	// ErrorTypeNothingToCancel is the 400 CancelCreditClosure answers when the key has no closure on chain.
	ErrorTypeNothingToCancel = "nothing_to_cancel"
	// ErrorTypeRefundInProgress is the 409 CancelCreditClosure answers once any part of the refund has been paid: the
	// closure can no longer be taken back.
	ErrorTypeRefundInProgress = "refund_in_progress"
)

// IsCreditsClosing reports whether err is the router's 409 `credits_closing`: this key's credits are being closed and
// refunded, so it cannot start new calls. Do not retry: use another key (the key only serves again if its closure is
// taken back with CancelCreditClosure before anything is paid). ClosureID names the closure.
func IsCreditsClosing(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Type == ErrorTypeCreditsClosing
}

// ClosureID returns the id of the closure that froze the key (metadata.closure), when err is a `credits_closing`
// error that carries it. It is the id CloseCredits and CreditClosures report.
func ClosureID(err error) (string, bool) {
	var e *APIError
	if !errors.As(err, &e) || e.Type != ErrorTypeCreditsClosing {
		return "", false
	}
	id, ok := e.Metadata["closure"].(string)
	return id, ok && id != ""
}

// IsRefundDestinationFixed reports whether err is the router's 400 `refund_destination_fixed`: the request named where
// a closure refund should go. Nobody holding the key decides that: the refund returns to the wallets that deposited.
// CloseCredits and CancelCreditClosure never send a destination, so this comes from a hand-built request or an older
// client; do not retry it with another address.
func IsRefundDestinationFixed(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Type == ErrorTypeRefundDestinationFixed
}

// IsNothingToCancel reports whether err is the router's 400 `nothing_to_cancel`: this key has no closure on chain to
// take back (none was sent, or it was already cancelled or paid).
func IsNothingToCancel(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Type == ErrorTypeNothingToCancel
}

// IsRefundInProgress reports whether err is the router's 409 `refund_in_progress`: the closure has already been paid
// in part or in full and can no longer be cancelled. It is final: do not retry.
func IsRefundInProgress(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Type == ErrorTypeRefundInProgress
}

// IsPaymentNotBound reports whether err is the router's `payment_not_bound_to_caller`: a transaction signature was
// presented in X-PAYMENT without X-Wallet-Auth signed, over that same request, by the wallet that paid. Nothing was
// redeemed: present it again with the wallet's signature (WithPaymentSignature), or pay with a signed x402 payload.
func IsPaymentNotBound(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Type == ErrorTypePaymentNotBound
}

// RetryAfter returns how long the router asked the caller to wait, when err is an *APIError that carries it.
func RetryAfter(err error) (time.Duration, bool) {
	var e *APIError
	if errors.As(err, &e) && e.RetryAfter > 0 {
		return e.RetryAfter, true
	}
	return 0, false
}

func parseRetryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		if secs <= 0 {
			return 0
		}
		return time.Duration(secs * float64(time.Second))
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := t.Sub(now); d > 0 {
			return d
		}
	}
	return 0
}

func newAPIError(res *http.Response, body []byte) *APIError {
	e := &APIError{StatusCode: res.StatusCode, Header: res.Header, Body: body, RetryAfter: parseRetryAfter(res.Header.Get("Retry-After"), time.Now())}
	var env struct {
		Error *struct {
			Code     json.RawMessage `json:"code"`
			Message  string          `json:"message"`
			Type     string          `json:"type"`
			Metadata map[string]any  `json:"metadata"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &env) == nil && env.Error != nil {
		e.Message = env.Error.Message
		e.Type = env.Error.Type
		e.Metadata = env.Error.Metadata
		if n, err := strconv.Atoi(strings.Trim(string(env.Error.Code), `"`)); err == nil {
			e.Code = n
		} else if e.Type == "" && len(env.Error.Code) > 0 {
			e.Type = strings.Trim(string(env.Error.Code), `"`)
		}
	}
	if e.Code == 0 {
		e.Code = res.StatusCode
	}
	if e.Message == "" {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		e.Message = msg
	}
	return e
}

// ErrStreamRequired is returned by Chat when the request asks for a stream.
var ErrStreamRequired = errors.New("trellis: use ChatStream for streaming requests")

func wrapf(format string, a ...any) error { return fmt.Errorf("trellis: "+format, a...) }
