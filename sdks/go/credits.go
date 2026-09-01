package trellis

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Credits on Trellis are deposited from a Solana wallet into the trellis_credits program and are spend-only: the only
// outflow is an account closure, paid after a delay to the wallets that deposited. The routes need an API key and return
// a transaction (Solana Pay transaction-request shape) for a wallet to sign and send: a deposit and a change of refund
// destination come unsigned, for the depositing wallet; a closure and its cancellation come already signed by the API
// key's own keypair, and a wallet only pays the fee.
//
// An API key is not a withdrawal key. It can ask for a closure and take it back; it cannot choose or change where the
// money goes. No call in this file takes a refund destination from the holder of the key.

// DepositTransaction is the `data` of POST /api/v1/credits/deposit-tx: an unsigned legacy transaction with the payer
// as fee payer. Sign it with the wallet and send it; the key is credited once it is finalized.
type DepositTransaction struct {
	// Transaction is the base64 unsigned transaction.
	Transaction string `json:"transaction"`
	// Message is the Solana Pay display message.
	Message string `json:"message"`
	// Network is the CAIP-2 network id, for example solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp.
	Network    string `json:"network"`
	AmountUSDC string `json:"amount_usdc"`
	// AmountUnits is the amount in USDC base units (6 decimals), as a decimal string.
	AmountUnits string `json:"amount_units"`
	// Accounts names the accounts the transaction touches: `credit` (the key's credit account), `vault`,
	// `depositorToken` (the token account the deposit is paid from) and `share` (the on-chain record of what this wallet
	// put into the key, which is what a closure pays back from).
	Accounts map[string]string `json:"accounts"`
	// RefundTo is the token account a closure refund of this deposit returns to: the one it is paid from, unless the
	// depositing wallet has moved it (RefundDestinationTx). The API key cannot change it.
	RefundTo             string `json:"refund_to"`
	ExpiresAtBlockHeight uint64 `json:"expires_at_block_height"`
	// KeyHash is the key's on-chain hash (the one the credit account is derived from). It is not the hash that names the
	// key in GET /api/v1/keys, which is what ReleaseCreditClosure takes.
	KeyHash string `json:"key_hash"`
	Note    string `json:"note"`
}

// DepositTx asks for an unsigned deposit transaction moving amount USDC (a decimal string with up to 6 decimals, for
// example "12.50") from payer (base58 wallet) into this key's credits. If the key's credits are ever closed, what is
// left of the deposit goes back to that wallet (DepositTransaction.RefundTo).
func (c *Client) DepositTx(ctx context.Context, amount, payer string, opts ...RequestOption) (*DepositTransaction, error) {
	var env struct {
		Data *DepositTransaction `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/credits/deposit-tx", map[string]string{"amount": amount, "payer": payer}, &env, opts); err != nil {
		return nil, err
	}
	if env.Data == nil {
		return nil, wrapf("deposit-tx: no data in the response")
	}
	return env.Data, nil
}

// ClosureRefund is one wallet that deposited to the key, as POST /api/v1/credits/close reports it: who is paid back
// and where. Amounts are USDC base units (6 decimals) as decimal strings.
type ClosureRefund struct {
	// Depositor is the wallet that paid in.
	Depositor string `json:"depositor"`
	// RefundTo is the token account that wallet's refund is paid to: the one it deposited from, unless that wallet moved
	// it itself (RefundDestinationTx).
	RefundTo string `json:"refund_to"`
	// DepositedUnits is what the wallet put into the key: the most it can be paid back.
	DepositedUnits string `json:"deposited_units"`
	// RefundedUnits is what it has already been paid back.
	RefundedUnits string `json:"refunded_units"`
}

// CreditClosure is the `data` of POST /api/v1/credits/close.
//
// A closure is asked for by the key itself: the on-chain close_account needs the signature of the API key's own ed25519
// keypair, which the router derives from the key that made the request and applies before it answers (it keeps
// neither). What is left for a wallet is the fee.
//
// A closure names no destination. What is left in the key returns to the wallets that deposited to it (Refunds), each
// at most what it put in. The key cannot redirect it.
type CreditClosure struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	// Payer is the wallet that signs Transaction as fee payer and sends it: the payer named in the request. Any wallet
	// will do; it pays the fee and a small rent, authorises nothing and receives nothing for it.
	Payer string `json:"payer"`
	// Authority repeats Payer (the name the field had before closures were signed by the key).
	Authority string `json:"authority"`
	// PayableAt is when the refunds can be paid at the earliest (the end of the dispute window).
	PayableAt string `json:"payable_at"`
	// Transaction is the base64 legacy transaction: one close_account instruction. It ALREADY carries the signature of
	// the API key's keypair; the payer adds its own in signature slot 0 (SignAsPayer) and sends it before
	// ExpiresAtBlockHeight. Every byte of it, the key's signature included, must reach the cluster as it came: do not
	// rebuild it. It is empty when the closure is already registered on chain (nothing left to sign).
	Transaction string `json:"transaction"`
	// Message is the Solana Pay display message.
	Message string `json:"message"`
	// Accounts names the on-chain refund request (`refundRequest`). There is no destination account here: see Refunds.
	Accounts map[string]string `json:"accounts"`
	// ExpiresAtBlockHeight is the last block height at which Transaction can land; 0 when there is none.
	ExpiresAtBlockHeight uint64 `json:"expires_at_block_height"`
	// SignedByKey is true when Transaction carries the key's signature (false when it was asked for as the owner wallet).
	SignedByKey bool `json:"signed_by_key"`
	// RequestedBy says who the transaction asks as: "key", or "owner" (the key's registered owner wallet; such a closure
	// cannot be cancelled with the API key). Empty when there is no Transaction.
	RequestedBy string `json:"requested_by"`
	// Owner is the key's registered owner wallet, or empty when none is registered.
	Owner string `json:"owner"`
	// Refunds lists the wallets that deposited to the key: the only places the money can go. It is information, not a
	// choice: nothing in the request or in Transaction can add to it or change it.
	Refunds []ClosureRefund `json:"refunds"`
	Note    string          `json:"note"`
	// Created is true when the router answered 201 (a new closure), false for 200 (one already open).
	Created bool `json:"-"`
}

// ErrNothingToSign is returned by CreditClosure.SignAsPayer when the closure carries no transaction: it is already
// registered on chain.
var ErrNothingToSign = errors.New("trellis: the closure is already registered on chain: there is no transaction to sign")

// signKeySignedAsPayer adds the payer's signature to a transaction the router already signed as the API key (a closure
// or its cancellation). what names the transaction in errors; named is the payer the router's answer names. The payer
// must be that wallet and the transaction's fee payer (signature slot 0), and every other signature (the key's) must
// already be in place and verify; only slot 0 is written.
func signKeySignedAsPayer(what, transaction, named string, payer ed25519.PublicKey, sign func(message []byte) ([]byte, error)) (string, error) {
	if len(payer) != ed25519.PublicKeySize {
		return "", wrapf("the payer must be a %d-byte ed25519 public key", ed25519.PublicKeySize)
	}
	address := Base58Encode(payer)
	if named != "" && named != address {
		return "", wrapf("the %s names %s as payer, not %s: request it with this wallet as payer", what, named, address)
	}
	t, err := parseSignedTx(transaction)
	if err != nil {
		return "", err
	}
	if t.indexOf(payer) != 0 {
		return "", wrapf("%s is not the fee payer of the %s transaction", address, what)
	}
	for i := 1; i < len(t.signers); i++ {
		if !ed25519.Verify(t.signers[i], t.message, t.slot(i)) {
			return "", wrapf("the %s transaction does not carry the signature of %s (the API key's own address)", what, Base58Encode(t.signers[i]))
		}
	}
	return SignTransactionWith(transaction, payer, sign)
}

// localSigner is the public key of an ed25519 private key held in memory, with the function that signs with it.
func localSigner(who string, priv ed25519.PrivateKey) (ed25519.PublicKey, func([]byte) ([]byte, error), error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, nil, wrapf("the %s key must be a %d-byte ed25519 private key", who, ed25519.PrivateKeySize)
	}
	return priv.Public().(ed25519.PublicKey), func(m []byte) ([]byte, error) { return ed25519.Sign(priv, m), nil }, nil
}

// SignAsPayer adds the payer wallet's signature to the closure transaction and returns it (base64) ready to send. The
// payer is the transaction's fee payer and signs in slot 0; the API key's signature, already in place, and every other
// byte stay as the router returned them. It refuses a wallet that is not the closure's payer, and a transaction whose
// other signature is missing or does not verify (it could not land).
func (cl *CreditClosure) SignAsPayer(payer ed25519.PrivateKey) (string, error) {
	pub, sign, err := localSigner("payer", payer)
	if err != nil {
		return "", err
	}
	return cl.SignAsPayerWith(pub, sign)
}

// SignAsPayerWith is SignAsPayer for a wallet that signs somewhere else: sign receives the transaction's message bytes
// and returns payer's 64-byte ed25519 signature over them.
func (cl *CreditClosure) SignAsPayerWith(payer ed25519.PublicKey, sign func(message []byte) ([]byte, error)) (string, error) {
	if cl == nil || cl.Transaction == "" {
		return "", ErrNothingToSign
	}
	return signKeySignedAsPayer("closure", cl.Transaction, cl.Payer, payer, sign)
}

const closureNamesNoDestination = "a closure names no destination: what is left returns to the wallets that funded the key, and the key cannot redirect it"

// CloseCredits requests the closure of this key's credits.
//
// A closure names no destination. What is left in the key returns to the wallets that deposited to it, each at most
// what it put in, to the token account that wallet named on chain (by default the one it paid from), after the dispute
// window. The key cannot redirect it: there is no parameter for a refund address, and the router refuses a request that
// carries one (IsRefundDestinationFixed). A depositor that wants its own share paid somewhere else says so with its own
// wallet (RefundDestinationTx).
//
// payer (base58, required) is the wallet that pays the transaction's fee and a small rent; any wallet will do, and it
// gains nothing by it. The request must be made with the key itself (the bearer): the router signs the closure as the
// key. The answer carries the transaction for payer to sign as fee payer (CreditClosure.SignAsPayer) and send, and
// lists who will be paid back (CreditClosure.Refunds). Once it lands the key is frozen: calls that would spend answer
// 409 `credits_closing` (IsCreditsClosing). Until anything is paid it can be taken back (CancelCreditClosure).
func (c *Client) CloseCredits(ctx context.Context, payer string, opts ...RequestOption) (*CreditClosure, error) {
	if payer == "" {
		return nil, wrapf("CloseCredits: the payer is required (the wallet that pays the transaction fee); %s", closureNamesNoDestination)
	}
	req, err := c.newRequest(ctx, http.MethodPost, "/api/v1/credits/close", map[string]string{"payer": payer}, nil, c.config(opts))
	if err != nil {
		return nil, err
	}
	res, err := c.send(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var env struct {
		Data *CreditClosure `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, wrapf("decoding POST /api/v1/credits/close: %v", err)
	}
	if env.Data == nil {
		return nil, wrapf("credits/close: no data in the response")
	}
	env.Data.Created = res.StatusCode == http.StatusCreated
	return env.Data, nil
}

// CreditClosureCancel is the `data` of POST /api/v1/credits/close/cancel: the transaction that takes a closure back.
// Who may cancel: whoever asked for the closure, or the key's registered owner wallet. The key itself only for a closure
// the key asked for, and once in 60 days (409 cancel_cooldown after that, 403 not_requester for a closure the owner
// wallet asked for). A wallet that only deposited to the key cannot cancel.
type CreditClosureCancel struct {
	// Transaction is the base64 legacy transaction: one cancel_close instruction, ALREADY signed by the API key's
	// keypair. The payer adds its signature in slot 0 (SignAsPayer) and sends it before ExpiresAtBlockHeight; nothing
	// else may change.
	Transaction string `json:"transaction"`
	// Message is the Solana Pay display message.
	Message string `json:"message"`
	// Accounts names the on-chain refund request being withdrawn (`refundRequest`).
	Accounts map[string]string `json:"accounts"`
	// Payer is the wallet that signs Transaction as fee payer and sends it: the payer named in the request.
	Payer                string `json:"payer"`
	ExpiresAtBlockHeight uint64 `json:"expires_at_block_height"`
	// SignedByKey is true: Transaction carries the key's signature.
	SignedByKey bool   `json:"signed_by_key"`
	Note        string `json:"note"`
}

// SignAsPayer adds the payer wallet's signature to the cancellation and returns it (base64) ready to send. The checks
// are the closure's (CreditClosure.SignAsPayer): the wallet is the payer the answer names and the transaction's fee
// payer in slot 0, the key's signature is in place and verifies, and only slot 0 is written.
func (cc *CreditClosureCancel) SignAsPayer(payer ed25519.PrivateKey) (string, error) {
	pub, sign, err := localSigner("payer", payer)
	if err != nil {
		return "", err
	}
	return cc.SignAsPayerWith(pub, sign)
}

// SignAsPayerWith is SignAsPayer for a wallet that signs somewhere else: sign receives the transaction's message bytes
// and returns payer's 64-byte ed25519 signature over them.
func (cc *CreditClosureCancel) SignAsPayerWith(payer ed25519.PublicKey, sign func(message []byte) ([]byte, error)) (string, error) {
	if cc == nil || cc.Transaction == "" {
		return "", wrapf("the cancellation carries no transaction to sign")
	}
	return signKeySignedAsPayer("cancellation", cc.Transaction, cc.Payer, payer, sign)
}

// CancelCreditClosure takes this key's closure back while nothing has been paid. Like the closure, it is requested
// with the key itself (the bearer) and comes back as a transaction already signed by the key, for payer (base58,
// required; any wallet, it pays the fee) to sign as fee payer (CreditClosureCancel.SignAsPayer) and send. Once it
// lands the key is open again with its balance. It names no destination either.
//
// The router answers 400 `nothing_to_cancel` when the key has no closure on chain (IsNothingToCancel) and 409
// `refund_in_progress` once any part of the refund has been paid (IsRefundInProgress): from then on the closure runs
// to its end.
func (c *Client) CancelCreditClosure(ctx context.Context, payer string, opts ...RequestOption) (*CreditClosureCancel, error) {
	if payer == "" {
		return nil, wrapf("CancelCreditClosure: the payer is required (the wallet that pays the transaction fee)")
	}
	var env struct {
		Data *CreditClosureCancel `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/credits/close/cancel", map[string]string{"payer": payer}, &env, opts); err != nil {
		return nil, err
	}
	if env.Data == nil {
		return nil, wrapf("credits/close/cancel: no data in the response")
	}
	return env.Data, nil
}

// CreditClosureRelease is one closure let go by POST /api/v1/credits/close/release.
type CreditClosureRelease struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	// Released is true: the closure is no longer held and is paid once PayableAt has passed.
	Released  bool   `json:"released"`
	PayableAt string `json:"payable_at"`
}

// ReleaseCreditClosure lets a held closure go ahead. A closure is not paid while its key is disabled: disabling a key
// (a leaked one, say) puts the closure it started on hold (CreditClosureSummary.Held), and the balance stays where it
// is until an owner or admin of the account releases it on purpose with this call. The refund still only returns to
// the wallets that deposited to the key.
//
// keyHash is the 64-character lowercase hex hash that names the key in the API (GET /api/v1/keys), never the key
// itself. The call is made with an owner's or admin's key, not with the disabled one. The router answers 404
// `not_found` when that key has no open closure.
func (c *Client) ReleaseCreditClosure(ctx context.Context, keyHash string, opts ...RequestOption) ([]CreditClosureRelease, error) {
	if !isKeyHash(keyHash) {
		return nil, wrapf("ReleaseCreditClosure: keyHash must be the key's hash (64 lowercase hex characters, as GET /api/v1/keys lists it), not the key itself")
	}
	var env struct {
		Data []CreditClosureRelease `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/credits/close/release", map[string]string{"key": keyHash}, &env, opts); err != nil {
		return nil, err
	}
	return env.Data, nil
}

func isKeyHash(s string) bool {
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

// RefundDestinationTransaction is the `data` of POST /api/v1/credits/refund-destination-tx: an UNSIGNED
// set_refund_destination transaction. Only the depositor's own wallet can sign it: it is the fee payer and the only
// signer, and the API key is not in it. It moves nothing now; from the moment it lands, that wallet's share of a
// closure refund of this key goes to RefundTo's USDC token account.
type RefundDestinationTransaction struct {
	// Transaction is the base64 unsigned legacy transaction.
	Transaction string `json:"transaction"`
	// Message is the Solana Pay display message.
	Message string `json:"message"`
	// Accounts names the depositor's on-chain record for this key (`share`) and the token account its refunds will be
	// paid to (`refundToToken`).
	Accounts map[string]string `json:"accounts"`
	// Depositor is the wallet that deposited to the key and signs Transaction.
	Depositor string `json:"depositor"`
	// RefundTo is the wallet whose USDC token account will receive that depositor's refunds.
	RefundTo string `json:"refund_to"`
	// CurrentRefundTo is the token account the refunds go to until Transaction lands.
	CurrentRefundTo      string `json:"current_refund_to"`
	ExpiresAtBlockHeight uint64 `json:"expires_at_block_height"`
	Note                 string `json:"note"`
}

// SignAsDepositor signs the transaction with the depositor's wallet and returns it (base64) ready to send. It refuses
// a wallet that is not the depositor the answer names, and a transaction in which that wallet is not the fee payer and
// the only signer: nobody but the depositor decides where its refund goes.
func (rd *RefundDestinationTransaction) SignAsDepositor(depositor ed25519.PrivateKey) (string, error) {
	pub, sign, err := localSigner("depositor", depositor)
	if err != nil {
		return "", err
	}
	return rd.SignAsDepositorWith(pub, sign)
}

// SignAsDepositorWith is SignAsDepositor for a wallet that signs somewhere else: sign receives the transaction's
// message bytes and returns depositor's 64-byte ed25519 signature over them.
func (rd *RefundDestinationTransaction) SignAsDepositorWith(depositor ed25519.PublicKey, sign func(message []byte) ([]byte, error)) (string, error) {
	if rd == nil || rd.Transaction == "" {
		return "", wrapf("the refund destination change carries no transaction to sign")
	}
	if len(depositor) != ed25519.PublicKeySize {
		return "", wrapf("the depositor must be a %d-byte ed25519 public key", ed25519.PublicKeySize)
	}
	address := Base58Encode(depositor)
	if rd.Depositor != address {
		return "", wrapf("the refund destination change is for depositor %q, not %s: only the wallet that deposited can sign it", rd.Depositor, address)
	}
	t, err := parseSignedTx(rd.Transaction)
	if err != nil {
		return "", err
	}
	if len(t.signers) != 1 || t.indexOf(depositor) != 0 {
		return "", wrapf("%s is not the fee payer and only signer of the refund destination transaction", address)
	}
	return SignTransactionWith(rd.Transaction, depositor, sign)
}

// RefundDestinationTx asks for the unsigned transaction with which depositor (base58), a wallet that deposited to this
// key, moves where ITS refunds from this key are paid: to refundTo's (base58 wallet) USDC token account. It is the
// depositor's decision, made with its own wallet signature (RefundDestinationTransaction.SignAsDepositor); the API key
// that asks for the transaction signs nothing and has no say. Other depositors' refunds are not touched. The router
// answers 404 `not_found` when that wallet never deposited to the key.
func (c *Client) RefundDestinationTx(ctx context.Context, depositor, refundTo string, opts ...RequestOption) (*RefundDestinationTransaction, error) {
	if depositor == "" || refundTo == "" {
		return nil, wrapf("RefundDestinationTx: the depositor (the wallet that deposited and will sign) and refundTo (the wallet its refunds should go to) are both required")
	}
	var env struct {
		Data *RefundDestinationTransaction `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/credits/refund-destination-tx", map[string]string{"depositor": depositor, "refund_to": refundTo}, &env, opts); err != nil {
		return nil, err
	}
	if env.Data == nil {
		return nil, wrapf("credits/refund-destination-tx: no data in the response")
	}
	return env.Data, nil
}

// Closure statuses (CreditClosureSummary.Status).
const (
	// ClosureStatusQueued: asked for; the closure transaction has not been seen on chain yet.
	ClosureStatusQueued = "queued"
	// ClosureStatusRegistered: on chain; the key is frozen and the refunds are paid after PayableAt.
	ClosureStatusRegistered = "registered"
	ClosureStatusPaid       = "paid"
	ClosureStatusRefused    = "refused"
	ClosureStatusFailed     = "failed"
	// ClosureStatusCancelled: taken back before anything was paid (CancelCreditClosure, or on chain).
	ClosureStatusCancelled = "cancelled"
)

// Reasons (CreditClosureSummary.Reason, ClosureRefundPayment.Reason). On a closure that is still queued or registered
// a reason says what it is waiting for, not that it failed.
const (
	// ClosureReasonKeyDisabled: the key was disabled, so its closure is held until an owner or admin releases it
	// (ReleaseCreditClosure).
	ClosureReasonKeyDisabled = "key_disabled"
	// ClosureReasonRefundRateLimited: refunds are paid out at a limited rate; the rest follows.
	ClosureReasonRefundRateLimited = "refund_rate_limited"
	// ClosureReasonRefundDestinationUnavailable: a depositor's token account cannot receive the refund right now.
	ClosureReasonRefundDestinationUnavailable = "refund_destination_unavailable"
	// ClosureReasonDepositorsUnknown: the wallets that deposited to the key could not be read yet.
	ClosureReasonDepositorsUnknown = "depositors_unknown"
	// ClosureReasonCancelledOnChain: the closure was taken back on chain.
	ClosureReasonCancelledOnChain  = "cancelled_on_chain"
	ClosureReasonSanctionedAddress = "sanctioned_address"
	ClosureReasonSubmissionFailed  = "submission_failed"
	// ClosureReasonRefundWorkCapped: one run pays at most 16 depositors of a closure; the rest follow on the next.
	ClosureReasonRefundWorkCapped = "refund_work_capped"
	// ClosureReasonRequestGone: the on-chain request is gone after the refund was planned; the reversal is waiting on
	// a chain read.
	ClosureReasonRequestGone = "request_gone_refund_debited"
)

// Refund payment statuses (ClosureRefundPayment.Status).
const (
	RefundStatusPlanned = "planned"
	RefundStatusPaid    = "paid"
	RefundStatusRefused = "refused"
	// RefundStatusReversed: the closure was cancelled on chain after this payment had been planned and debited; the
	// debit was put back and nothing was sent.
	RefundStatusReversed = "reversed"
)

// ClosureRefundPayment is one depositor's line in a closure's payment plan (GET /api/v1/credits/close).
type ClosureRefundPayment struct {
	// Depositor is the wallet that paid in.
	Depositor string `json:"depositor"`
	// RefundTo is the token account the refund is paid to.
	RefundTo string `json:"refund_to"`
	// Owner is the wallet that owns RefundTo.
	Owner string `json:"owner"`
	// AmountUnits is the refund in USDC base units (6 decimals), as a decimal string.
	AmountUnits string `json:"amount_units"`
	// Status is planned, paid or refused (RefundStatus...).
	Status string `json:"status"`
	// Reason says why a line is waiting or was refused; empty otherwise.
	Reason string `json:"reason"`
	// Tx is the signature of the payment transaction; empty until it is paid.
	Tx string `json:"tx"`
}

// CreditClosureSummary is one row of GET /api/v1/credits/close.
type CreditClosureSummary struct {
	ID string `json:"id"`
	// Status is one of the ClosureStatus... values.
	Status string `json:"status"`
	// Reason is one of the ClosureReason... values, or empty.
	Reason string `json:"reason"`
	// RefundTo is the wallets paid, comma-separated; empty until something is paid. Nobody chose them: they are the
	// owners of the token accounts the depositors named.
	RefundTo string `json:"refund_to"`
	// Refunds is the payment plan, one line per depositor; empty until the plan exists.
	Refunds []ClosureRefundPayment `json:"refunds"`
	// AmountUnits is the total being refunded in USDC base units; empty until the plan exists.
	AmountUnits string `json:"amount_units"`
	RequestedAt string `json:"requested_at"`
	PayableAt   string `json:"payable_at"`
	PaidAt      string `json:"paid_at"`
	RegisterTx  string `json:"register_tx"`
	PayTx       string `json:"pay_tx"`
	// CancelTx is the signature of the transaction that took the closure back; empty unless it was cancelled.
	CancelTx string `json:"cancel_tx"`
	// ReleasedAt is when an owner or admin released the closure (ReleaseCreditClosure); empty if nobody did.
	ReleasedAt string `json:"released_at"`
}

// Open reports whether the closure is still under way: queued or registered, neither paid, refused, failed nor
// cancelled.
func (s CreditClosureSummary) Open() bool {
	return s.Status == ClosureStatusQueued || s.Status == ClosureStatusRegistered
}

// Held reports whether the closure is on hold because its key was disabled: open, with reason `key_disabled`. Nothing
// is paid until an owner or admin of the account releases it (ReleaseCreditClosure).
func (s CreditClosureSummary) Held() bool {
	return s.Open() && s.Reason == ClosureReasonKeyDisabled
}

// CreditClosures lists this key's closures, newest first.
func (c *Client) CreditClosures(ctx context.Context, opts ...RequestOption) ([]CreditClosureSummary, error) {
	var env struct {
		Data []CreditClosureSummary `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, "/api/v1/credits/close", nil, &env, opts); err != nil {
		return nil, err
	}
	return env.Data, nil
}
