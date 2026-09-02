package solana

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/bits"
	"net/http"
	"strconv"
	"strings"

	trellis "example.com/trellis/sdk-go"
	sol "github.com/gagliardetto/solana-go"
)

// x402 `exact` on Solana: a call without an API key answers 402 with a Requirement; the payer builds one USDC
// TransferChecked to payTo's associated token account, with the facilitator (extra.feePayer) as fee payer, signs it and
// retries with X-PAYMENT. The router co-signs, submits and serves the call; the settlement comes back in
// X-PAYMENT-RESPONSE. Anything not spent stays as change on the wallet's account (see trellis.WalletAuthHeader).
//
// The fee payer signs what the payer built, so the router bounds everything that could cost it SOL before it signs, and
// refuses the rest. BuildExactPayment stays inside those bounds and refuses to build anything outside them:
//
//   - the fee payer is account 0, its signature slot is left empty, and no instruction names it: it is not a funder, an
//     authority, a source, a destination or a program;
//   - exactly two signatures are required: the fee payer's and the payer's;
//   - at most one SetComputeUnitLimit (MaxComputeUnitLimit) and one SetComputeUnitPrice
//     (MaxComputeUnitPriceMicroLamports), and a priority fee of at most MaxPriorityFeeLamports;
//   - at most one idempotent creation of payTo's associated token account, funded by the payer;
//   - exactly one TransferChecked.

// Header names.
const (
	// HeaderPayment carries the payment: a signed x402 payload, or the bare signature of a payment that already
	// landed. The second form needs X-Wallet-Auth from the wallet that paid: see BindPaymentSignature.
	HeaderPayment         = trellis.HeaderPayment
	HeaderPaymentRequired = "PAYMENT-REQUIRED"
	HeaderPaymentResponse = "X-PAYMENT-RESPONSE"
	// X402Version is the x402 wire version the SDK sends.
	X402Version = 1
)

// Requirement is one entry of the 402's `accepts`.
type Requirement struct {
	Scheme            string `json:"scheme"`
	Network           string `json:"network"`
	MaxAmountRequired string `json:"maxAmountRequired"`
	Resource          string `json:"resource"`
	Description       string `json:"description"`
	MimeType          string `json:"mimeType"`
	// PayTo is the seller's wallet. The transfer goes to its USDC associated token account, not to PayTo itself.
	PayTo             string `json:"payTo"`
	MaxTimeoutSeconds int    `json:"maxTimeoutSeconds"`
	// Asset is the USDC mint.
	Asset string           `json:"asset"`
	Extra RequirementExtra `json:"extra"`
}

// RequirementExtra is the Solana-specific part of a requirement.
type RequirementExtra struct {
	// FeePayer co-signs and pays the SOL fee; nil when an external facilitator settles and no sponsored payment can be built.
	FeePayer *string `json:"feePayer"`
	Decimals int     `json:"decimals"`
}

// AmountUnits is MaxAmountRequired as an integer (USDC base units).
func (r Requirement) AmountUnits() (uint64, error) {
	n, err := strconv.ParseUint(r.MaxAmountRequired, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("trellis/solana: maxAmountRequired %q: %w", r.MaxAmountRequired, err)
	}
	return n, nil
}

// PaymentRequired is what a 402 says.
type PaymentRequired struct {
	X402Version int           `json:"x402Version"`
	Error       string        `json:"error"`
	Accepts     []Requirement `json:"accepts"`
	// PriceUSDC, Model and PaymentError come from the router's v1 body only.
	PriceUSDC string `json:"price_usdc"`
	Model     string `json:"model"`
	// PaymentError is the reason a payment on the previous attempt was rejected, for example
	// invalid_exact_svm_payload_transaction_blockhash_expired or payment_already_claimed.
	PaymentError string `json:"payment_error"`
}

// Exact returns the first `exact` requirement on a Solana network, or an error naming what was offered.
func (p *PaymentRequired) Exact() (*Requirement, error) {
	for i := range p.Accepts {
		r := &p.Accepts[i]
		if r.Scheme == "exact" && strings.HasPrefix(r.Network, "solana:") {
			return r, nil
		}
	}
	return nil, errors.New("trellis/solana: the 402 offers no exact Solana requirement")
}

// v2 PaymentRequired, as the PAYMENT-REQUIRED header carries it.
type paymentRequiredV2 struct {
	X402Version int    `json:"x402Version"`
	Error       string `json:"error"`
	Resource    struct {
		URL         string `json:"url"`
		Description string `json:"description"`
		MimeType    string `json:"mimeType"`
	} `json:"resource"`
	Accepts []struct {
		Scheme            string           `json:"scheme"`
		Network           string           `json:"network"`
		Amount            string           `json:"amount"`
		Asset             string           `json:"asset"`
		PayTo             string           `json:"payTo"`
		MaxTimeoutSeconds int              `json:"maxTimeoutSeconds"`
		Extra             RequirementExtra `json:"extra"`
	} `json:"accepts"`
}

// ParsePaymentRequired reads a 402: the v1 JSON body first, else the PAYMENT-REQUIRED header (x402 v2). The body is
// read in full and put back on the response, so it can still be read after this call.
func ParsePaymentRequired(resp *http.Response) (*PaymentRequired, error) {
	if resp.StatusCode != http.StatusPaymentRequired {
		return nil, fmt.Errorf("trellis/solana: expected a 402, got %d", resp.StatusCode)
	}
	var body []byte
	if resp.Body != nil {
		var err error
		body, err = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		resp.Body = io.NopCloser(bytes.NewReader(body))
	}
	var pr PaymentRequired
	if len(body) > 0 {
		if err := json.Unmarshal(body, &pr); err == nil && len(pr.Accepts) > 0 {
			return &pr, nil
		}
	}
	if h := resp.Header.Get(HeaderPaymentRequired); h != "" {
		raw, err := base64.StdEncoding.DecodeString(h)
		if err != nil {
			return nil, fmt.Errorf("trellis/solana: %s is not base64: %w", HeaderPaymentRequired, err)
		}
		var v2 paymentRequiredV2
		if err := json.Unmarshal(raw, &v2); err != nil {
			return nil, fmt.Errorf("trellis/solana: %s: %w", HeaderPaymentRequired, err)
		}
		pr.X402Version = v2.X402Version
		if pr.Error == "" {
			pr.Error = v2.Error
		}
		pr.Accepts = pr.Accepts[:0]
		for _, a := range v2.Accepts {
			pr.Accepts = append(pr.Accepts, Requirement{Scheme: a.Scheme, Network: a.Network, MaxAmountRequired: a.Amount, Resource: v2.Resource.URL, Description: v2.Resource.Description, MimeType: v2.Resource.MimeType, PayTo: a.PayTo, MaxTimeoutSeconds: a.MaxTimeoutSeconds, Asset: a.Asset, Extra: a.Extra})
		}
		if len(pr.Accepts) > 0 {
			return &pr, nil
		}
	}
	if pr.PaymentError != "" || pr.Error != "" {
		return &pr, nil
	}
	return nil, errors.New("trellis/solana: the 402 carries no x402 requirement in its body or PAYMENT-REQUIRED header")
}

// What the router's fee payer signs (its default limits). A payment outside them is refused by the router, so
// BuildExactPayment does not build one.
const (
	// MaxComputeUnitLimit is the largest SetComputeUnitLimit (compute units).
	MaxComputeUnitLimit = 200_000
	// MaxComputeUnitPriceMicroLamports is the largest SetComputeUnitPrice (micro-lamports per compute unit).
	MaxComputeUnitPriceMicroLamports = 5_000_000
	// MaxPriorityFeeLamports is the largest priority fee, ceil(limit * price / 1e6) lamports.
	MaxPriorityFeeLamports = 10_000
	// DefaultComputeUnitsPerInstruction is what the runtime budgets for each instruction (compute-budget ones aside)
	// when a transaction sets no limit; MaxTransactionComputeUnits caps the sum. A price without a limit is charged on
	// that budget.
	DefaultComputeUnitsPerInstruction = 200_000
	MaxTransactionComputeUnits        = 1_400_000
)

// ErrOutsideExactBounds is wrapped by every refusal to build a payment the router's fee payer would not sign.
var ErrOutsideExactBounds = errors.New("trellis/solana: the payment is outside what the router's fee payer signs")

func outside(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrOutsideExactBounds, fmt.Sprintf(format, a...))
}

// PriorityFeeLamports is the priority fee the runtime charges: ceil(unitLimit * microLamportsPerUnit / 1e6) lamports.
func PriorityFeeLamports(unitLimit uint32, microLamportsPerUnit uint64) uint64 {
	hi, lo := bits.Mul64(uint64(unitLimit), microLamportsPerUnit)
	lo, carry := bits.Add64(lo, 999_999, 0)
	hi += carry
	if hi >= 1_000_000 {
		return math.MaxUint64
	}
	q, _ := bits.Div64(hi, lo, 1_000_000)
	return q
}

// ExactOptions tunes BuildExactPayment. The zero value pays exactly maxAmountRequired with the SPL Token program, with
// no compute-budget instruction (no priority fee).
type ExactOptions struct {
	// Amount overrides the amount paid (USDC base units); it must be at least maxAmountRequired. 0 pays the requirement.
	Amount uint64
	// CreateDestinationATA adds an idempotent create of payTo's token account before the transfer. The PAYER funds it
	// (its rent comes from the paying wallet's SOL): the router refuses a creation funded by its fee payer. Only needed
	// when the seller's account may not exist yet.
	CreateDestinationATA bool
	// TokenProgram is the SPL Token program of the mint: TokenProgram (default) or Token2022Program.
	TokenProgram PublicKey
	// ComputeUnitLimit adds SetComputeUnitLimit; at most MaxComputeUnitLimit. 0 adds none.
	ComputeUnitLimit uint32
	// ComputeUnitPriceMicroLamports adds SetComputeUnitPrice (a priority fee, paid by the router's fee payer); at most
	// MaxComputeUnitPriceMicroLamports, and the fee it makes, PriorityFeeLamports(limit, price), at most
	// MaxPriorityFeeLamports. Without a ComputeUnitLimit the fee is counted on the runtime's default budget
	// (DefaultComputeUnitsPerInstruction for the transfer, and again for the token account creation). 0 adds none.
	ComputeUnitPriceMicroLamports uint64
}

// priorityFee checks the compute-budget options against the bounds and returns the priority fee they make.
// instructions is the number of instructions that are not compute-budget ones.
func (o *ExactOptions) priorityFee(instructions int) (uint64, error) {
	if o.ComputeUnitLimit > MaxComputeUnitLimit {
		return 0, outside("compute unit limit %d is above %d", o.ComputeUnitLimit, MaxComputeUnitLimit)
	}
	if o.ComputeUnitPriceMicroLamports > MaxComputeUnitPriceMicroLamports {
		return 0, outside("compute unit price %d is above %d micro-lamports", o.ComputeUnitPriceMicroLamports, MaxComputeUnitPriceMicroLamports)
	}
	if o.ComputeUnitPriceMicroLamports == 0 {
		return 0, nil
	}
	limit := o.ComputeUnitLimit
	if limit == 0 {
		limit = uint32(min(MaxTransactionComputeUnits, DefaultComputeUnitsPerInstruction*instructions))
	}
	fee := PriorityFeeLamports(limit, o.ComputeUnitPriceMicroLamports)
	if fee > MaxPriorityFeeLamports {
		return 0, outside("a price of %d micro-lamports on %d compute units is a priority fee of %d lamports, above %d: lower the price or set a lower ComputeUnitLimit", o.ComputeUnitPriceMicroLamports, limit, fee, MaxPriorityFeeLamports)
	}
	return fee, nil
}

// ExactPayment is a built, payer-signed `exact` transaction.
type ExactPayment struct {
	// Transaction is the legacy transaction; its fee payer signature slot is zero until the facilitator co-signs.
	Transaction *sol.Transaction
	// Base64 is the serialized transaction, the `payload.transaction` of X-PAYMENT.
	Base64      string
	Network     string
	Amount      uint64
	Payer       PublicKey
	FeePayer    PublicKey
	Source      PublicKey
	Destination PublicKey
	// PriorityFeeLamports is what the fee payer is charged on top of the base fee (0 without a compute unit price).
	PriorityFeeLamports uint64
}

// Header is the X-PAYMENT value for this payment.
func (p *ExactPayment) Header() string { return PaymentHeader(p.Network, p.Base64) }

// Instruction tags.
const (
	tokenTransferChecked   = 12
	ataCreateIdempotent    = 1
	computeSetUnitLimit    = 2
	computeSetUnitPrice    = 3
	transferCheckedDataLen = 10
)

// transferCheckedData is the 10-byte SPL Token TransferChecked payload: [12, amount u64 LE, decimals].
func transferCheckedData(amount uint64, decimals byte) []byte {
	d := make([]byte, transferCheckedDataLen)
	d[0] = tokenTransferChecked
	binary.LittleEndian.PutUint64(d[1:9], amount)
	d[9] = decimals
	return d
}

// BuildExactPayment builds and signs the transaction that pays req: fee payer = req.Extra.FeePayer (account 0,
// signature left empty, named by no instruction), one SPL TransferChecked of USDC from the payer's associated token
// account to payTo's, signed by payer. recentBlockhash comes from an RPC (LatestBlockhash). opts may be nil. Options
// that would take the payment outside what the router's fee payer signs are refused (ErrOutsideExactBounds).
//
// The message is a legacy one whose accounts are in order of first appearance within the signer / writable groups, so
// every Trellis SDK builds the same bytes from the same inputs.
func BuildExactPayment(req Requirement, payer Signer, recentBlockhash string, opts *ExactOptions) (*ExactPayment, error) {
	if opts == nil {
		opts = &ExactOptions{}
	}
	if req.Scheme != "exact" {
		return nil, fmt.Errorf("trellis/solana: scheme %q is not exact", req.Scheme)
	}
	if req.Extra.FeePayer == nil || *req.Extra.FeePayer == "" {
		return nil, errNoFeePayer
	}
	required, err := req.AmountUnits()
	if err != nil {
		return nil, err
	}
	amount := opts.Amount
	if amount == 0 {
		amount = required
	}
	if amount < required {
		return nil, fmt.Errorf("trellis/solana: amount %d is below the %d required", amount, required)
	}
	decimals := req.Extra.Decimals
	if decimals == 0 {
		decimals = USDCDecimals
	}
	if decimals != USDCDecimals {
		return nil, fmt.Errorf("trellis/solana: the router accepts %d decimals, the requirement says %d", USDCDecimals, decimals)
	}
	feePayer, err := ParseAddress(*req.Extra.FeePayer)
	if err != nil {
		return nil, err
	}
	payTo, err := ParseAddress(req.PayTo)
	if err != nil {
		return nil, err
	}
	mint, err := ParseAddress(req.Asset)
	if err != nil {
		return nil, err
	}
	blockhash, err := sol.HashFromBase58(recentBlockhash)
	if err != nil {
		return nil, fmt.Errorf("trellis/solana: recent blockhash: %w", err)
	}
	tokenProgram := opts.TokenProgram
	if tokenProgram.IsZero() {
		tokenProgram = TokenProgram
	}
	if !tokenProgram.Equals(TokenProgram) && !tokenProgram.Equals(Token2022Program) {
		return nil, outside("the token program must be SPL Token or Token-2022, not %s", tokenProgram)
	}
	owner := payer.PublicKey()
	if owner.Equals(feePayer) {
		return nil, outside("the payer cannot be the fee payer")
	}
	source, err := AssociatedTokenAddressWithProgram(owner, mint, tokenProgram)
	if err != nil {
		return nil, err
	}
	destination, err := AssociatedTokenAddressWithProgram(payTo, mint, tokenProgram)
	if err != nil {
		return nil, err
	}
	budgeted := 1
	if opts.CreateDestinationATA {
		budgeted = 2
	}
	fee, err := opts.priorityFee(budgeted)
	if err != nil {
		return nil, err
	}
	var ixs []sol.Instruction
	if opts.ComputeUnitLimit > 0 {
		ixs = append(ixs, sol.NewInstruction(ComputeBudgetProgram, sol.AccountMetaSlice{}, binary.LittleEndian.AppendUint32([]byte{computeSetUnitLimit}, opts.ComputeUnitLimit)))
	}
	if opts.ComputeUnitPriceMicroLamports > 0 {
		ixs = append(ixs, sol.NewInstruction(ComputeBudgetProgram, sol.AccountMetaSlice{}, binary.LittleEndian.AppendUint64([]byte{computeSetUnitPrice}, opts.ComputeUnitPriceMicroLamports)))
	}
	if opts.CreateDestinationATA {
		// create_associated_token_account_idempotent(funder, ata, owner, mint, system, token), data = [1]. The funder is
		// the payer: the fee payer pays the transaction fee and nothing else.
		ixs = append(ixs, sol.NewInstruction(AssociatedTokenProgram, sol.AccountMetaSlice{
			sol.NewAccountMeta(owner, true, true),
			sol.NewAccountMeta(destination, true, false),
			sol.NewAccountMeta(payTo, false, false),
			sol.NewAccountMeta(mint, false, false),
			sol.NewAccountMeta(SystemProgram, false, false),
			sol.NewAccountMeta(tokenProgram, false, false),
		}, []byte{ataCreateIdempotent}))
	}
	ixs = append(ixs, sol.NewInstruction(tokenProgram, sol.AccountMetaSlice{
		sol.NewAccountMeta(source, true, false),
		sol.NewAccountMeta(mint, false, false),
		sol.NewAccountMeta(destination, true, false),
		sol.NewAccountMeta(owner, false, true),
	}, transferCheckedData(amount, byte(decimals))))
	tx, err := compileLegacy(feePayer, ixs, blockhash)
	if err != nil {
		return nil, err
	}
	if err := signAs(tx, payer); err != nil {
		return nil, err
	}
	// The same checks the router's verifier makes, on the finished transaction: whatever the inputs were (a payTo or a
	// mint that is the fee payer's own address, say), nothing outside the bounds leaves this function.
	if _, err := inspectExact(tx, feePayer, payTo, mint); err != nil {
		return nil, err
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("trellis/solana: serializing the transaction: %w", err)
	}
	return &ExactPayment{Transaction: tx, Base64: base64.StdEncoding.EncodeToString(raw), Network: req.Network, Amount: amount, Payer: owner, FeePayer: feePayer, Source: source, Destination: destination, PriorityFeeLamports: fee}, nil
}

// compileLegacy compiles instructions into an unsigned legacy transaction the way the reference client does: the fee
// payer first, then every account in order of first appearance (an instruction's program before its accounts), grouped
// as writable signers, read-only signers, writable non-signers, read-only non-signers.
func compileLegacy(feePayer PublicKey, ixs []sol.Instruction, blockhash sol.Hash) (*sol.Transaction, error) {
	type meta struct {
		key              PublicKey
		signer, writable bool
	}
	var order []*meta
	byKey := map[PublicKey]*meta{}
	get := func(k PublicKey) *meta {
		if m, ok := byKey[k]; ok {
			return m
		}
		m := &meta{key: k}
		byKey[k] = m
		order = append(order, m)
		return m
	}
	fp := get(feePayer)
	fp.signer, fp.writable = true, true
	for _, ix := range ixs {
		get(ix.ProgramID())
		for _, a := range ix.Accounts() {
			m := get(a.PublicKey)
			m.signer = m.signer || a.IsSigner
			m.writable = m.writable || a.IsWritable
		}
	}
	if len(order) > 256 {
		return nil, errors.New("trellis/solana: too many accounts for one transaction")
	}
	var keys sol.PublicKeySlice
	index := map[PublicKey]uint16{}
	var header sol.MessageHeader
	for group := 0; group < 4; group++ {
		signer, writable := group < 2, group%2 == 0
		for _, m := range order {
			if m.signer != signer || m.writable != writable {
				continue
			}
			index[m.key] = uint16(len(keys))
			keys = append(keys, m.key)
			switch group {
			case 0:
				header.NumRequiredSignatures++
			case 1:
				header.NumRequiredSignatures++
				header.NumReadonlySignedAccounts++
			case 3:
				header.NumReadonlyUnsignedAccounts++
			}
		}
	}
	msg := sol.Message{AccountKeys: keys, Header: header, RecentBlockhash: blockhash}
	for _, ix := range ixs {
		data, err := ix.Data()
		if err != nil {
			return nil, fmt.Errorf("trellis/solana: instruction data: %w", err)
		}
		c := sol.CompiledInstruction{ProgramIDIndex: index[ix.ProgramID()], Accounts: []uint16{}, Data: data}
		for _, a := range ix.Accounts() {
			c.Accounts = append(c.Accounts, index[a.PublicKey])
		}
		msg.Instructions = append(msg.Instructions, c)
	}
	return &sol.Transaction{Message: msg, Signatures: make([]sol.Signature, header.NumRequiredSignatures)}, nil
}

// exactTransfer is what inspectExact reads out of a payment.
type exactTransfer struct {
	payer, source, destination PublicKey
	amount                     uint64
	priorityFeeLamports        uint64
}

// inspectExact applies the router's own checks to an `exact` payment (its verifier's rules, in its order) and returns
// the transfer it carries: account 0 is feePayer with an empty signature slot and no instruction names it; exactly two
// signatures are required and the payer's is valid; at most one SetComputeUnitLimit and one SetComputeUnitPrice inside
// the caps, and their priority fee inside its cap; at most one idempotent creation of payTo's associated token account,
// funded by the payer; exactly one TransferChecked of mint to payTo's associated token account.
func inspectExact(tx *sol.Transaction, feePayer, payTo, mint PublicKey) (*exactTransfer, error) {
	m := &tx.Message
	keys := m.AccountKeys
	if len(m.AddressTableLookups) != 0 {
		return nil, outside("address lookup tables are not allowed")
	}
	if len(keys) == 0 || !keys[0].Equals(feePayer) {
		return nil, outside("the fee payer must be account 0")
	}
	n := int(m.Header.NumRequiredSignatures)
	if n != 2 || len(tx.Signatures) != 2 {
		return nil, outside("exactly two signatures are required (the fee payer's and the payer's), not %d", n)
	}
	var transfer *exactTransfer
	var tokenProgram, ataFunder PublicKey
	var unitLimit, unitPrice *uint64
	budgeted := 0
	for _, ix := range m.Instructions {
		if int(ix.ProgramIDIndex) >= len(keys) {
			return nil, outside("an instruction names a program that is not in the message")
		}
		if ix.ProgramIDIndex == 0 {
			return nil, outside("the fee payer is named as a program")
		}
		for _, a := range ix.Accounts {
			if int(a) >= len(keys) {
				return nil, outside("an instruction names an account that is not in the message")
			}
			if a == 0 || keys[a].Equals(feePayer) {
				return nil, outside("an instruction names the fee payer: it pays the fee and nothing else")
			}
		}
		program := keys[ix.ProgramIDIndex]
		data := []byte(ix.Data)
		switch {
		case program.Equals(ComputeBudgetProgram):
			switch {
			case len(data) == 5 && data[0] == computeSetUnitLimit && len(ix.Accounts) == 0 && unitLimit == nil:
				v := uint64(binary.LittleEndian.Uint32(data[1:]))
				if v > MaxComputeUnitLimit {
					return nil, outside("compute unit limit %d is above %d", v, MaxComputeUnitLimit)
				}
				unitLimit = &v
			case len(data) == 9 && data[0] == computeSetUnitPrice && len(ix.Accounts) == 0 && unitPrice == nil:
				v := binary.LittleEndian.Uint64(data[1:])
				if v > MaxComputeUnitPriceMicroLamports {
					return nil, outside("compute unit price %d is above %d micro-lamports", v, MaxComputeUnitPriceMicroLamports)
				}
				unitPrice = &v
			default:
				return nil, outside("only one SetComputeUnitLimit and one SetComputeUnitPrice are allowed")
			}
			continue
		}
		budgeted++
		switch {
		case program.Equals(AssociatedTokenProgram):
			if !ataFunder.IsZero() || len(ix.Accounts) != 6 || len(data) != 1 || data[0] != ataCreateIdempotent {
				return nil, outside("only one idempotent creation of payTo's token account is allowed")
			}
			acc := func(i int) PublicKey { return keys[ix.Accounts[i]] }
			token := acc(5)
			if !token.Equals(TokenProgram) && !token.Equals(Token2022Program) {
				return nil, outside("the token account creation names another token program")
			}
			want, err := AssociatedTokenAddressWithProgram(payTo, mint, token)
			if err != nil {
				return nil, err
			}
			if !acc(1).Equals(want) || !acc(2).Equals(payTo) || !acc(3).Equals(mint) || !acc(4).Equals(SystemProgram) {
				return nil, outside("the token account creation is not for payTo's associated token account")
			}
			ataFunder = acc(0)
		case program.Equals(TokenProgram) || program.Equals(Token2022Program):
			if transfer != nil {
				return nil, outside("exactly one transfer is allowed")
			}
			if len(data) != transferCheckedDataLen || data[0] != tokenTransferChecked || len(ix.Accounts) != 4 {
				return nil, outside("the transfer must be one TransferChecked of source, mint, destination, authority")
			}
			if int(data[9]) != USDCDecimals {
				return nil, outside("the transfer must name %d decimals", USDCDecimals)
			}
			tokenProgram = program
			transfer = &exactTransfer{source: keys[ix.Accounts[0]], destination: keys[ix.Accounts[2]], payer: keys[ix.Accounts[3]], amount: binary.LittleEndian.Uint64(data[1:9])}
			if !keys[ix.Accounts[1]].Equals(mint) {
				return nil, outside("the transfer is of another mint")
			}
		default:
			return nil, outside("instruction for %s: only compute-budget, token account creation and TransferChecked are allowed", program)
		}
	}
	if transfer == nil {
		return nil, outside("the payment carries no TransferChecked")
	}
	destination, err := AssociatedTokenAddressWithProgram(payTo, mint, tokenProgram)
	if err != nil {
		return nil, err
	}
	if !transfer.destination.Equals(destination) {
		return nil, outside("the transfer does not go to payTo's associated token account")
	}
	if !ataFunder.IsZero() && !ataFunder.Equals(transfer.payer) {
		return nil, outside("payTo's token account must be funded by the payer")
	}
	if unitPrice != nil {
		limit := uint64(min(MaxTransactionComputeUnits, DefaultComputeUnitsPerInstruction*budgeted))
		if unitLimit != nil {
			limit = *unitLimit
		}
		transfer.priorityFeeLamports = PriorityFeeLamports(uint32(limit), *unitPrice)
		if transfer.priorityFeeLamports > MaxPriorityFeeLamports {
			return nil, outside("the priority fee of %d lamports is above %d", transfer.priorityFeeLamports, MaxPriorityFeeLamports)
		}
	}
	if !keys[1].Equals(transfer.payer) {
		return nil, outside("the other required signer must be the payer")
	}
	if tx.Signatures[0] != (sol.Signature{}) {
		return nil, outside("the fee payer's signature slot must be left empty")
	}
	msg, err := m.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("trellis/solana: serializing the message: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(transfer.payer.Bytes()), msg, tx.Signatures[1][:]) {
		return nil, outside("the payer's signature is missing or does not verify")
	}
	return transfer, nil
}

// signAs fills signer's slot of tx.Signatures with its signature over the message, leaving the other slots as they are.
func signAs(tx *sol.Transaction, signer Signer) error {
	msg, err := tx.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("trellis/solana: serializing the message: %w", err)
	}
	n := int(tx.Message.Header.NumRequiredSignatures)
	if len(tx.Signatures) != n {
		sigs := make([]sol.Signature, n)
		copy(sigs, tx.Signatures)
		tx.Signatures = sigs
	}
	pk := signer.PublicKey()
	for i := 0; i < n && i < len(tx.Message.AccountKeys); i++ {
		if tx.Message.AccountKeys[i].Equals(pk) {
			sig, err := signer.Sign(msg)
			if err != nil {
				return fmt.Errorf("trellis/solana: signing: %w", err)
			}
			if len(sig) != 64 {
				return fmt.Errorf("trellis/solana: the signer returned %d bytes, want 64", len(sig))
			}
			copy(tx.Signatures[i][:], sig)
			return nil
		}
	}
	return fmt.Errorf("trellis/solana: %s is not a required signer of the transaction", pk)
}

// PaymentHeader is the X-PAYMENT value: base64 of {"x402Version":1,"scheme":"exact","network":...,"payload":{"transaction":...}}.
func PaymentHeader(network, txBase64 string) string {
	type payload struct {
		Transaction string `json:"transaction"`
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(struct {
		X402Version int     `json:"x402Version"`
		Scheme      string  `json:"scheme"`
		Network     string  `json:"network"`
		Payload     payload `json:"payload"`
	}{X402Version, "exact", network, payload{txBase64}})
	return base64.StdEncoding.EncodeToString(bytes.TrimRight(buf.Bytes(), "\n"))
}

// PaymentResponse is the settlement a paid call carries in X-PAYMENT-RESPONSE (and PAYMENT-RESPONSE).
type PaymentResponse struct {
	Success bool `json:"success"`
	// Transaction is the on-chain signature of the settled payment.
	Transaction string `json:"transaction"`
	Network     string `json:"network"`
	Payer       string `json:"payer"`
	// ErrorReason is set on a failed settlement (x402 v2 reports it in PAYMENT-RESPONSE beside the 402).
	ErrorReason string `json:"errorReason,omitempty"`
}

// ParsePaymentResponse reads X-PAYMENT-RESPONSE (or PAYMENT-RESPONSE) from a response. It returns nil, nil when the
// response carries neither.
func ParsePaymentResponse(h http.Header) (*PaymentResponse, error) {
	v := h.Get(HeaderPaymentResponse)
	if v == "" {
		v = h.Get("PAYMENT-RESPONSE")
	}
	if v == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, fmt.Errorf("trellis/solana: %s is not base64: %w", HeaderPaymentResponse, err)
	}
	var r PaymentResponse
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("trellis/solana: %s: %w", HeaderPaymentResponse, err)
	}
	return &r, nil
}
