package solana

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	trellis "example.com/trellis/sdk-go"
	sol "github.com/gagliardetto/solana-go"
)

// The contract fixtures (../../fixtures/contracts.json) are produced by the router's own code: every instruction,
// voucher and transaction in them comes from the module that verifies it on the server. The tests below read the file
// in place and require this module to reproduce it byte for byte. Nothing expected here is written by hand.

const contractFixturePath = "../../fixtures/contracts.json"

type fixtureInstruction struct {
	ProgramID string `json:"program_id"`
	Keys      []struct {
		Pubkey     string `json:"pubkey"`
		IsSigner   bool   `json:"is_signer"`
		IsWritable bool   `json:"is_writable"`
	} `json:"keys"`
	DataHex string `json:"data_hex"`
	Amount  string `json:"amount"`
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
	Wire            map[string]string `json:"wire"`
}

type contractFixture struct {
	Keys       map[string]json.RawMessage `json:"keys"`
	Now        int64                      `json:"now"`
	Host       string                     `json:"host"`
	WalletAuth struct {
		Cases []struct {
			Name      string          `json:"name"`
			Method    string          `json:"method"`
			URL       string          `json:"url"`
			Timestamp int64           `json:"timestamp"`
			Body      json.RawMessage `json:"body"`
			Header    string          `json:"header"`
		} `json:"cases"`
	} `json:"wallet_auth"`
	Tab struct {
		ProgramID          string            `json:"program_id"`
		RulesProgramID     string            `json:"rules_program_id"`
		Mint               string            `json:"mint"`
		Payer              string            `json:"payer"`
		Payee              string            `json:"payee"`
		Session            string            `json:"session"`
		TabID              string            `json:"tab_id"`
		Cap                string            `json:"cap"`
		Expiry             string            `json:"expiry"`
		MaxLifetimeSeconds int64             `json:"max_lifetime_seconds"`
		Tab                string            `json:"tab"`
		PDAs               map[string]string `json:"pdas"`
		Rulebook           struct {
			Rulebook     string `json:"rulebook"`
			RulesConfig  string `json:"rules_config"`
			RulesProgram string `json:"rules_program"`
		} `json:"rulebook"`
		Instructions map[string]json.RawMessage `json:"instructions"`
		TabAccount   struct {
			DataBase64 string  `json:"data_base64"`
			CreatedAt  string  `json:"created_at"`
			Cap        string  `json:"cap"`
			Expiry     string  `json:"expiry"`
			PostedUsed string  `json:"posted_used"`
			PostedSeq  string  `json:"posted_seq"`
			Rulebook   *string `json:"rulebook"`
		} `json:"tab_account"`
		Voucher struct {
			Length        int                       `json:"length"`
			Cases         []fixtureVoucher          `json:"cases"`
			NotForThisTab map[string]fixtureVoucher `json:"not_for_this_tab"`
		} `json:"voucher"`
	} `json:"tab"`
	X402 struct {
		Network         string      `json:"network"`
		RecentBlockhash string      `json:"recent_blockhash"`
		Payer           string      `json:"payer"`
		FeePayer        string      `json:"fee_payer"`
		Source          string      `json:"source"`
		Destination     string      `json:"destination"`
		Requirement     Requirement `json:"requirement"`
		Limits          struct {
			MaxComputeUnitLimit              uint64 `json:"max_compute_unit_limit"`
			MaxComputeUnitPriceMicroLamports string `json:"max_compute_unit_price_micro_lamports"`
			MaxPriorityFeeLamports           string `json:"max_priority_fee_lamports"`
			AllowATACreation                 bool   `json:"allow_ata_creation"`
		} `json:"limits"`
		Accepted []struct {
			Name    string `json:"name"`
			Options struct {
				CreateDestinationATA          bool   `json:"create_destination_ata"`
				ComputeUnitLimit              uint32 `json:"compute_unit_limit"`
				ComputeUnitPriceMicroLamports string `json:"compute_unit_price_micro_lamports"`
			} `json:"options"`
			Transaction         string `json:"transaction"`
			PaymentHeader       string `json:"payment_header"`
			PriorityFeeLamports string `json:"priority_fee_lamports"`
		} `json:"accepted"`
		Refused []struct {
			Name        string `json:"name"`
			Transaction string `json:"transaction"`
			Reason      string `json:"reason"`
		} `json:"refused"`
		PriorityFeeExamples []struct {
			ComputeUnitLimit              uint32 `json:"compute_unit_limit"`
			ComputeUnitPriceMicroLamports string `json:"compute_unit_price_micro_lamports"`
			Lamports                      string `json:"lamports"`
		} `json:"priority_fee_examples"`
	} `json:"x402"`
	Closure struct {
		KeyAddress                string          `json:"key_address"`
		Response                  json.RawMessage `json:"response"`
		ResponseAlreadyRegistered json.RawMessage `json:"response_already_registered"`
		fixtureKeySigned
		Cancel struct {
			Response json.RawMessage `json:"response"`
			fixtureKeySigned
		} `json:"cancel"`
		RefundDestination struct {
			Response                 json.RawMessage `json:"response"`
			Signers                  []string        `json:"signers"`
			InstructionCount         int             `json:"instruction_count"`
			SignedTransaction        string          `json:"signed_transaction"`
			DepositorSignatureBase58 string          `json:"depositor_signature_base58"`
		} `json:"refund_destination"`
	} `json:"closure"`
	Errors map[string]json.RawMessage `json:"errors"`
}

// fixtureKeySigned describes a transaction the router signed as the API key (a closure or its cancellation).
type fixtureKeySigned struct {
	Signers              []string `json:"signers"`
	KeySignatureIndex    int      `json:"key_signature_index"`
	KeySignatureBase58   string   `json:"key_signature_base58"`
	InstructionCount     int      `json:"instruction_count"`
	SignedTransaction    string   `json:"signed_transaction"`
	PayerSignatureBase58 string   `json:"payer_signature_base58"`
}

type fixtureError struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

func (f *contractFixture) apiError(t *testing.T, name string) fixtureError {
	t.Helper()
	var e fixtureError
	if err := json.Unmarshal(f.Errors[name], &e); err != nil || e.Status == 0 {
		t.Fatalf("fixture error %q: %v", name, err)
	}
	return e
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

// key derives a test key from its label: the ed25519 key whose seed is SHA-256(seed_prefix + label), checked against
// the address the fixture gives. No seed is stored anywhere.
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
	if got := SessionPublicKey(priv).String(); got != entry.Address {
		t.Fatalf("fixture key %q derives to another address than the fixture names", name)
	}
	return priv
}

func (f *contractFixture) signer(t *testing.T, name string) *KeySigner {
	t.Helper()
	s, err := NewKeySigner(f.key(t, name))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (f *contractFixture) instruction(t *testing.T, name string) fixtureInstruction {
	t.Helper()
	var ix fixtureInstruction
	if err := json.Unmarshal(f.Tab.Instructions[name], &ix); err != nil || ix.ProgramID == "" || len(ix.Keys) == 0 {
		t.Fatalf("fixture instruction %q: %v", name, err)
	}
	return ix
}

func pk(t *testing.T, s string) PublicKey {
	t.Helper()
	k, err := ParseAddress(s)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func u64(t *testing.T, s string) uint64 {
	t.Helper()
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// sameInstruction requires got to be the fixture's instruction: program id, every key with its flags in order, data.
func sameInstruction(t *testing.T, name string, got sol.Instruction, want fixtureInstruction) {
	t.Helper()
	if got.ProgramID().String() != want.ProgramID {
		t.Errorf("%s: program %s, fixture %s", name, got.ProgramID(), want.ProgramID)
	}
	acc := got.Accounts()
	if len(acc) != len(want.Keys) {
		t.Fatalf("%s: %d accounts, fixture %d", name, len(acc), len(want.Keys))
	}
	for i, w := range want.Keys {
		if acc[i].PublicKey.String() != w.Pubkey || acc[i].IsSigner != w.IsSigner || acc[i].IsWritable != w.IsWritable {
			t.Errorf("%s: account %d is %s signer=%v writable=%v, fixture %s signer=%v writable=%v", name, i, acc[i].PublicKey, acc[i].IsSigner, acc[i].IsWritable, w.Pubkey, w.IsSigner, w.IsWritable)
		}
	}
	data, err := got.Data()
	if err != nil || hex.EncodeToString(data) != want.DataHex {
		t.Errorf("%s: data %x (%v), fixture %s", name, data, err, want.DataHex)
	}
}

// 5a. Tab instructions: the account lists and data the program takes, with and without a rulebook.
func TestContractTabInstructions(t *testing.T) {
	f := loadContracts(t)
	setClock(t, f.Now)
	p := TabProgram{ProgramID: pk(t, f.Tab.ProgramID), Mint: pk(t, f.Tab.Mint)}
	payer, payee, session := pk(t, f.Tab.Payer), pk(t, f.Tab.Payee), pk(t, f.Tab.Session)
	if SessionPublicKey(f.key(t, "session")) != session || SessionPublicKey(f.key(t, "wallet")) != payer || SessionPublicKey(f.key(t, "payee")) != payee {
		t.Fatal("the fixture's tab parties are not its test keys")
	}
	tabID, capUnits, expiry := u64(t, f.Tab.TabID), u64(t, f.Tab.Cap), int64(u64(t, f.Tab.Expiry))

	// PDAs.
	cfg, _ := p.ConfigAddress()
	tab, _ := p.TabAddress(payer, payee, tabID)
	esc, _ := p.EscrowAddress(tab)
	if cfg.String() != f.Tab.PDAs["config"] || tab.String() != f.Tab.PDAs["tab"] || esc.String() != f.Tab.PDAs["escrow"] || tab.String() != f.Tab.Tab {
		t.Fatalf("PDAs: config %s, tab %s, escrow %s", cfg, tab, esc)
	}
	rules, err := NewRulebookAccounts(pk(t, f.Tab.RulesProgramID), pk(t, f.Tab.Rulebook.Rulebook))
	if err != nil || rules.RulesConfig.String() != f.Tab.Rulebook.RulesConfig || rules.RulesProgram.String() != f.Tab.Rulebook.RulesProgram {
		t.Fatalf("rulebook group %+v %v", rules, err)
	}

	open, openTab, err := p.OpenTabInstruction(payer, payee, capUnits, expiry, session, tabID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if openTab != tab {
		t.Fatalf("open_tab returned tab %s", openTab)
	}
	sameInstruction(t, "open_tab", open, f.instruction(t, "open_tab"))
	bound, _, err := p.OpenTabInstruction(payer, payee, capUnits, expiry, session, tabID, rules)
	if err != nil {
		t.Fatal(err)
	}
	sameInstruction(t, "open_tab_with_rulebook", bound, f.instruction(t, "open_tab_with_rulebook"))

	want := f.instruction(t, "top_up")
	top, err := p.TopUpInstruction(payer, tab, u64(t, want.Amount), nil)
	if err != nil {
		t.Fatal(err)
	}
	sameInstruction(t, "top_up", top, want)
	want = f.instruction(t, "top_up_with_rulebook")
	topBound, err := p.TopUpInstruction(payer, tab, u64(t, want.Amount), rules)
	if err != nil {
		t.Fatal(err)
	}
	sameInstruction(t, "top_up_with_rulebook", topBound, want)

	reclaim, err := p.ReclaimInstruction(payer, payee, tab)
	if err != nil {
		t.Fatal(err)
	}
	wantReclaim := f.instruction(t, "reclaim")
	sameInstruction(t, "reclaim", reclaim, wantReclaim)
	for _, k := range wantReclaim.Keys {
		if k.IsSigner {
			t.Fatal("the fixture's reclaim has a signer")
		}
	}

	// The transaction around open_tab carries exactly that instruction, for the payer to sign.
	tx, txTab, err := p.OpenTabTransaction(payer, payee, capUnits, expiry, session, tabID, rules, f.X402.RecentBlockhash)
	if err != nil || txTab != tab {
		t.Fatal(err)
	}
	m := tx.Message
	wantOpen := f.instruction(t, "open_tab_with_rulebook")
	if len(m.Instructions) != 1 || m.AccountKeys[0] != payer || m.Header.NumRequiredSignatures != 1 || m.AccountKeys[m.Instructions[0].ProgramIDIndex].String() != wantOpen.ProgramID || hex.EncodeToString(m.Instructions[0].Data) != wantOpen.DataHex {
		t.Fatalf("open_tab transaction %+v", m)
	}
	for i, k := range wantOpen.Keys {
		if m.AccountKeys[m.Instructions[0].Accounts[i]].String() != k.Pubkey {
			t.Errorf("open_tab transaction: account %d", i)
		}
	}

	// A tab's lifetime: at most the fixture's bound from the moment it is opened.
	if int64(MaxTabLifetime/time.Second) != f.Tab.MaxLifetimeSeconds {
		t.Fatalf("MaxTabLifetime %v, fixture %d s", MaxTabLifetime, f.Tab.MaxLifetimeSeconds)
	}
	if _, _, err := p.OpenTabInstruction(payer, payee, capUnits, f.Now+f.Tab.MaxLifetimeSeconds, session, tabID, nil); err != nil {
		t.Fatalf("the longest lifetime refused: %v", err)
	}
	if _, _, err := p.OpenTabInstruction(payer, payee, capUnits, f.Now+f.Tab.MaxLifetimeSeconds+1, session, tabID, rules); !errors.Is(err, ErrTabExpiry) {
		t.Fatalf("a longer lifetime accepted: %v", err)
	}
}

// 5b. The Tab account, as the payer reads it after open_tab lands: created_at is what its vouchers sign.
func TestContractTabAccount(t *testing.T) {
	f := loadContracts(t)
	p := TabProgram{ProgramID: pk(t, f.Tab.ProgramID), Mint: pk(t, f.Tab.Mint)}
	tab := pk(t, f.Tab.Tab)
	data, err := base64.StdEncoding.DecodeString(f.Tab.TabAccount.DataBase64)
	if err != nil {
		t.Fatal(err)
	}
	check := func(a *TabAccount) {
		t.Helper()
		if a.CreatedAt != int64(u64(t, f.Tab.TabAccount.CreatedAt)) || a.Cap != u64(t, f.Tab.TabAccount.Cap) || a.Expiry != int64(u64(t, f.Tab.TabAccount.Expiry)) || a.PostedUsed != u64(t, f.Tab.TabAccount.PostedUsed) || a.PostedSeq != u64(t, f.Tab.TabAccount.PostedSeq) || (a.Rulebook != nil) != (f.Tab.TabAccount.Rulebook != nil) {
			t.Fatalf("tab account %+v", a)
		}
		if a.Payer.String() != f.Tab.Payer || a.Payee.String() != f.Tab.Payee || a.SessionKey.String() != f.Tab.Session || a.Mint.String() != f.Tab.Mint || a.TabID != u64(t, f.Tab.TabID) {
			t.Fatalf("tab account parties %+v", a)
		}
	}
	acct, err := DecodeTabAccount(data)
	if err != nil {
		t.Fatal(err)
	}
	check(acct)

	// Over JSON-RPC: getAccountInfo, the owner and the address checked before the bytes are believed.
	var owner atomic.Value
	owner.Store(f.Tab.ProgramID)
	var exists atomic.Bool
	exists.Store(true)
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			Params []any  `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		opts, _ := req.Params[1].(map[string]any)
		if req.Method != "getAccountInfo" || len(req.Params) != 2 || opts["encoding"] != "base64" {
			t.Errorf("rpc request %+v", req)
		}
		if !exists.Load() {
			io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":null}}`)
			return
		}
		out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"context": map[string]any{"slot": 1}, "value": map[string]any{"owner": owner.Load(), "lamports": 1, "executable": false, "data": []string{f.Tab.TabAccount.DataBase64, "base64"}}}})
		w.Write(out)
	}))
	defer rpc.Close()
	got, err := p.FetchTab(context.Background(), rpc.Client(), rpc.URL, tab)
	if err != nil {
		t.Fatal(err)
	}
	check(got)
	// The same bytes at another address are not that tab; an account another program owns is not a tab; no account.
	if _, err := p.FetchTab(context.Background(), rpc.Client(), rpc.URL, pk(t, f.Tab.Payee)); err == nil {
		t.Fatal("a Tab-shaped account at another address was believed")
	}
	owner.Store(f.Tab.RulesProgramID)
	if _, err := p.FetchTab(context.Background(), rpc.Client(), rpc.URL, tab); err == nil {
		t.Fatal("an account owned by another program was believed")
	}
	exists.Store(false)
	if _, err := p.FetchTab(context.Background(), rpc.Client(), rpc.URL, tab); !errors.Is(err, ErrTabNotFound) {
		t.Fatalf("no account: %v", err)
	}
}

// 5c. Vouchers through the session type: message, signature, headers and wire form.
func TestContractTabVouchers(t *testing.T) {
	f := loadContracts(t)
	sessionKey := f.key(t, "session")
	pub := SessionPublicKey(sessionKey)
	program, tab := pk(t, f.Tab.ProgramID), pk(t, f.Tab.Tab)
	data, _ := base64.StdEncoding.DecodeString(f.Tab.TabAccount.DataBase64)
	acct, err := DecodeTabAccount(data)
	if err != nil {
		t.Fatal(err)
	}
	// created_at comes from the chain: the Tab account of the fixture.
	s, err := NewTabSession(program, tab, acct.CreatedAt, sessionKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Tab.Voucher.Cases) < 3 || f.Tab.Voucher.Length != trellis.VoucherMessageLen {
		t.Fatalf("%d cases, length %d", len(f.Tab.Voucher.Cases), f.Tab.Voucher.Length)
	}
	prevUsed := uint64(0)
	for i, c := range f.Tab.Voucher.Cases {
		used, seq := u64(t, c.CumulativeUsed), u64(t, c.Seq)
		if c.ProgramID != f.Tab.ProgramID || int64(u64(t, c.CreatedAt)) != acct.CreatedAt {
			t.Fatalf("case %d is not for the fixture's tab", i)
		}
		// The first two cases follow each other (seq 1, 2); the last one is resumed just below its seq.
		if s.Seq()+1 != seq {
			s.Resume(seq-1, prevUsed)
		}
		v, err := s.Voucher(used)
		if err != nil {
			t.Fatal(err)
		}
		prevUsed = used
		if v.Seq != seq || v.CumulativeUsed != used || v.ProgramID != program || v.CreatedAt != acct.CreatedAt {
			t.Fatalf("case %d: voucher %+v", i, v)
		}
		if hex.EncodeToString(v.Message) != c.MessageHex || base64.StdEncoding.EncodeToString(v.Message) != c.MessageBase64 {
			t.Errorf("case %d: message\n got  %x\n want %s", i, v.Message, c.MessageHex)
		}
		if trellis.Base58Encode(v.Signature) != c.SignatureBase58 || base64.StdEncoding.EncodeToString(v.Signature) != c.SignatureBase64 {
			t.Errorf("case %d: signature %s, fixture %s", i, trellis.Base58Encode(v.Signature), c.SignatureBase58)
		}
		h := v.Headers()
		if len(c.Headers) != 2 || len(h) != 2 {
			t.Fatalf("case %d: %d headers, fixture %d", i, len(h), len(c.Headers))
		}
		for name, want := range c.Headers {
			if h.Get(name) != want {
				t.Errorf("case %d: header %s\n got  %s\n want %s", i, name, h.Get(name), want)
			}
		}
		if !reflect.DeepEqual(s.Headers(), h) {
			t.Errorf("case %d: the session's headers are not the latest voucher's", i)
		}
		// The wire form: the fixture leaves the optional session key out, the SDK names it.
		w := v.Wire()
		if w.SessionKey != pub.String() {
			t.Errorf("case %d: wire session key %q", i, w.SessionKey)
		}
		w.SessionKey = ""
		wj, _ := json.Marshal(w)
		var got map[string]string
		_ = json.Unmarshal(wj, &got)
		if !reflect.DeepEqual(got, c.Wire) {
			t.Errorf("case %d: wire\n got  %v\n want %v", i, got, c.Wire)
		}
		// What the fixture carries verifies, for this program and this opening of the tab.
		fh := http.Header{}
		for name, val := range c.Headers {
			fh.Set(name, val)
		}
		back, err := VerifyVoucherHeaders(fh, program, acct.CreatedAt, pub)
		if err != nil || back.Seq != seq || back.CumulativeUsed != used || back.Tab != tab {
			t.Errorf("case %d: the fixture's headers do not verify: %v", i, err)
		}
		sig, _ := trellis.Base58Decode(c.Wire["signature"])
		if !VerifyVoucher(program, tab, acct.CreatedAt, used, seq, sig, pub) {
			t.Errorf("case %d: the fixture's wire signature does not verify", i)
		}
	}

	// Signed by the same session key for the same tab address, but for something else: none of them is a voucher for
	// the fixture's tab (its program id, its created_at).
	if len(f.Tab.Voucher.NotForThisTab) < 3 {
		t.Fatalf("only %d not_for_this_tab cases", len(f.Tab.Voucher.NotForThisTab))
	}
	first := f.Tab.Voucher.Cases[0]
	for name, c := range f.Tab.Voucher.NotForThisTab {
		msg, _ := hex.DecodeString(c.MessageHex)
		sig, err := trellis.Base58Decode(c.SignatureBase58)
		if err != nil || len(sig) != 64 || len(msg) == 0 {
			t.Fatal(name, err)
		}
		if !ed25519.Verify(ed25519.PublicKey(pub.Bytes()), msg, sig) {
			t.Fatalf("%s: the fixture signature is not the session key's", name)
		}
		h := http.Header{}
		h.Set(trellis.HeaderTab, f.Tab.Tab)
		h.Set(trellis.HeaderTabVoucher, c.MessageBase64+"."+c.SignatureBase64)
		if c.Headers != nil && c.Headers[trellis.HeaderTabVoucher] != h.Get(trellis.HeaderTabVoucher) {
			t.Fatalf("%s: fixture header differs from its message and signature", name)
		}
		if v, err := VerifyVoucherHeaders(h, program, acct.CreatedAt, pub); err == nil {
			t.Errorf("%s verified for the fixture's tab: %+v", name, v)
		}
		if VerifyVoucher(program, tab, acct.CreatedAt, u64(t, first.CumulativeUsed), u64(t, first.Seq), sig, pub) {
			t.Errorf("%s: its signature verified as the fixture tab's voucher", name)
		}
		if trellis.VerifyVoucherMessage(ed25519.PublicKey(pub.Bytes()), program, acct.CreatedAt, msg, sig) {
			t.Errorf("%s: its message verified for the fixture's tab", name)
		}
	}
	// Each of the two well-formed ones does verify for what it was really signed for: the refusal above is the scope.
	for _, name := range []string{"reopened_later", "another_program"} {
		c := f.Tab.Voucher.NotForThisTab[name]
		h := http.Header{}
		h.Set(trellis.HeaderTab, f.Tab.Tab)
		h.Set(trellis.HeaderTabVoucher, c.Headers[trellis.HeaderTabVoucher])
		if _, err := VerifyVoucherHeaders(h, pk(t, c.ProgramID), int64(u64(t, c.CreatedAt)), pub); err != nil {
			t.Errorf("%s does not verify for its own scope: %v", name, err)
		}
	}
}

func exactOptions(t *testing.T, create bool, limit uint32, price string) *ExactOptions {
	t.Helper()
	o := &ExactOptions{CreateDestinationATA: create, ComputeUnitLimit: limit}
	if price != "" {
		o.ComputeUnitPriceMicroLamports = u64(t, price)
	}
	return o
}

func decodeTx(t *testing.T, b64 string) *sol.Transaction {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := sol.TransactionFromBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	return tx
}

// 6. x402 `exact`: the SDK's payments are the transactions the router's verifier accepts, byte for byte, and it does
// not build the ones the verifier refuses.
func TestContractExactPayments(t *testing.T) {
	f := loadContracts(t)
	x := f.X402
	wallet := f.signer(t, "wallet")
	feePayer, payTo, mint := pk(t, x.FeePayer), pk(t, x.Requirement.PayTo), pk(t, x.Requirement.Asset)
	if wallet.PublicKey().String() != x.Payer || x.Requirement.Extra.FeePayer == nil || *x.Requirement.Extra.FeePayer != x.FeePayer || SessionPublicKey(f.key(t, "fee_payer")) != feePayer || SessionPublicKey(f.key(t, "payee")) != payTo {
		t.Fatal("the fixture's requirement does not name its test keys")
	}
	// The bounds the SDK holds itself to are the router's.
	if MaxComputeUnitLimit != x.Limits.MaxComputeUnitLimit || MaxComputeUnitPriceMicroLamports != u64(t, x.Limits.MaxComputeUnitPriceMicroLamports) || MaxPriorityFeeLamports != u64(t, x.Limits.MaxPriorityFeeLamports) || !x.Limits.AllowATACreation {
		t.Fatalf("limits: fixture %+v", x.Limits)
	}
	for _, e := range x.PriorityFeeExamples {
		if got := PriorityFeeLamports(e.ComputeUnitLimit, u64(t, e.ComputeUnitPriceMicroLamports)); got != u64(t, e.Lamports) {
			t.Errorf("priority fee of %d x %s = %d, fixture %s", e.ComputeUnitLimit, e.ComputeUnitPriceMicroLamports, got, e.Lamports)
		}
	}

	if len(x.Accepted) < 4 || len(x.Refused) < 6 {
		t.Fatalf("%d accepted, %d refused", len(x.Accepted), len(x.Refused))
	}
	accepted := map[string]string{} // transaction -> name
	for _, a := range x.Accepted {
		accepted[a.Transaction] = a.Name
		p, err := BuildExactPayment(x.Requirement, wallet, x.RecentBlockhash, exactOptions(t, a.Options.CreateDestinationATA, a.Options.ComputeUnitLimit, a.Options.ComputeUnitPriceMicroLamports))
		if err != nil {
			t.Errorf("%s: %v", a.Name, err)
			continue
		}
		// Byte for byte: the same message (accounts in the reference order) and, ed25519 being deterministic, the same
		// payer signature; the fee payer's slot empty.
		if p.Base64 != a.Transaction {
			t.Errorf("%s: transaction\n got  %s\n want %s", a.Name, p.Base64, a.Transaction)
			continue
		}
		if p.Header() != a.PaymentHeader {
			t.Errorf("%s: X-PAYMENT\n got  %s\n want %s", a.Name, p.Header(), a.PaymentHeader)
		}
		if p.PriorityFeeLamports != u64(t, a.PriorityFeeLamports) || p.Source.String() != x.Source || p.Destination.String() != x.Destination || p.Network != x.Network || p.Amount != u64(t, x.Requirement.MaxAmountRequired) {
			t.Errorf("%s: payment %+v", a.Name, p)
		}
		if p.Transaction.Signatures[0] != (sol.Signature{}) || p.Transaction.Message.AccountKeys[0] != feePayer {
			t.Errorf("%s: the fee payer's slot", a.Name)
		}
		// Both mirrors of the router's verifier accept the fixture's own bytes.
		if payer, amount := checkPaid(t, a.Transaction, feePayer, payTo, mint); payer != wallet.PublicKey() || amount != p.Amount {
			t.Errorf("%s: paid %d by %s", a.Name, amount, payer)
		}
		tr, err := inspectExact(decodeTx(t, a.Transaction), feePayer, payTo, mint)
		if err != nil || tr.priorityFeeLamports != u64(t, a.PriorityFeeLamports) || tr.payer != wallet.PublicKey() {
			t.Errorf("%s: the SDK's bounds check refuses a transaction the router accepts: %v", a.Name, err)
		}
	}

	for _, r := range x.Refused {
		tx := decodeTx(t, r.Transaction)
		// The SDK's bounds check refuses what the router refuses.
		if _, err := inspectExact(tx, feePayer, payTo, mint); !errors.Is(err, ErrOutsideExactBounds) {
			t.Errorf("%s (%s): the SDK's bounds check passes it: %v", r.Name, r.Reason, err)
		}
		// The options that would express this shape, read off the refused transaction itself.
		o := &ExactOptions{}
		transfers := 0
		for _, ix := range tx.Message.Instructions {
			switch program := tx.Message.AccountKeys[ix.ProgramIDIndex]; {
			case program == ComputeBudgetProgram && ix.Data[0] == computeSetUnitLimit:
				o.ComputeUnitLimit = binary.LittleEndian.Uint32(ix.Data[1:])
			case program == ComputeBudgetProgram && ix.Data[0] == computeSetUnitPrice:
				o.ComputeUnitPriceMicroLamports = binary.LittleEndian.Uint64(ix.Data[1:])
			case program == AssociatedTokenProgram:
				o.CreateDestinationATA = true
			case program == TokenProgram:
				transfers++
			default:
				t.Fatalf("%s: unexpected instruction in the fixture", r.Name)
			}
		}
		p, err := BuildExactPayment(x.Requirement, wallet, x.RecentBlockhash, o)
		if err != nil {
			// Refused outright: the shape is one the options can express, and it is outside the bounds.
			if !errors.Is(err, ErrOutsideExactBounds) {
				t.Errorf("%s: refused for another reason: %v", r.Name, err)
			}
			continue
		}
		// Built: then the options cannot express the refused shape (a token account funded by the fee payer, a second
		// transfer). What came out instead is not the refused transaction but one the router accepts.
		if p.Base64 == r.Transaction {
			t.Errorf("%s: the SDK built the refused transaction", r.Name)
		}
		if name, ok := accepted[p.Base64]; !ok {
			t.Errorf("%s: the SDK built something that is neither refused by it nor one of the fixture's accepted transactions", r.Name)
		} else if (name == "with_destination_ata") != o.CreateDestinationATA {
			t.Errorf("%s: built %s", r.Name, name)
		}
		if len(p.Transaction.Message.Instructions)-btoi(o.CreateDestinationATA) != 1 || transfers == 1 && !o.CreateDestinationATA {
			t.Errorf("%s: this shape should have been refused by the options check", r.Name)
		}
		checkPaid(t, p.Base64, feePayer, payTo, mint)
	}
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// checkKeySignedTx reads a transaction the router signed as the key, before and after the payer signed it, with
// solana-go's own decoder: fully signed and verifying, the key's signature where the router put it, the payer as fee
// payer, the key's own address as the only other signer, and one instruction.
func checkKeySignedTx(t *testing.T, f *contractFixture, what string, lay fixtureKeySigned, transaction, signed string, payer PublicKey) {
	t.Helper()
	if signed != lay.SignedTransaction {
		t.Fatalf("%s: signed transaction\n got  %s\n want %s", what, signed, lay.SignedTransaction)
	}
	before, after := decodeTx(t, transaction), decodeTx(t, signed)
	k := lay.KeySignatureIndex
	if after.Signatures[k] != before.Signatures[k] || after.Signatures[k].String() != lay.KeySignatureBase58 || after.Signatures[0].String() != lay.PayerSignatureBase58 || before.Signatures[0] != (sol.Signature{}) {
		t.Fatalf("%s: signatures", what)
	}
	if err := after.VerifySignatures(); err != nil {
		t.Fatalf("%s: the signed transaction does not verify: %v", what, err)
	}
	if after.Message.AccountKeys[0] != payer {
		t.Fatalf("%s: the payer is not the fee payer", what)
	}
	if n := int(after.Message.Header.NumRequiredSignatures); n != 2 || len(lay.Signers) != n || after.Message.AccountKeys[k].String() != f.Closure.KeyAddress || lay.Signers[k] != f.Closure.KeyAddress {
		t.Fatalf("%s: %d required signers, fixture %v", what, n, lay.Signers)
	}
	if len(after.Message.Instructions) != 1 || lay.InstructionCount != 1 {
		t.Fatalf("%s: %d instructions", what, len(after.Message.Instructions))
	}
}

// 4. The credits closure arrives signed by the key; a Signer adds the payer's signature and nothing else changes. It
// names no destination: the refund returns to the wallets that deposited.
func TestContractClosureSigner(t *testing.T) {
	f := loadContracts(t)
	var cl trellis.CreditClosure
	if err := json.Unmarshal(f.Closure.Response, &cl); err != nil {
		t.Fatal(err)
	}
	wallet := f.signer(t, "wallet")
	signed, err := SignCreditClosure(&cl, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if signed != f.Closure.SignedTransaction {
		t.Fatalf("signed transaction\n got  %s\n want %s", signed, f.Closure.SignedTransaction)
	}
	// solana-go reads the result as a fully signed transaction, with the key's signature where the router put it.
	before, after := decodeTx(t, cl.Transaction), decodeTx(t, signed)
	k := f.Closure.KeySignatureIndex
	if after.Signatures[k] != before.Signatures[k] || after.Signatures[k].String() != f.Closure.KeySignatureBase58 || after.Signatures[0].String() != f.Closure.PayerSignatureBase58 || before.Signatures[0] != (sol.Signature{}) {
		t.Fatal("signatures")
	}
	if err := after.VerifySignatures(); err != nil {
		t.Fatalf("the signed closure does not verify: %v", err)
	}
	if after.Message.AccountKeys[0] != wallet.PublicKey() || cl.Payer != wallet.PublicKey().String() || !cl.SignedByKey {
		t.Fatal("the payer is not the fee payer")
	}
	checkKeySignedTx(t, f, "closure", f.Closure.fixtureKeySigned, cl.Transaction, signed, wallet.PublicKey())
	// Who is paid back is in the answer, per depositor; the second depositor is no part of the transaction the payer
	// signs, and neither is anything the caller could have named.
	second := f.signer(t, "second_depositor").PublicKey()
	if len(cl.Refunds) != 2 || cl.Refunds[0].Depositor != wallet.PublicKey().String() || cl.Refunds[1].Depositor != second.String() || cl.Refunds[0].RefundTo == "" || cl.Refunds[1].RefundTo == "" {
		t.Fatalf("refunds %+v", cl.Refunds)
	}
	if _, err := SignCreditClosure(&cl, f.signer(t, "session")); err == nil {
		t.Fatal("another wallet signed as payer")
	}
	if _, err := SignCreditClosure(&cl, nil); err == nil {
		t.Fatal("no signer")
	}
	var registered trellis.CreditClosure
	if err := json.Unmarshal(f.Closure.ResponseAlreadyRegistered, &registered); err != nil {
		t.Fatal(err)
	}
	if _, err := SignCreditClosure(&registered, wallet); !errors.Is(err, trellis.ErrNothingToSign) {
		t.Fatalf("nothing to sign: %v", err)
	}
}

// 4b. Cancelling a closure: the same shape, signed by the key, for a Signer to sign as payer.
func TestContractClosureCancelSigner(t *testing.T) {
	f := loadContracts(t)
	var cc trellis.CreditClosureCancel
	if err := json.Unmarshal(f.Closure.Cancel.Response, &cc); err != nil {
		t.Fatal(err)
	}
	wallet := f.signer(t, "wallet")
	signed, err := SignCreditClosureCancel(&cc, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if cc.Payer != wallet.PublicKey().String() || !cc.SignedByKey {
		t.Fatalf("cancellation %+v", cc)
	}
	checkKeySignedTx(t, f, "cancellation", f.Closure.Cancel.fixtureKeySigned, cc.Transaction, signed, wallet.PublicKey())
	if signed == f.Closure.SignedTransaction {
		t.Fatal("the cancellation is the closure")
	}
	if _, err := SignCreditClosureCancel(&cc, f.signer(t, "session")); err == nil {
		t.Fatal("another wallet signed as payer")
	}
	if _, err := SignCreditClosureCancel(&cc, nil); err == nil {
		t.Fatal("no signer")
	}
}

// 4d. A refund destination change is the depositor's: unsigned, the depositor is the fee payer and the only signer,
// and the API key is not an account of the transaction at all.
func TestContractRefundDestinationSigner(t *testing.T) {
	f := loadContracts(t)
	rdf := &f.Closure.RefundDestination
	var rd trellis.RefundDestinationTransaction
	if err := json.Unmarshal(rdf.Response, &rd); err != nil {
		t.Fatal(err)
	}
	wallet := f.signer(t, "wallet")
	signed, err := SignRefundDestination(&rd, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if signed != rdf.SignedTransaction {
		t.Fatalf("signed transaction\n got  %s\n want %s", signed, rdf.SignedTransaction)
	}
	before, after := decodeTx(t, rd.Transaction), decodeTx(t, signed)
	if len(after.Signatures) != 1 || before.Signatures[0] != (sol.Signature{}) || after.Signatures[0].String() != rdf.DepositorSignatureBase58 {
		t.Fatal("signatures")
	}
	if err := after.VerifySignatures(); err != nil {
		t.Fatalf("the signed transaction does not verify: %v", err)
	}
	if after.Message.Header.NumRequiredSignatures != 1 || len(rdf.Signers) != 1 || after.Message.AccountKeys[0] != wallet.PublicKey() || rd.Depositor != wallet.PublicKey().String() || rdf.Signers[0] != rd.Depositor {
		t.Fatal("the depositor is not the fee payer and only signer")
	}
	if len(after.Message.Instructions) != rdf.InstructionCount {
		t.Fatalf("%d instructions, fixture %d", len(after.Message.Instructions), rdf.InstructionCount)
	}
	share, token := rd.Accounts["share"], rd.Accounts["refundToToken"]
	var hasShare, hasToken bool
	for _, key := range after.Message.AccountKeys {
		if key.String() == f.Closure.KeyAddress {
			t.Fatal("the API key is an account of the refund destination transaction")
		}
		hasShare = hasShare || key.String() == share
		hasToken = hasToken || key.String() == token
	}
	if share == "" || token == "" || !hasShare || !hasToken {
		t.Fatalf("accounts %v are not in the transaction", rd.Accounts)
	}
	// The token account the refunds will go to is the new destination's own USDC account.
	if owner, err := ParseAddress(rd.RefundTo); err != nil || owner != f.signer(t, "refund_to").PublicKey() {
		t.Fatalf("refund_to %q (%v)", rd.RefundTo, err)
	}
	// Only the depositor: not the wallet the refund would go to, not another depositor, nobody.
	for _, name := range []string{"refund_to", "second_depositor", "session", "fee_payer"} {
		if _, err := SignRefundDestination(&rd, f.signer(t, name)); err == nil {
			t.Fatalf("%s signed another wallet's refund destination", name)
		}
	}
	if _, err := SignRefundDestination(&rd, nil); err == nil {
		t.Fatal("no signer")
	}
}

// 2 and 3. X-Wallet-Auth from a Signer, and the bare transaction signature that needs it.
func TestContractWalletAuthSigner(t *testing.T) {
	f := loadContracts(t)
	wallet := f.signer(t, "wallet")
	if len(f.WalletAuth.Cases) < 7 {
		t.Fatalf("only %d cases", len(f.WalletAuth.Cases))
	}
	for _, c := range f.WalletAuth.Cases {
		var body []byte
		if len(c.Body) > 0 && string(c.Body) != "null" {
			body = c.Body
		}
		req, err := http.NewRequest(c.Method, c.URL, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		h, err := WalletAuthHeader(wallet, req, body, "", time.Unix(c.Timestamp, 0))
		if err != nil || h != c.Header {
			t.Errorf("%s: header %q (%v)\n want %q", c.Name, h, err, c.Header)
		}
	}
}

func TestContractBarePaymentSignature(t *testing.T) {
	f := loadContracts(t)
	wallet := f.signer(t, "wallet")
	fe := f.apiError(t, "payment_not_bound_to_caller")
	var env struct {
		Error struct {
			Type     string
			Metadata struct{ Tx string }
		}
	}
	if err := json.Unmarshal(fe.Body, &env); err != nil || fe.Status != 401 || env.Error.Type != trellis.ErrorTypePaymentNotBound || !trellis.IsTransactionSignature(env.Error.Metadata.Tx) {
		t.Fatalf("fixture: %d %s", fe.Status, fe.Body)
	}
	signature := env.Error.Metadata.Tx

	// The router as the fixture describes it: a bare signature is served only with X-Wallet-Auth from the wallet that
	// paid, over this same request; otherwise 401 payment_not_bound_to_caller.
	var served, refused int32
	var seen atomic.Value
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get(HeaderPayment) != signature {
			t.Errorf("X-PAYMENT %q", r.Header.Get(HeaderPayment))
		}
		ok := false
		if parts := strings.Split(r.Header.Get(trellis.HeaderWalletAuth), ":"); len(parts) == 3 && parts[0] == wallet.PublicKey().String() {
			ts, _ := strconv.ParseInt(parts[1], 10, 64)
			sum, _ := trellis.WalletAuthHash(r.Method, r.URL.RequestURI(), body)
			msg, _ := trellis.WalletAuthMessage(r.Method, f.Host, r.URL.RequestURI(), ts, sum)
			sig, _ := trellis.Base58Decode(parts[2])
			ok = ts == f.Now && ed25519.Verify(ed25519.PublicKey(wallet.PublicKey().Bytes()), []byte(msg), sig)
		}
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			atomic.AddInt32(&refused, 1)
			w.WriteHeader(fe.Status)
			w.Write(fe.Body)
			return
		}
		atomic.AddInt32(&served, 1)
		seen.Store(r.Header.Get(trellis.HeaderWalletAuth))
		io.WriteString(w, `{"id":"gen-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"paid"}}]}`)
	}))
	defer router.Close()
	chat := trellis.ChatRequest{Model: "example/model", Messages: []trellis.Message{trellis.UserMessage("hi")}}
	fixed := func() time.Time { return time.Unix(f.Now, 0) }

	// Without the wallet header: refused, recognisable, and not sent again.
	plain := trellis.NewClient(trellis.WithAPIKey(""), trellis.WithBaseURL(router.URL), trellis.WithHTTPClient(router.Client()))
	_, err := plain.Chat(context.Background(), chat, trellis.WithRequestHeader(HeaderPayment, signature))
	var apiErr *trellis.APIError
	if !trellis.IsPaymentNotBound(err) || !errors.As(err, &apiErr) || apiErr.StatusCode != 401 || apiErr.Metadata["tx"] != signature {
		t.Fatalf("payment_not_bound_to_caller: %v", err)
	}
	if atomic.LoadInt32(&refused) != 1 || atomic.LoadInt32(&served) != 0 {
		t.Fatalf("%d refused, %d served", refused, served)
	}

	// Through the paying transport: the bare signature goes out with the paying wallet's signature over the request.
	tr := &Transport{Base: router.Client().Transport, Signer: wallet, Host: f.Host, Now: fixed}
	paying := trellis.NewClient(trellis.WithAPIKey(""), trellis.WithBaseURL(router.URL), trellis.WithHTTPClient(&http.Client{Transport: tr}))
	res, err := paying.Chat(context.Background(), chat, trellis.WithRequestHeader(HeaderPayment, signature))
	if err != nil || res.Text() != "paid" || atomic.LoadInt32(&served) != 1 {
		t.Fatalf("transport: %v", err)
	}
	// A header the caller already set is left alone (the client's own wallet option signs the same request).
	walletClient := trellis.NewClient(trellis.WithAPIKey(""), trellis.WithBaseURL(router.URL), trellis.WithHTTPClient(&http.Client{Transport: tr}), trellis.WithWalletHost(f.Host))
	if _, err := walletClient.Chat(context.Background(), chat, trellis.WithRequestHeader(HeaderPayment, signature), trellis.WithRequestHeader(trellis.HeaderWalletAuth, seen.Load().(string))); err != nil || atomic.LoadInt32(&served) != 2 {
		t.Fatalf("a caller-set header was replaced: %v", err)
	}
	// By hand, on a request built without the client.
	body := []byte(`{"model":"example/model","messages":[{"role":"user","content":"hi"}]}`)
	req, _ := http.NewRequest(http.MethodPost, router.URL+"/api/v1/chat/completions", bytes.NewReader(body))
	if err := BindPaymentSignature(req, body, signature, wallet, f.Host, fixed()); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get(HeaderPayment) != signature || req.Header.Get(trellis.HeaderWalletAuth) == "" {
		t.Fatal("BindPaymentSignature left a header out")
	}
	hres, err := router.Client().Do(req)
	if err != nil || hres.StatusCode != 200 {
		t.Fatalf("by hand: %v %v", hres, err)
	}
	hres.Body.Close()
	// Signed for another host, or by another wallet than the one that paid: the router refuses, as the fixture says.
	other := &Transport{Base: router.Client().Transport, Signer: f.signer(t, "session"), Host: f.Host, Now: fixed}
	stranger := trellis.NewClient(trellis.WithAPIKey(""), trellis.WithBaseURL(router.URL), trellis.WithHTTPClient(&http.Client{Transport: other}))
	if _, err := stranger.Chat(context.Background(), chat, trellis.WithRequestHeader(HeaderPayment, signature)); !trellis.IsPaymentNotBound(err) {
		t.Fatalf("another wallet presented the payment: %v", err)
	}
	// Refusals before anything is sent.
	before := atomic.LoadInt32(&served) + atomic.LoadInt32(&refused)
	if err := BindPaymentSignature(req, body, "not a signature", wallet, f.Host, fixed()); err == nil {
		t.Fatal("a malformed signature was bound")
	}
	if err := BindPaymentSignature(req, body, signature, nil, f.Host, fixed()); err == nil {
		t.Fatal("a payment was bound without the wallet")
	}
	if atomic.LoadInt32(&served)+atomic.LoadInt32(&refused) != before {
		t.Fatal("a refused binding reached the router")
	}
}
