package solana

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	trellis "example.com/trellis/sdk-go"
	sol "github.com/gagliardetto/solana-go"
)

// Tabs (the `tab` x402 scheme, program trellis_tab): the payer opens a tab by moving a cap of USDC into escrow and
// naming a session key; every request then carries a voucher, the session key's signature over the cumulative amount
// used so far. On close the payee is paid cumulative_used and the payer gets the rest back.
//
// The program id comes from GET /facilitator/supported (kinds[].extra.program for scheme "tab") or
// GET /api/v1/status (facilitator.tab_program): it differs per network, so it is always passed in. It is also part of
// what every voucher signs, together with the tab's created_at, which the payer reads from the chain once open_tab has
// landed (FetchTab).
//
// A tab may be bound to a rulebook of the trellis_rules program (the payer's own). The rulebook is consulted when USDC
// is committed, so open_tab and top_up take the rulebook group (RulebookAccounts) for such a tab; close and reclaim
// never take it.

// Anchor discriminators of trellis_tab.
var (
	OpenTabDiscriminator    = [8]byte{76, 59, 11, 59, 218, 58, 30, 59}
	TopUpDiscriminator      = [8]byte{236, 225, 96, 9, 60, 106, 77, 208}
	ReclaimDiscriminator    = [8]byte{44, 177, 236, 249, 145, 109, 163, 186}
	TabAccountDiscriminator = [8]byte{194, 242, 40, 53, 214, 169, 9, 172}
)

// MaxTabLifetime is how far from the moment it is opened a tab's expiry may be: the program refuses more.
const MaxTabLifetime = 30 * 24 * time.Hour

// ErrTabExpiry is wrapped by the refusal to open a tab whose expiry the program would not accept: already past, or
// more than MaxTabLifetime away.
var ErrTabExpiry = errors.New("trellis/solana: the tab's expiry is out of range")

// now is the clock the expiry check reads.
var now = time.Now

// TabProgram is a deployment of trellis_tab and the USDC mint it escrows.
type TabProgram struct {
	ProgramID PublicKey
	Mint      PublicKey
}

// NewTabProgram is the program at programID with the mainnet USDC mint. Set Mint for another network.
func NewTabProgram(programID PublicKey) TabProgram {
	return TabProgram{ProgramID: programID, Mint: USDCMint}
}

func le64(v uint64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, v)
	return b
}

// ConfigAddress is the program's config PDA: seeds ["config"].
func (p TabProgram) ConfigAddress() (PublicKey, error) {
	pk, _, err := sol.FindProgramAddress([][]byte{[]byte("config")}, p.ProgramID)
	return pk, err
}

// TabAddress is the tab PDA for a payer, payee and tab id: seeds ["tab", payer, payee, tab_id u64 LE].
func (p TabProgram) TabAddress(payer, payee PublicKey, tabID uint64) (PublicKey, error) {
	pk, _, err := sol.FindProgramAddress([][]byte{[]byte("tab"), payer.Bytes(), payee.Bytes(), le64(tabID)}, p.ProgramID)
	return pk, err
}

// EscrowAddress is the escrow token account PDA of a tab: seeds ["escrow", tab].
func (p TabProgram) EscrowAddress(tab PublicKey) (PublicKey, error) {
	pk, _, err := sol.FindProgramAddress([][]byte{[]byte("escrow"), tab.Bytes()}, p.ProgramID)
	return pk, err
}

// EnforcerAddress is the PDA the tab program signs with when it records a commitment against a rulebook: seeds
// ["enforcer"]. open_tab and top_up always name it, rulebook or not.
func (p TabProgram) EnforcerAddress() (PublicKey, error) {
	pk, _, err := sol.FindProgramAddress([][]byte{[]byte("enforcer")}, p.ProgramID)
	return pk, err
}

// RulebookAccounts is the rulebook group open_tab and top_up take for a tab bound to a rulebook: the payer's Rulebook,
// the trellis_rules program's config and the trellis_rules program itself (the one the tab program's config names).
type RulebookAccounts struct {
	Rulebook     PublicKey
	RulesConfig  PublicKey
	RulesProgram PublicKey
}

// NewRulebookAccounts is the rulebook group for rulebook under the trellis_rules program rulesProgram; the rules config
// is that program's PDA with seeds ["config"].
func NewRulebookAccounts(rulesProgram, rulebook PublicKey) (*RulebookAccounts, error) {
	if rulesProgram.IsZero() || rulebook.IsZero() {
		return nil, errors.New("trellis/solana: a rulebook-bound tab needs the rulebook and the rules program id")
	}
	cfg, _, err := sol.FindProgramAddress([][]byte{[]byte("config")}, rulesProgram)
	if err != nil {
		return nil, err
	}
	return &RulebookAccounts{Rulebook: rulebook, RulesConfig: cfg, RulesProgram: rulesProgram}, nil
}

// RulebookAddress is the rulebook PDA of owner under the trellis_rules program: seeds ["rulebook", owner, id u64 LE].
func RulebookAddress(rulesProgram, owner PublicKey, rulebookID uint64) (PublicKey, error) {
	pk, _, err := sol.FindProgramAddress([][]byte{[]byte("rulebook"), owner.Bytes(), le64(rulebookID)}, rulesProgram)
	return pk, err
}

// rulebookGroup returns the three optional account slots of open_tab / top_up and the enforcer PDA. Without a rulebook
// each slot holds the tab program's id, which is how an absent optional account is written.
func (p TabProgram) rulebookGroup(rules *RulebookAccounts) (rulebook, rulesConfig, rulesProgram *sol.AccountMeta, enforcer PublicKey, err error) {
	if enforcer, err = p.EnforcerAddress(); err != nil {
		return nil, nil, nil, PublicKey{}, err
	}
	if rules == nil {
		none := func() *sol.AccountMeta { return sol.NewAccountMeta(p.ProgramID, false, false) }
		return none(), none(), none(), enforcer, nil
	}
	if rules.Rulebook.IsZero() || rules.RulesConfig.IsZero() || rules.RulesProgram.IsZero() {
		return nil, nil, nil, PublicKey{}, errors.New("trellis/solana: a rulebook-bound tab needs the rulebook, the rules config and the rules program (NewRulebookAccounts)")
	}
	return sol.NewAccountMeta(rules.Rulebook, true, false), sol.NewAccountMeta(rules.RulesConfig, false, false), sol.NewAccountMeta(rules.RulesProgram, false, false), enforcer, nil
}

// checkTabExpiry refuses an expiry the program would refuse: not after now, or more than MaxTabLifetime after it.
func checkTabExpiry(expiry int64, at time.Time) error {
	if expiry <= at.Unix() {
		return fmt.Errorf("%w: %d is not in the future", ErrTabExpiry, expiry)
	}
	if latest := at.Add(MaxTabLifetime).Unix(); expiry > latest {
		return fmt.Errorf("%w: %d is more than %d days from now; the latest a tab opened now may expire is %d", ErrTabExpiry, expiry, int(MaxTabLifetime.Hours())/24, latest)
	}
	return nil
}

// OpenTabInstruction builds open_tab: payer (the wallet, which signs and pays the fee) escrows cap USDC base units for
// payee until expiry (unix seconds, at most MaxTabLifetime from now), with sessionKey signing the vouchers. rules is the
// rulebook group for a tab bound to a rulebook (the payer's own), nil for none. It returns the instruction and the
// tab's address.
func (p TabProgram) OpenTabInstruction(payer, payee PublicKey, cap uint64, expiry int64, sessionKey PublicKey, tabID uint64, rules *RulebookAccounts) (sol.Instruction, PublicKey, error) {
	if cap == 0 {
		return nil, PublicKey{}, errors.New("trellis/solana: the tab cap must be above 0")
	}
	if err := checkTabExpiry(expiry, now()); err != nil {
		return nil, PublicKey{}, err
	}
	config, err := p.ConfigAddress()
	if err != nil {
		return nil, PublicKey{}, err
	}
	tab, err := p.TabAddress(payer, payee, tabID)
	if err != nil {
		return nil, PublicKey{}, err
	}
	escrow, err := p.EscrowAddress(tab)
	if err != nil {
		return nil, PublicKey{}, err
	}
	payerToken, err := AssociatedTokenAddress(payer, p.Mint)
	if err != nil {
		return nil, PublicKey{}, err
	}
	rulebook, rulesConfig, rulesProgram, enforcer, err := p.rulebookGroup(rules)
	if err != nil {
		return nil, PublicKey{}, err
	}
	data := make([]byte, 0, 8+8+8+8+32)
	data = append(data, OpenTabDiscriminator[:]...)
	data = append(data, le64(tabID)...)
	data = append(data, le64(cap)...)
	data = append(data, le64(uint64(expiry))...)
	data = append(data, sessionKey.Bytes()...)
	ix := sol.NewInstruction(p.ProgramID, sol.AccountMetaSlice{
		sol.NewAccountMeta(payer, true, true),
		sol.NewAccountMeta(payee, false, false),
		sol.NewAccountMeta(config, false, false),
		sol.NewAccountMeta(tab, true, false),
		sol.NewAccountMeta(p.Mint, false, false),
		sol.NewAccountMeta(escrow, true, false),
		sol.NewAccountMeta(payerToken, true, false),
		rulebook,
		sol.NewAccountMeta(TokenProgram, false, false),
		sol.NewAccountMeta(SystemProgram, false, false),
		rulesConfig,
		rulesProgram,
		sol.NewAccountMeta(enforcer, false, false),
	}, data)
	return ix, tab, nil
}

// OpenTabTransaction wraps OpenTabInstruction in an unsigned legacy transaction with payer as fee payer, for the wallet
// to sign and send. It returns the transaction and the tab's address.
func (p TabProgram) OpenTabTransaction(payer, payee PublicKey, cap uint64, expiry int64, sessionKey PublicKey, tabID uint64, rules *RulebookAccounts, recentBlockhash string) (*sol.Transaction, PublicKey, error) {
	ix, tab, err := p.OpenTabInstruction(payer, payee, cap, expiry, sessionKey, tabID, rules)
	if err != nil {
		return nil, PublicKey{}, err
	}
	blockhash, err := sol.HashFromBase58(recentBlockhash)
	if err != nil {
		return nil, PublicKey{}, fmt.Errorf("trellis/solana: recent blockhash: %w", err)
	}
	tx, err := sol.NewTransaction([]sol.Instruction{ix}, blockhash, sol.TransactionPayer(payer))
	if err != nil {
		return nil, PublicKey{}, fmt.Errorf("trellis/solana: building the transaction: %w", err)
	}
	return tx, tab, nil
}

// TopUpInstruction builds top_up: payer adds amount USDC base units to the tab's escrow (and cap). A tab bound to a
// rulebook (TabAccount.Rulebook) passes its rulebook group: the top-up is a new commitment under it. nil for none.
func (p TabProgram) TopUpInstruction(payer, tab PublicKey, amount uint64, rules *RulebookAccounts) (sol.Instruction, error) {
	if amount == 0 {
		return nil, errors.New("trellis/solana: the top-up must be above 0")
	}
	config, err := p.ConfigAddress()
	if err != nil {
		return nil, err
	}
	escrow, err := p.EscrowAddress(tab)
	if err != nil {
		return nil, err
	}
	payerToken, err := AssociatedTokenAddress(payer, p.Mint)
	if err != nil {
		return nil, err
	}
	rulebook, rulesConfig, rulesProgram, enforcer, err := p.rulebookGroup(rules)
	if err != nil {
		return nil, err
	}
	data := append(append([]byte{}, TopUpDiscriminator[:]...), le64(amount)...)
	return sol.NewInstruction(p.ProgramID, sol.AccountMetaSlice{
		sol.NewAccountMeta(payer, false, true),
		sol.NewAccountMeta(config, false, false),
		sol.NewAccountMeta(tab, true, false),
		sol.NewAccountMeta(p.Mint, false, false),
		sol.NewAccountMeta(escrow, true, false),
		sol.NewAccountMeta(payerToken, true, false),
		sol.NewAccountMeta(TokenProgram, false, false),
		rulebook,
		rulesConfig,
		rulesProgram,
		sol.NewAccountMeta(enforcer, false, false),
	}, data), nil
}

// ReclaimInstruction builds reclaim: after the tab's expiry and the program's grace period (or at any time once the
// payee has closed), anyone may deliver the escrow: the payee's posted voucher to the payee's USDC account, the rest to
// the payer's. Nobody's signature is needed beyond the fee payer of the transaction that carries it; payer is only the
// wallet that gets the tab's rent back. No rulebook account is involved, whatever the tab was opened with.
func (p TabProgram) ReclaimInstruction(payer, payee, tab PublicKey) (sol.Instruction, error) {
	config, err := p.ConfigAddress()
	if err != nil {
		return nil, err
	}
	escrow, err := p.EscrowAddress(tab)
	if err != nil {
		return nil, err
	}
	payerToken, err := AssociatedTokenAddress(payer, p.Mint)
	if err != nil {
		return nil, err
	}
	payeeToken, err := AssociatedTokenAddress(payee, p.Mint)
	if err != nil {
		return nil, err
	}
	return sol.NewInstruction(p.ProgramID, sol.AccountMetaSlice{
		sol.NewAccountMeta(payer, true, false),
		sol.NewAccountMeta(tab, true, false),
		sol.NewAccountMeta(config, false, false),
		sol.NewAccountMeta(p.Mint, false, false),
		sol.NewAccountMeta(escrow, true, false),
		sol.NewAccountMeta(payerToken, true, false),
		sol.NewAccountMeta(payeeToken, true, false),
		sol.NewAccountMeta(TokenProgram, false, false),
	}, append([]byte{}, ReclaimDiscriminator[:]...)), nil
}

// TabAddress is NewTabProgram(programID).TabAddress.
func TabAddress(programID, payer, payee PublicKey, tabID uint64) (PublicKey, error) {
	return NewTabProgram(programID).TabAddress(payer, payee, tabID)
}

// OpenTabTransaction is NewTabProgram(programID).OpenTabTransaction (mainnet USDC).
func OpenTabTransaction(programID, payer, payee PublicKey, cap uint64, expiry int64, sessionKey PublicKey, tabID uint64, rules *RulebookAccounts, recentBlockhash string) (*sol.Transaction, PublicKey, error) {
	return NewTabProgram(programID).OpenTabTransaction(payer, payee, cap, expiry, sessionKey, tabID, rules, recentBlockhash)
}

// TopUpInstruction is NewTabProgram(programID).TopUpInstruction (mainnet USDC).
func TopUpInstruction(programID, payer, tab PublicKey, amount uint64, rules *RulebookAccounts) (sol.Instruction, error) {
	return NewTabProgram(programID).TopUpInstruction(payer, tab, amount, rules)
}

// ReclaimInstruction is NewTabProgram(programID).ReclaimInstruction (mainnet USDC).
func ReclaimInstruction(programID, payer, payee, tab PublicKey) (sol.Instruction, error) {
	return NewTabProgram(programID).ReclaimInstruction(payer, payee, tab)
}

// TabAccount is the on-chain Tab account.
type TabAccount struct {
	Payer      PublicKey
	Payee      PublicKey
	SessionKey PublicKey
	Mint       PublicKey
	TabID      uint64
	Cap        uint64
	PostedUsed uint64
	PostedSeq  uint64
	Expiry     int64
	CreatedAt  int64
	Rulebook   *PublicKey
	Bump       uint8
	EscrowBump uint8
}

// DecodeTabAccount reads a Tab account's data (for example from getAccountInfo). A closed or reclaimed tab has no
// account at all.
func DecodeTabAccount(data []byte) (*TabAccount, error) {
	const fixed = 8 + 32*4 + 8*6 + 1
	if len(data) < fixed+2 || [8]byte(data[:8]) != TabAccountDiscriminator {
		return nil, errors.New("trellis/solana: the account data is not a Tab")
	}
	t := &TabAccount{}
	off := 8
	for _, dst := range []*PublicKey{&t.Payer, &t.Payee, &t.SessionKey, &t.Mint} {
		*dst = sol.PublicKeyFromBytes(data[off : off+32])
		off += 32
	}
	u := func() uint64 { v := binary.LittleEndian.Uint64(data[off:]); off += 8; return v }
	t.TabID, t.Cap, t.PostedUsed, t.PostedSeq = u(), u(), u(), u()
	t.Expiry, t.CreatedAt = int64(u()), int64(u())
	switch data[off] {
	case 0:
		off++
	case 1:
		if len(data) < off+1+32+2 {
			return nil, errors.New("trellis/solana: the Tab account is truncated")
		}
		rb := sol.PublicKeyFromBytes(data[off+1 : off+33])
		t.Rulebook = &rb
		off += 33
	default:
		return nil, errors.New("trellis/solana: the Tab account has a bad rulebook tag")
	}
	t.Bump, t.EscrowBump = data[off], data[off+1]
	return t, nil
}

// ErrTabNotFound is returned by FetchTab when there is no account at the address: the tab was never opened (or
// open_tab has not landed yet), or it was closed or reclaimed.
var ErrTabNotFound = errors.New("trellis/solana: no tab account at that address")

// FetchTab reads a tab's account from a Solana JSON-RPC endpoint (getAccountInfo, confirmed) and returns it decoded.
// Call it once open_tab has landed: TabAccount.CreatedAt is what every voucher for this opening of the tab signs
// (NewTabSession). The account must be owned by this tab program and sit at the program's own address for its payer,
// payee and tab id: anything else carrying Tab-shaped bytes is refused. A nil client uses http.DefaultClient.
func (p TabProgram) FetchTab(ctx context.Context, client *http.Client, rpcURL string, tab PublicKey) (*TabAccount, error) {
	var out struct {
		Value *struct {
			Owner string   `json:"owner"`
			Data  []string `json:"data"`
		} `json:"value"`
	}
	if err := rpcCall(ctx, client, rpcURL, "getAccountInfo", []any{tab.String(), map[string]string{"encoding": "base64", "commitment": "confirmed"}}, &out); err != nil {
		return nil, err
	}
	if out.Value == nil {
		return nil, ErrTabNotFound
	}
	if out.Value.Owner != p.ProgramID.String() {
		return nil, fmt.Errorf("trellis/solana: %s is owned by %s, not by the tab program %s", tab, out.Value.Owner, p.ProgramID)
	}
	if len(out.Value.Data) < 1 {
		return nil, errors.New("trellis/solana: getAccountInfo answered without account data")
	}
	data, err := base64.StdEncoding.DecodeString(out.Value.Data[0])
	if err != nil {
		return nil, fmt.Errorf("trellis/solana: getAccountInfo data: %w", err)
	}
	t, err := DecodeTabAccount(data)
	if err != nil {
		return nil, err
	}
	if want, err := p.TabAddress(t.Payer, t.Payee, t.TabID); err != nil || !want.Equals(tab) {
		return nil, fmt.Errorf("trellis/solana: the account at %s is not the tab of the payer, payee and tab id it names", tab)
	}
	return t, nil
}

// ---- Vouchers ------------------------------------------------------------------------------------------------------

// TabSession issues the vouchers for one opening of one tab: it holds the session key, the tab program's id and the
// tab's created_at (both part of what a voucher signs) and the last seq and cumulative amount, so each Voucher call
// supersedes the one before. It is safe for concurrent use.
type TabSession struct {
	mu             sync.Mutex
	programID      PublicKey
	tab            PublicKey
	createdAt      int64
	sessionKey     ed25519.PrivateKey
	seq            uint64
	cumulativeUsed uint64
	last           *SignedVoucher
}

// NewTabSession starts issuing vouchers for the tab at address tab of the tab program programID, opened at createdAt,
// with sessionKey (the key named in open_tab). createdAt is the open tab's Tab.created_at: read it from the chain after
// open_tab lands (FetchTab), never guess it, since the router verifies vouchers against the chain's value. None of the
// three has a default. Seq starts at 1; resume with Resume after reading the tab's posted_seq / a previous voucher.
func NewTabSession(programID, tab PublicKey, createdAt int64, sessionKey ed25519.PrivateKey) (*TabSession, error) {
	switch {
	case programID.IsZero():
		return nil, errors.New("trellis/solana: a tab session needs the tab program's id: it is part of what a voucher signs")
	case tab.IsZero():
		return nil, errors.New("trellis/solana: a tab session needs the tab's address")
	case createdAt <= 0:
		return nil, errors.New("trellis/solana: a tab session needs the open tab's created_at (read the Tab account after open_tab lands: FetchTab)")
	case len(sessionKey) != ed25519.PrivateKeySize:
		return nil, fmt.Errorf("trellis/solana: a session key is a %d-byte ed25519 private key", ed25519.PrivateKeySize)
	}
	return &TabSession{programID: programID, tab: tab, createdAt: createdAt, sessionKey: sessionKey}, nil
}

// Resume sets the last seq and cumulative amount already vouched, so the next voucher continues from them.
func (s *TabSession) Resume(seq, cumulativeUsed uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq, s.cumulativeUsed, s.last = seq, cumulativeUsed, nil
}

// Tab is the tab's address.
func (s *TabSession) Tab() PublicKey { return s.tab }

// ProgramID is the tab program the vouchers are for.
func (s *TabSession) ProgramID() PublicKey { return s.programID }

// CreatedAt is the opening of the tab the vouchers are for (Tab.created_at).
func (s *TabSession) CreatedAt() int64 { return s.createdAt }

// SessionKey is the public key the vouchers verify against.
func (s *TabSession) SessionKey() PublicKey { return SessionPublicKey(s.sessionKey) }

// Seq and CumulativeUsed are the last voucher's values (0 before the first).
func (s *TabSession) Seq() uint64 { s.mu.Lock(); defer s.mu.Unlock(); return s.seq }
func (s *TabSession) CumulativeUsed() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cumulativeUsed
}

// Voucher signs a new voucher for cumulativeUsed (USDC base units, everything served so far, including the request it
// accompanies), with the next seq. cumulativeUsed may not go down.
func (s *TabSession) Voucher(cumulativeUsed uint64) (*SignedVoucher, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cumulativeUsed < s.cumulativeUsed {
		return nil, fmt.Errorf("trellis/solana: cumulative_used %d is below the %d already vouched", cumulativeUsed, s.cumulativeUsed)
	}
	if s.seq == ^uint64(0) {
		return nil, errors.New("trellis/solana: the tab's seq is exhausted")
	}
	seq := s.seq + 1
	msg, sig := trellis.SignVoucher(s.sessionKey, s.programID, s.tab, s.createdAt, cumulativeUsed, seq)
	v := &SignedVoucher{ProgramID: s.programID, Tab: s.tab, CreatedAt: s.createdAt, CumulativeUsed: cumulativeUsed, Seq: seq, Message: msg, Signature: sig, SessionKey: SessionPublicKey(s.sessionKey)}
	s.seq, s.cumulativeUsed, s.last = seq, cumulativeUsed, v
	return v, nil
}

// Headers are the latest voucher's request headers; nil before the first Voucher call.
func (s *TabSession) Headers() http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last == nil {
		return nil
	}
	return s.last.Headers()
}

// Wire is the latest voucher in the facilitator's JSON form; nil before the first Voucher call.
func (s *TabSession) Wire() *WireVoucher {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last == nil {
		return nil
	}
	w := s.last.Wire()
	return &w
}

// SignedVoucher is one voucher: the 110-byte message (trellis.VoucherMessage: the voucher domain, the tab program's
// id, the tab, its created_at, cumulative_used and seq) and the session key's signature over it.
type SignedVoucher struct {
	// ProgramID and CreatedAt are what the voucher is bound to besides its tab: the tab program, and the opening of
	// the tab (Tab.created_at).
	ProgramID      PublicKey
	Tab            PublicKey
	CreatedAt      int64
	CumulativeUsed uint64
	Seq            uint64
	Message        []byte
	Signature      []byte
	SessionKey     PublicKey
}

// Headers are the request headers that present this voucher: X-Trellis-Tab and X-Trellis-Tab-Voucher.
func (v *SignedVoucher) Headers() http.Header {
	h := http.Header{}
	h.Set(trellis.HeaderTab, v.Tab.String())
	h.Set(trellis.HeaderTabVoucher, trellis.VoucherHeader(v.Message, v.Signature))
	return h
}

// RequestOptions attach the voucher headers to one Trellis client call.
func (v *SignedVoucher) RequestOptions() []trellis.RequestOption {
	return []trellis.RequestOption{
		trellis.WithRequestHeader(trellis.HeaderTab, v.Tab.String()),
		trellis.WithRequestHeader(trellis.HeaderTabVoucher, trellis.VoucherHeader(v.Message, v.Signature)),
	}
}

// WireVoucher is the voucher as /facilitator/verify and /settle take it (paymentPayload.payload). The program id and
// created_at are not on the wire: the verifier takes both from the chain.
type WireVoucher struct {
	Tab            string `json:"tab"`
	CumulativeUsed string `json:"cumulative_used"`
	Seq            string `json:"seq"`
	// Signature is base58 of the 64 signature bytes.
	Signature  string `json:"signature"`
	SessionKey string `json:"session_key,omitempty"`
}

// Wire is the voucher's facilitator JSON form.
func (v *SignedVoucher) Wire() WireVoucher {
	w := WireVoucher{Tab: v.Tab.String(), CumulativeUsed: strconv.FormatUint(v.CumulativeUsed, 10), Seq: strconv.FormatUint(v.Seq, 10), Signature: trellis.Base58Encode(v.Signature)}
	if !v.SessionKey.IsZero() {
		w.SessionKey = v.SessionKey.String()
	}
	return w
}

// VerifyVoucher reports whether signature is sessionKey's signature over the voucher (tab, cumulativeUsed, seq) for
// the tab program programID and the opening of the tab at createdAt (the Tab account's created_at, from the chain).
func VerifyVoucher(programID, tab PublicKey, createdAt int64, cumulativeUsed, seq uint64, signature []byte, sessionKey PublicKey) bool {
	return trellis.VerifyVoucher(ed25519.PublicKey(sessionKey.Bytes()), programID, tab, createdAt, cumulativeUsed, seq, signature)
}

// VerifyVoucherHeaders checks the X-Trellis-Tab and X-Trellis-Tab-Voucher headers of a request against sessionKey, for
// the tab program programID and the opening of the tab at createdAt (both from the chain, never from the request), and
// returns the voucher they carry. A voucher for another program, for an earlier opening of the same tab address or in
// another form is refused.
func VerifyVoucherHeaders(h http.Header, programID PublicKey, createdAt int64, sessionKey PublicKey) (*SignedVoucher, error) {
	tab, err := ParseAddress(h.Get(trellis.HeaderTab))
	if err != nil {
		return nil, err
	}
	msg, sig, err := trellis.ParseVoucherHeader(h.Get(trellis.HeaderTabVoucher))
	if err != nil {
		return nil, err
	}
	f, err := trellis.DecodeVoucherMessage(msg)
	if err != nil {
		return nil, err
	}
	if f.Tab != tab {
		return nil, errors.New("trellis/solana: the voucher names another tab than X-Trellis-Tab")
	}
	if f.ProgramID != programID {
		return nil, errors.New("trellis/solana: the voucher was signed for another tab program (another cluster or deployment)")
	}
	if f.CreatedAt != createdAt {
		return nil, errors.New("trellis/solana: the voucher was signed for another opening of this tab address")
	}
	if !trellis.VerifyVoucherMessage(ed25519.PublicKey(sessionKey.Bytes()), programID, createdAt, msg, sig) {
		return nil, errors.New("trellis/solana: the voucher signature does not verify against the session key")
	}
	return &SignedVoucher{ProgramID: programID, Tab: tab, CreatedAt: createdAt, CumulativeUsed: f.CumulativeUsed, Seq: f.Seq, Message: msg, Signature: sig, SessionKey: sessionKey}, nil
}
