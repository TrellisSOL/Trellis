package solana

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	trellis "example.com/trellis/sdk-go"
	sol "github.com/gagliardetto/solana-go"
)

// Placeholder keys: base58 of repeated bytes, never real wallets.
var (
	localnetProgram = sol.MustPublicKeyFromBase58("9ZmEvfrQrZuVXGc4PovskV83KNxVvpFpvSu3K6R9a9tL")
	payerKey        = sol.PublicKeyFromBytes(bytes.Repeat([]byte{1}, 32)) // 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi
	payeeKey        = sol.PublicKeyFromBytes(bytes.Repeat([]byte{2}, 32)) // 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR
	sessionPub      = sol.PublicKeyFromBytes(bytes.Repeat([]byte{3}, 32))
	feePayerKey     = sol.PublicKeyFromBytes(bytes.Repeat([]byte{4}, 32)) // GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq
	blockhash       = sol.PublicKeyFromBytes(bytes.Repeat([]byte{9}, 32)).String()
)

// testNow is the moment the tests open tabs at: the expiry check reads the package clock, which setClock pins.
const testNow = 1_799_000_000

func setClock(t *testing.T, unix int64) {
	t.Helper()
	prev := now
	now = func() time.Time { return time.Unix(unix, 0) }
	t.Cleanup(func() { now = prev })
}

func seedSigner(t *testing.T, b byte) *KeySigner {
	t.Helper()
	s, err := NewKeySigner(bytes.Repeat([]byte{b}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestPDAVectors(t *testing.T) {
	p := NewTabProgram(localnetProgram)
	// Frozen vectors (computed once with solana-go) and a live recomputation from the raw seeds.
	cfg, err := p.ConfigAddress()
	if err != nil || cfg.String() != "9GCbuLgAAPFpibCnTmdbVQxyomjwVr6pHsD8o56CeRwW" {
		t.Fatalf("config %s %v", cfg, err)
	}
	tab, err := p.TabAddress(payerKey, payeeKey, 7)
	if err != nil || tab.String() != "7y6e8e2Awx3Sw3g7C55UBkofa4hMh56F71DGmtzzRDVP" {
		t.Fatalf("tab %s %v", tab, err)
	}
	if got, _ := TabAddress(localnetProgram, payerKey, payeeKey, 7); got != tab {
		t.Fatal("package-level TabAddress differs")
	}
	esc, err := p.EscrowAddress(tab)
	if err != nil || esc.String() != "BsS1XA1RiTihmNem47LqBkzr5WWagZFfQEtCHzAk8G1M" {
		t.Fatalf("escrow %s %v", esc, err)
	}
	ata, err := AssociatedTokenAddress(payerKey, USDCMint)
	if err != nil || ata.String() != "Gs6NxmndAL3PULGZeYUHCknpMdDVbL46eFCBh856p5z6" {
		t.Fatalf("ata %s %v", ata, err)
	}
	seeds := [][]byte{[]byte("tab"), payerKey.Bytes(), payeeKey.Bytes(), {7, 0, 0, 0, 0, 0, 0, 0}}
	if ref, _, _ := sol.FindProgramAddress(seeds, localnetProgram); ref != tab {
		t.Fatalf("tab PDA %s differs from the seed derivation %s", tab, ref)
	}
	if ref, _, _ := sol.FindProgramAddress([][]byte{[]byte("escrow"), tab.Bytes()}, localnetProgram); ref != esc {
		t.Fatal("escrow PDA differs from the seed derivation")
	}
	if ref, _, _ := sol.FindProgramAddress([][]byte{payerKey.Bytes(), TokenProgram.Bytes(), USDCMint.Bytes()}, AssociatedTokenProgram); ref != ata {
		t.Fatal("ATA differs from the seed derivation")
	}
	if other, _ := p.TabAddress(payerKey, payeeKey, 8); other == tab {
		t.Fatal("tab id not part of the seeds")
	}
	enf, err := p.EnforcerAddress()
	if ref, _, _ := sol.FindProgramAddress([][]byte{[]byte("enforcer")}, localnetProgram); err != nil || ref != enf || enf == cfg {
		t.Fatalf("enforcer PDA %s %v", enf, err)
	}
	rulesProgram := sol.PublicKeyFromBytes(bytes.Repeat([]byte{8}, 32))
	rb, err := RulebookAddress(rulesProgram, payerKey, 3)
	if ref, _, _ := sol.FindProgramAddress([][]byte{[]byte("rulebook"), payerKey.Bytes(), {3, 0, 0, 0, 0, 0, 0, 0}}, rulesProgram); err != nil || ref != rb {
		t.Fatalf("rulebook PDA %s %v", rb, err)
	}
	group, err := NewRulebookAccounts(rulesProgram, rb)
	if ref, _, _ := sol.FindProgramAddress([][]byte{[]byte("config")}, rulesProgram); err != nil || group.RulesConfig != ref || group.Rulebook != rb || group.RulesProgram != rulesProgram {
		t.Fatalf("rulebook group %+v %v", group, err)
	}
	if _, err := NewRulebookAccounts(PublicKey{}, rb); err == nil {
		t.Fatal("a rulebook group without the rules program")
	}
}

func TestOpenTabTransactionBytes(t *testing.T) {
	setClock(t, testNow)
	tx, tab, err := OpenTabTransaction(localnetProgram, payerKey, payeeKey, 5_000_000, 1_800_000_000, sessionPub, 7, nil, blockhash)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	// Decode with solana-go and check what the program will see.
	dec, err := sol.TransactionFromBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	m := dec.Message
	if m.Header.NumRequiredSignatures != 1 || m.AccountKeys[0] != payerKey || m.RecentBlockhash.String() != blockhash || len(m.Instructions) != 1 || len(m.AddressTableLookups) != 0 {
		t.Fatalf("message %+v", m)
	}
	if len(dec.Signatures) != 1 || dec.Signatures[0] != (sol.Signature{}) {
		t.Fatalf("an unsigned transaction must carry one empty signature: %v", dec.Signatures)
	}
	ix := m.Instructions[0]
	if m.AccountKeys[ix.ProgramIDIndex] != localnetProgram {
		t.Fatal("program id")
	}
	p := NewTabProgram(localnetProgram)
	cfg, _ := p.ConfigAddress()
	esc, _ := p.EscrowAddress(tab)
	enf, _ := p.EnforcerAddress()
	ata, _ := AssociatedTokenAddress(payerKey, USDCMint)
	// Without a rulebook the three optional slots (7, 10, 11) hold the program id; the enforcer PDA is always last.
	want := []PublicKey{payerKey, payeeKey, cfg, tab, USDCMint, esc, ata, localnetProgram, TokenProgram, SystemProgram, localnetProgram, localnetProgram, enf}
	if len(ix.Accounts) != len(want) {
		t.Fatalf("%d accounts", len(ix.Accounts))
	}
	for i, w := range want {
		if got := m.AccountKeys[ix.Accounts[i]]; got != w {
			t.Errorf("account %d = %s, want %s", i, got, w)
		}
	}
	// Signer and writable flags from the header layout.
	isSigner := func(i int) bool { return i < int(m.Header.NumRequiredSignatures) }
	isWritable := func(i int) bool {
		n := len(m.AccountKeys)
		s := int(m.Header.NumRequiredSignatures)
		if i < s {
			return i < s-int(m.Header.NumReadonlySignedAccounts)
		}
		return i < n-int(m.Header.NumReadonlyUnsignedAccounts)
	}
	flags := map[PublicKey][2]bool{} // signer, writable
	flags[payerKey] = [2]bool{true, true}
	flags[tab] = [2]bool{false, true}
	flags[esc] = [2]bool{false, true}
	flags[ata] = [2]bool{false, true}
	for _, k := range []PublicKey{payeeKey, cfg, USDCMint, localnetProgram, TokenProgram, SystemProgram, enf} {
		flags[k] = [2]bool{false, false}
	}
	for i, k := range m.AccountKeys {
		f := flags[k]
		if isSigner(i) != f[0] || isWritable(i) != f[1] {
			t.Errorf("%s: signer=%v writable=%v, want %v", k, isSigner(i), isWritable(i), f)
		}
	}
	const wantData = "4c3b0b3bda3a1e3b" + // discriminator
		"0700000000000000" + // tab_id 7
		"404b4c0000000000" + // cap 5_000_000
		"00d2496b00000000" + // expiry 1_800_000_000
		"0303030303030303030303030303030303030303030303030303030303030303" // session key
	if hex.EncodeToString(ix.Data) != wantData {
		t.Fatalf("data %x", ix.Data)
	}
	// A rulebook fills the optional slots: the rulebook (writable), the rules config and the rules program.
	rulesProgram := sol.PublicKeyFromBytes(bytes.Repeat([]byte{8}, 32))
	rules, err := NewRulebookAccounts(rulesProgram, sol.PublicKeyFromBytes(bytes.Repeat([]byte{5}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	ix2, _, err := p.OpenTabInstruction(payerKey, payeeKey, 1, testNow+1, sessionPub, 7, rules)
	if err != nil {
		t.Fatal(err)
	}
	acc := ix2.Accounts()
	if len(acc) != 13 || acc[7].PublicKey != rules.Rulebook || !acc[7].IsWritable || acc[7].IsSigner || acc[10].PublicKey != rules.RulesConfig || acc[10].IsWritable || acc[11].PublicKey != rulesProgram || acc[11].IsWritable || acc[12].PublicKey != enf {
		t.Fatalf("rulebook group: %v %v %v %v", acc[7], acc[10], acc[11], acc[12])
	}
	if _, _, err := p.OpenTabInstruction(payerKey, payeeKey, 1, testNow+1, sessionPub, 7, &RulebookAccounts{Rulebook: rules.Rulebook}); err == nil {
		t.Fatal("a rulebook without its rules program accepted")
	}
	if _, _, err := OpenTabTransaction(localnetProgram, payerKey, payeeKey, 0, testNow+1, sessionPub, 7, nil, blockhash); err == nil {
		t.Fatal("cap 0 accepted")
	}
	// Another mint changes the payer token account only.
	devnet := TabProgram{ProgramID: localnetProgram, Mint: sol.PublicKeyFromBytes(bytes.Repeat([]byte{6}, 32))}
	ix3, _, _ := devnet.OpenTabInstruction(payerKey, payeeKey, 1, testNow+1, sessionPub, 7, nil)
	devAta, _ := AssociatedTokenAddress(payerKey, devnet.Mint)
	if ix3.Accounts()[4].PublicKey != devnet.Mint || ix3.Accounts()[6].PublicKey != devAta {
		t.Fatal("mint override")
	}
}

func TestOpenTabExpiryBounds(t *testing.T) {
	setClock(t, testNow)
	p := NewTabProgram(localnetProgram)
	max := int64(MaxTabLifetime / time.Second)
	if max != 30*86_400 {
		t.Fatalf("MaxTabLifetime is %d seconds", max)
	}
	for _, ok := range []int64{testNow + 1, testNow + 3600, testNow + max} {
		if _, _, err := p.OpenTabInstruction(payerKey, payeeKey, 1, ok, sessionPub, 7, nil); err != nil {
			t.Errorf("expiry now+%d refused: %v", ok-testNow, err)
		}
	}
	for _, bad := range []int64{testNow + max + 1, testNow + 365*86_400, testNow, testNow - 1, 0, -5} {
		_, _, err := p.OpenTabInstruction(payerKey, payeeKey, 1, bad, sessionPub, 7, nil)
		if !errors.Is(err, ErrTabExpiry) {
			t.Errorf("expiry now%+d accepted: %v", bad-testNow, err)
		}
		if _, _, err := OpenTabTransaction(localnetProgram, payerKey, payeeKey, 1, bad, sessionPub, 7, nil, blockhash); !errors.Is(err, ErrTabExpiry) {
			t.Errorf("OpenTabTransaction: expiry now%+d accepted: %v", bad-testNow, err)
		}
	}
	// The refusal says what would be accepted.
	_, _, err := p.OpenTabInstruction(payerKey, payeeKey, 1, testNow+max+1, sessionPub, 7, nil)
	if err == nil || !strings.Contains(err.Error(), "30 days") {
		t.Fatalf("the refusal does not name the bound: %v", err)
	}
	// The real clock: a year from now is always too far, an hour from now never is.
	now = time.Now
	if _, _, err := p.OpenTabInstruction(payerKey, payeeKey, 1, time.Now().Add(365*24*time.Hour).Unix(), sessionPub, 7, nil); !errors.Is(err, ErrTabExpiry) {
		t.Fatalf("a year from now accepted: %v", err)
	}
	if _, _, err := p.OpenTabInstruction(payerKey, payeeKey, 1, time.Now().Add(time.Hour).Unix(), sessionPub, 7, nil); err != nil {
		t.Fatalf("an hour from now refused: %v", err)
	}
}

func TestTopUpInstruction(t *testing.T) {
	tab, _ := TabAddress(localnetProgram, payerKey, payeeKey, 7)
	ix, err := TopUpInstruction(localnetProgram, payerKey, tab, 250_000, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := ix.Data()
	if hex.EncodeToString(data) != "ece160093c6a4dd0"+"90d0030000000000" {
		t.Fatalf("data %x", data)
	}
	p := NewTabProgram(localnetProgram)
	cfg, _ := p.ConfigAddress()
	esc, _ := p.EscrowAddress(tab)
	enf, _ := p.EnforcerAddress()
	ata, _ := AssociatedTokenAddress(payerKey, USDCMint)
	acc := ix.Accounts()
	wantKeys := []PublicKey{payerKey, cfg, tab, USDCMint, esc, ata, TokenProgram, localnetProgram, localnetProgram, localnetProgram, enf}
	wantSigner := []bool{true, false, false, false, false, false, false, false, false, false, false}
	wantWritable := []bool{false, false, true, false, true, true, false, false, false, false, false}
	if len(acc) != len(wantKeys) {
		t.Fatalf("%d accounts", len(acc))
	}
	for i := range wantKeys {
		if acc[i].PublicKey != wantKeys[i] || acc[i].IsSigner != wantSigner[i] || acc[i].IsWritable != wantWritable[i] {
			t.Errorf("account %d: %+v", i, acc[i])
		}
	}
	// A rulebook-bound tab passes its rulebook group in the optional slots.
	rules, _ := NewRulebookAccounts(sol.PublicKeyFromBytes(bytes.Repeat([]byte{8}, 32)), sol.PublicKeyFromBytes(bytes.Repeat([]byte{5}, 32)))
	bound, err := p.TopUpInstruction(payerKey, tab, 250_000, rules)
	if err != nil {
		t.Fatal(err)
	}
	if b := bound.Accounts(); len(b) != 11 || b[7].PublicKey != rules.Rulebook || !b[7].IsWritable || b[8].PublicKey != rules.RulesConfig || b[9].PublicKey != rules.RulesProgram || b[10].PublicKey != enf {
		t.Fatalf("rulebook group: %v", b[7:])
	}
	if _, err := TopUpInstruction(localnetProgram, payerKey, tab, 0, nil); err == nil {
		t.Fatal("amount 0 accepted")
	}
}

func TestReclaimInstruction(t *testing.T) {
	p := NewTabProgram(localnetProgram)
	tab, _ := p.TabAddress(payerKey, payeeKey, 7)
	ix, err := ReclaimInstruction(localnetProgram, payerKey, payeeKey, tab)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := p.ConfigAddress()
	esc, _ := p.EscrowAddress(tab)
	payerAta, _ := AssociatedTokenAddress(payerKey, USDCMint)
	payeeAta, _ := AssociatedTokenAddress(payeeKey, USDCMint)
	wantKeys := []PublicKey{payerKey, tab, cfg, USDCMint, esc, payerAta, payeeAta, TokenProgram}
	wantWritable := []bool{true, true, false, false, true, true, true, false}
	acc := ix.Accounts()
	if len(acc) != len(wantKeys) {
		t.Fatalf("%d accounts", len(acc))
	}
	for i := range wantKeys {
		// Nobody signs a reclaim, and no rulebook account is part of it.
		if acc[i].PublicKey != wantKeys[i] || acc[i].IsSigner || acc[i].IsWritable != wantWritable[i] {
			t.Errorf("account %d: %+v", i, acc[i])
		}
	}
	if data, _ := ix.Data(); !bytes.Equal(data, ReclaimDiscriminator[:]) {
		t.Fatalf("data %x", data)
	}
}

// sameRequirement compares two requirements by value (FeePayer is a pointer).
func sameRequirement(a, b Requirement) bool {
	fa, fb := a.Extra.FeePayer, b.Extra.FeePayer
	a.Extra.FeePayer, b.Extra.FeePayer = nil, nil
	return a == b && (fa == nil) == (fb == nil) && (fa == nil || *fa == *fb)
}

func requirement(amount string) Requirement {
	fp := feePayerKey.String()
	return Requirement{Scheme: "exact", Network: NetworkDevnet, MaxAmountRequired: amount, Resource: "https://router.example/api/v1/chat/completions", Description: "Pay-per-call inference", MimeType: "application/json", PayTo: payeeKey.String(), MaxTimeoutSeconds: 60, Asset: USDCMint.String(), Extra: RequirementExtra{FeePayer: &fp, Decimals: 6}}
}

// checkPaid mirrors the router's inspectExactTransaction (src/solana/x402.ts) independently of the package's own
// inspectExact: the rules a payment must satisfy.
func checkPaid(t *testing.T, b64 string, feePayer, payTo, mint PublicKey) (payer PublicKey, amount uint64) {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := sol.TransactionFromBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	m := tx.Message
	if len(m.AddressTableLookups) != 0 {
		t.Fatal("address lookup tables")
	}
	if len(m.AccountKeys) == 0 || m.AccountKeys[0] != feePayer {
		t.Fatalf("fee payer %s", m.AccountKeys[0])
	}
	dest, _ := AssociatedTokenAddress(payTo, mint)
	transfers := 0
	var ataFunder PublicKey
	for _, ix := range m.Instructions {
		prog := m.AccountKeys[ix.ProgramIDIndex]
		// The fee payer pays the fee and nothing else: no instruction names it, as an account or as a program.
		if ix.ProgramIDIndex == 0 {
			t.Fatal("the fee payer is named as a program")
		}
		for _, a := range ix.Accounts {
			if a == 0 || m.AccountKeys[a] == feePayer {
				t.Fatal("an instruction names the fee payer")
			}
		}
		switch {
		case prog == ComputeBudgetProgram:
			continue
		case prog == AssociatedTokenProgram:
			if len(ix.Data) != 1 || ix.Data[0] != 1 || m.AccountKeys[ix.Accounts[1]] != dest || m.AccountKeys[ix.Accounts[2]] != payTo || m.AccountKeys[ix.Accounts[3]] != mint {
				t.Fatal("bad ATA creation")
			}
			ataFunder = m.AccountKeys[ix.Accounts[0]]
			continue
		case prog == TokenProgram || prog == Token2022Program:
		default:
			t.Fatalf("unexpected program %s", prog)
		}
		transfers++
		if len(ix.Data) != 10 || ix.Data[0] != 12 || ix.Data[9] != 6 {
			t.Fatalf("not TransferChecked: %x", ix.Data)
		}
		if m.AccountKeys[ix.Accounts[1]] != mint || m.AccountKeys[ix.Accounts[2]] != dest {
			t.Fatal("mint or destination")
		}
		payer = m.AccountKeys[ix.Accounts[3]]
		src, _ := AssociatedTokenAddress(payer, mint)
		if m.AccountKeys[ix.Accounts[0]] != src {
			t.Fatal("source is not the payer's ATA")
		}
		amount = binary.LittleEndian.Uint64(ix.Data[1:9])
	}
	if transfers != 1 {
		t.Fatalf("%d transfers", transfers)
	}
	if !ataFunder.IsZero() && ataFunder != payer {
		t.Fatalf("payTo's token account is funded by %s, not by the payer", ataFunder)
	}
	n := int(m.Header.NumRequiredSignatures)
	if n != 2 {
		t.Fatalf("%d required signatures", n)
	}
	payerIndex := -1
	for i, k := range m.AccountKeys {
		if k == payer {
			payerIndex = i
		}
	}
	if payerIndex < 1 || payerIndex >= n {
		t.Fatalf("payer index %d of %d signers", payerIndex, n)
	}
	msg, _ := m.MarshalBinary()
	if len(tx.Signatures) != n || tx.Signatures[0] != (sol.Signature{}) {
		t.Fatalf("fee payer slot must stay empty: %v", tx.Signatures)
	}
	for i := 1; i < n; i++ {
		if !ed25519.Verify(ed25519.PublicKey(m.AccountKeys[i].Bytes()), msg, tx.Signatures[i][:]) {
			t.Fatalf("signature %d does not verify", i)
		}
	}
	return payer, amount
}

func TestBuildExactPayment(t *testing.T) {
	signer := seedSigner(t, 0x11)
	req := requirement("12345")
	p, err := BuildExactPayment(req, signer, blockhash, nil)
	if err != nil {
		t.Fatal(err)
	}
	payer, amount := checkPaid(t, p.Base64, feePayerKey, payeeKey, USDCMint)
	if payer != signer.PublicKey() || amount != 12345 || p.Amount != 12345 || p.Payer != payer || p.FeePayer != feePayerKey {
		t.Fatalf("payment %+v", p)
	}
	if p.Transaction.Message.RecentBlockhash.String() != blockhash || len(p.Transaction.Message.Instructions) != 1 {
		t.Fatal("blockhash or instruction count")
	}
	// Options: more than required, the destination account creation, Token-2022.
	p2, err := BuildExactPayment(req, signer, blockhash, &ExactOptions{Amount: 20000, CreateDestinationATA: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, amount := checkPaid(t, p2.Base64, feePayerKey, payeeKey, USDCMint); amount != 20000 || len(p2.Transaction.Message.Instructions) != 2 {
		t.Fatalf("amount %d, %d instructions", amount, len(p2.Transaction.Message.Instructions))
	}
	// The payer funds payTo's token account: it is the creation's first account, a writable signer. The fee payer is not in it.
	create := p2.Transaction.Message.Instructions[0]
	if funder := p2.Transaction.Message.AccountKeys[create.Accounts[0]]; funder != signer.PublicKey() || funder == feePayerKey {
		t.Fatalf("the token account creation is funded by %s", funder)
	}
	// Compute budget inside the bounds: limit, price, then the transfer; the priority fee is reported.
	p3, err := BuildExactPayment(req, signer, blockhash, &ExactOptions{ComputeUnitLimit: 50_000, ComputeUnitPriceMicroLamports: 1_000})
	if err != nil {
		t.Fatal(err)
	}
	checkPaid(t, p3.Base64, feePayerKey, payeeKey, USDCMint)
	if ixs := p3.Transaction.Message.Instructions; len(ixs) != 3 || hex.EncodeToString(ixs[0].Data) != "0250c30000" || hex.EncodeToString(ixs[1].Data) != "03e803000000000000" || p3.PriorityFeeLamports != 50 || p.PriorityFeeLamports != 0 {
		t.Fatalf("compute budget: %d instructions, fee %d", len(ixs), p3.PriorityFeeLamports)
	}
	// Outside the bounds nothing is built.
	for name, o := range map[string]ExactOptions{
		"limit above the cap":             {ComputeUnitLimit: MaxComputeUnitLimit + 1},
		"price above the cap":             {ComputeUnitLimit: 1_000, ComputeUnitPriceMicroLamports: MaxComputeUnitPriceMicroLamports + 1},
		"fee above the cap":               {ComputeUnitLimit: MaxComputeUnitLimit, ComputeUnitPriceMicroLamports: 50_001},
		"price on the default budget":     {ComputeUnitPriceMicroLamports: 50_001},
		"price on two default budgets":    {ComputeUnitPriceMicroLamports: 25_001, CreateDestinationATA: true},
		"a token program that is not one": {TokenProgram: AssociatedTokenProgram},
	} {
		o := o
		if got, err := BuildExactPayment(req, signer, blockhash, &o); !errors.Is(err, ErrOutsideExactBounds) || got != nil {
			t.Errorf("%s: built (%v)", name, err)
		}
	}
	for name, o := range map[string]ExactOptions{
		"the largest fee on the default budget": {ComputeUnitPriceMicroLamports: 50_000},
		"the largest fee on two budgets":        {ComputeUnitPriceMicroLamports: 25_000, CreateDestinationATA: true},
		"the largest price on a small limit":    {ComputeUnitLimit: 2_000, ComputeUnitPriceMicroLamports: MaxComputeUnitPriceMicroLamports},
	} {
		o := o
		if got, err := BuildExactPayment(req, signer, blockhash, &o); err != nil || got.PriorityFeeLamports != MaxPriorityFeeLamports {
			t.Errorf("%s: %v", name, err)
		}
	}
	// The fee payer is named by no instruction, whatever the requirement says: a payTo or a payer that is the fee payer
	// itself cannot be paid this way.
	selfPay := req
	selfPay.PayTo = feePayerKey.String()
	if _, err := BuildExactPayment(selfPay, signer, blockhash, &ExactOptions{CreateDestinationATA: true}); !errors.Is(err, ErrOutsideExactBounds) {
		t.Fatalf("payTo = fee payer with a token account creation: %v", err)
	}
	own := signer.PublicKey().String()
	asFeePayer := req
	asFeePayer.Extra.FeePayer = &own
	if _, err := BuildExactPayment(asFeePayer, signer, blockhash, nil); !errors.Is(err, ErrOutsideExactBounds) {
		t.Fatalf("payer = fee payer: %v", err)
	}
	if _, err := BuildExactPayment(req, signer, blockhash, &ExactOptions{Amount: 1}); err == nil {
		t.Fatal("underpayment accepted")
	}
	noFee := req
	noFee.Extra.FeePayer = nil
	if _, err := BuildExactPayment(noFee, signer, blockhash, nil); err == nil {
		t.Fatal("no fee payer accepted")
	}
	bad := req
	bad.Scheme = "tab"
	if _, err := BuildExactPayment(bad, signer, blockhash, nil); err == nil {
		t.Fatal("tab scheme accepted as exact")
	}
	if _, err := BuildExactPayment(req, signer, "not-a-hash!", nil); err == nil {
		t.Fatal("bad blockhash accepted")
	}
	bad = req
	bad.Extra.Decimals = 9
	if _, err := BuildExactPayment(bad, signer, blockhash, nil); err == nil {
		t.Fatal("9 decimals accepted")
	}
	// The header: base64 JSON with the transaction inside.
	h := p.Header()
	raw, err := base64.StdEncoding.DecodeString(h)
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		X402Version int    `json:"x402Version"`
		Scheme      string `json:"scheme"`
		Network     string `json:"network"`
		Payload     struct {
			Transaction string `json:"transaction"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || env.X402Version != 1 || env.Scheme != "exact" || env.Network != NetworkDevnet || env.Payload.Transaction != p.Base64 {
		t.Fatalf("header %s: %v", raw, err)
	}
	if PaymentHeader(NetworkDevnet, p.Base64) != h {
		t.Fatal("PaymentHeader differs")
	}
}

func TestParsePaymentRequiredAndResponse(t *testing.T) {
	req := requirement("777")
	v1, _ := json.Marshal(map[string]any{"x402Version": 1, "error": "Payment required", "accepts": []Requirement{req}, "price_usdc": "0.000777", "model": "example/model"})
	v2, _ := json.Marshal(map[string]any{"x402Version": 2, "error": "Payment required", "resource": map[string]string{"url": req.Resource, "description": req.Description, "mimeType": req.MimeType},
		"accepts": []map[string]any{{"scheme": "exact", "network": req.Network, "amount": "777", "asset": req.Asset, "payTo": req.PayTo, "maxTimeoutSeconds": 60, "extra": req.Extra}}})
	resp := &http.Response{StatusCode: 402, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(v1))}
	resp.Header.Set(HeaderPaymentRequired, base64.StdEncoding.EncodeToString(v2))
	pr, err := ParsePaymentRequired(resp)
	if err != nil {
		t.Fatal(err)
	}
	ex, err := pr.Exact()
	if err != nil || !sameRequirement(*ex, req) || pr.PriceUSDC != "0.000777" || pr.Model != "example/model" || pr.X402Version != 1 {
		t.Fatalf("v1: %+v %v", pr, err)
	}
	if n, _ := ex.AmountUnits(); n != 777 {
		t.Fatal("amount")
	}
	if b, _ := io.ReadAll(resp.Body); !bytes.Equal(b, v1) {
		t.Fatal("the body was not put back")
	}
	// Header only (a non-JSON body).
	resp = &http.Response{StatusCode: 402, Header: resp.Header, Body: io.NopCloser(strings.NewReader("Payment Required"))}
	pr, err = ParsePaymentRequired(resp)
	if err != nil {
		t.Fatal(err)
	}
	ex, err = pr.Exact()
	if err != nil || !sameRequirement(*ex, req) || pr.X402Version != 2 {
		t.Fatalf("v2: %+v %v", pr, err)
	}
	// A rejected payment: 402 with payment_error and the same accepts.
	rej, _ := json.Marshal(map[string]any{"x402Version": 1, "error": "Payment rejected", "accepts": []Requirement{req}, "payment_error": "payment_already_claimed"})
	pr, err = ParsePaymentRequired(&http.Response{StatusCode: 402, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(rej))})
	if err != nil || pr.PaymentError != "payment_already_claimed" {
		t.Fatalf("rejected: %+v %v", pr, err)
	}
	if _, err := ParsePaymentRequired(&http.Response{StatusCode: 402, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}); err == nil {
		t.Fatal("empty 402 parsed")
	}
	if _, err := ParsePaymentRequired(&http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}); err == nil {
		t.Fatal("a 200 parsed")
	}

	h := http.Header{}
	if r, err := ParsePaymentResponse(h); r != nil || err != nil {
		t.Fatal("absent header")
	}
	h.Set(HeaderPaymentResponse, base64.StdEncoding.EncodeToString([]byte(`{"success":true,"transaction":"5igsig","network":"`+NetworkDevnet+`","payer":"`+payerKey.String()+`"}`)))
	r, err := ParsePaymentResponse(h)
	if err != nil || !r.Success || r.Transaction != "5igsig" || r.Payer != payerKey.String() || r.Network != NetworkDevnet {
		t.Fatalf("response %+v %v", r, err)
	}
	h = http.Header{}
	h.Set("PAYMENT-RESPONSE", base64.StdEncoding.EncodeToString([]byte(`{"success":false,"transaction":"","errorReason":"insufficient_funds","network":"n","payer":"p"}`)))
	if r, err := ParsePaymentResponse(h); err != nil || r.Success || r.ErrorReason != "insufficient_funds" {
		t.Fatalf("v2 failure %+v %v", r, err)
	}
	h.Set("PAYMENT-RESPONSE", "@@")
	if _, err := ParsePaymentResponse(h); err == nil {
		t.Fatal("bad base64 accepted")
	}
}

func TestPayPerCallRetry(t *testing.T) {
	signer := seedSigner(t, 0x22)
	req := requirement("5000")
	var rpcCalls, calls int32
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&rpcCalls, 1)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["method"] != "getLatestBlockhash" {
			t.Errorf("rpc method %v", body["method"])
		}
		io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":{"blockhash":"`+blockhash+`","lastValidBlockHeight":100}}}`)
	}))
	defer rpc.Close()
	var paid atomic.Value // the X-PAYMENT the router saw
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"model":"example/model"`) {
			t.Errorf("body lost on attempt %d: %q", atomic.LoadInt32(&calls), body)
		}
		pay := r.Header.Get(HeaderPayment)
		if pay == "" {
			v1, _ := json.Marshal(map[string]any{"x402Version": 1, "error": "Payment required", "accepts": []Requirement{req}, "price_usdc": "0.005", "model": "example/model"})
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(402)
			w.Write(v1)
			return
		}
		paid.Store(pay)
		raw, _ := base64.StdEncoding.DecodeString(pay)
		var env struct {
			X402Version int    `json:"x402Version"`
			Scheme      string `json:"scheme"`
			Network     string `json:"network"`
			Payload     struct {
				Transaction string `json:"transaction"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &env); err != nil || env.X402Version != 1 || env.Scheme != "exact" || env.Network != NetworkDevnet {
			t.Errorf("payment header %s", raw)
		}
		payer, amount := checkPaid(t, env.Payload.Transaction, feePayerKey, payeeKey, USDCMint)
		if amount != 5000 || payer != signer.PublicKey() {
			t.Errorf("paid %d by %s", amount, payer)
		}
		w.Header().Set(HeaderPaymentResponse, base64.StdEncoding.EncodeToString([]byte(`{"success":true,"transaction":"txsig","network":"`+NetworkDevnet+`","payer":"`+payer.String()+`"}`)))
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"gen-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"paid"}}]}`)
	}))
	defer router.Close()

	hc := PayPerCall(router.Client(), signer, rpc.URL)
	c := trellis.NewClient(trellis.WithBaseURL(router.URL), trellis.WithHTTPClient(hc))
	res, err := c.Chat(context.Background(), trellis.ChatRequest{Model: "example/model", Messages: []trellis.Message{trellis.UserMessage("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Text() != "paid" || atomic.LoadInt32(&calls) != 2 || atomic.LoadInt32(&rpcCalls) != 1 || paid.Load() == nil {
		t.Fatalf("text %q, %d calls, %d rpc calls", res.Text(), calls, rpcCalls)
	}
	pr, err := ParsePaymentResponse(res.Meta.Header)
	if err != nil || !pr.Success || pr.Transaction != "txsig" {
		t.Fatalf("settlement %+v %v", pr, err)
	}
	// MaxAmount below the price refuses before paying.
	tr := &Transport{Base: router.Client().Transport, Signer: signer, RPCURL: rpc.URL, MaxAmount: 100}
	c2 := trellis.NewClient(trellis.WithBaseURL(router.URL), trellis.WithHTTPClient(&http.Client{Transport: tr}))
	if _, err := c2.Chat(context.Background(), trellis.ChatRequest{Model: "example/model"}); err == nil || !strings.Contains(err.Error(), "MaxAmount") {
		t.Fatalf("MaxAmount: %v", err)
	}
	calls = 0
	// A plain 402 without x402 content passes through untouched.
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(402)
		io.WriteString(w, `{"error":{"code":402,"message":"no","type":"payment_required"}}`)
	}))
	defer plain.Close()
	c4 := trellis.NewClient(trellis.WithBaseURL(plain.URL), trellis.WithHTTPClient(PayPerCall(plain.Client(), signer, rpc.URL)))
	_, err = c4.Chat(context.Background(), trellis.ChatRequest{Model: "m"})
	var apiErr *trellis.APIError
	if !errorsAs(err, &apiErr) || apiErr.StatusCode != 402 || apiErr.Type != "payment_required" || atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("plain 402: %v (%d calls)", err, calls)
	}
}

// A wallet-signed request answered 402: the paid retry carries the signed payment and not the wallet header, which is
// single use and was spent on the first attempt.
func TestPayPerCallRetryDropsSpentWalletAuth(t *testing.T) {
	signer := seedSigner(t, 0x22)
	wallet := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x22}, 32))
	req := requirement("5000")
	used := map[string]bool{}
	var mu sync.Mutex
	var attempts []http.Header
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		attempts = append(attempts, r.Header.Clone())
		w.Header().Set("Content-Type", "application/json")
		if wa := r.Header.Get(trellis.HeaderWalletAuth); wa != "" {
			if used[wa] {
				w.WriteHeader(401)
				io.WriteString(w, `{"error":{"code":401,"message":"X-Wallet-Auth signature was already used.","type":"invalid_wallet_auth"}}`)
				return
			}
			used[wa] = true
		}
		if r.Header.Get(HeaderPayment) == "" {
			v1, _ := json.Marshal(map[string]any{"x402Version": 1, "error": "Payment required", "accepts": []Requirement{req}})
			w.WriteHeader(402)
			w.Write(v1)
			return
		}
		io.WriteString(w, `{"id":"gen-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"paid"}}]}`)
	}))
	defer router.Close()
	tr := &Transport{Base: router.Client().Transport, Signer: signer, Blockhash: func(context.Context) (string, error) { return blockhash, nil }}
	c := trellis.NewClient(trellis.WithAPIKey(""), trellis.WithBaseURL(router.URL), trellis.WithHTTPClient(&http.Client{Transport: tr}), trellis.WithWalletKey(wallet))
	res, err := c.Chat(context.Background(), trellis.ChatRequest{Model: "example/model", Messages: []trellis.Message{trellis.UserMessage("hi")}})
	if err != nil || res.Text() != "paid" {
		t.Fatalf("paid retry: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(attempts) != 2 || attempts[0].Get(trellis.HeaderWalletAuth) == "" || attempts[0].Get(HeaderPayment) != "" {
		t.Fatalf("first attempt %v", attempts)
	}
	if attempts[1].Get(HeaderPayment) == "" || attempts[1].Get(trellis.HeaderWalletAuth) != "" {
		t.Fatalf("the paid retry: payment %q, wallet header %q", attempts[1].Get(HeaderPayment), attempts[1].Get(trellis.HeaderWalletAuth))
	}
	// A signed x402 payload is not a bare signature: the transport adds no wallet header to it.
	if trellis.IsTransactionSignature(attempts[1].Get(HeaderPayment)) {
		t.Fatal("the x402 payload has the shape of a bare signature")
	}
}

func errorsAs(err error, target **trellis.APIError) bool {
	for err != nil {
		if e, ok := err.(*trellis.APIError); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func TestTabSessionVouchers(t *testing.T) {
	key, err := GenerateSessionKey()
	if err != nil {
		t.Fatal(err)
	}
	const createdAt = testNow
	tab, _ := TabAddress(localnetProgram, payerKey, payeeKey, 1)
	// The program id, the tab and its created_at are all part of what is signed: none has a default.
	if _, err := NewTabSession(PublicKey{}, tab, createdAt, key); err == nil {
		t.Fatal("a session without the program id")
	}
	if _, err := NewTabSession(localnetProgram, PublicKey{}, createdAt, key); err == nil {
		t.Fatal("a session without the tab")
	}
	if _, err := NewTabSession(localnetProgram, tab, 0, key); err == nil {
		t.Fatal("a session without created_at")
	}
	if _, err := NewTabSession(localnetProgram, tab, createdAt, key[:10]); err == nil {
		t.Fatal("a session with a short key")
	}
	s, err := NewTabSession(localnetProgram, tab, createdAt, key)
	if err != nil {
		t.Fatal(err)
	}
	if s.Headers() != nil || s.Wire() != nil || s.Seq() != 0 || s.ProgramID() != localnetProgram || s.CreatedAt() != createdAt || s.Tab() != tab || s.SessionKey() != SessionPublicKey(key) {
		t.Fatal("fresh session")
	}
	v1, err := s.Voucher(1500)
	if err != nil {
		t.Fatal(err)
	}
	if v1.Seq != 1 || v1.CumulativeUsed != 1500 || len(v1.Message) != 110 || trellis.VoucherMessageLen != 110 || len(v1.Signature) != 64 || v1.SessionKey != SessionPublicKey(key) || v1.ProgramID != localnetProgram || v1.CreatedAt != createdAt {
		t.Fatalf("voucher %+v", v1)
	}
	if !bytes.Equal(v1.Message, trellis.VoucherMessage(localnetProgram, tab, createdAt, 1500, 1)) {
		t.Fatal("message bytes")
	}
	pub := SessionPublicKey(key)
	if !VerifyVoucher(localnetProgram, tab, createdAt, 1500, 1, v1.Signature, pub) || VerifyVoucher(localnetProgram, tab, createdAt, 1501, 1, v1.Signature, pub) || VerifyVoucher(localnetProgram, tab, createdAt, 1500, 1, v1.Signature, sessionPub) {
		t.Fatal("verify")
	}
	// The same tab address opened again later, or the same tab under another deployment, is another voucher.
	if VerifyVoucher(localnetProgram, tab, createdAt+60, 1500, 1, v1.Signature, pub) || VerifyVoucher(payeeKey, tab, createdAt, 1500, 1, v1.Signature, pub) {
		t.Fatal("a voucher verified for another opening or another program")
	}
	h := v1.Headers()
	if h.Get(trellis.HeaderTab) != tab.String() {
		t.Fatalf("tab header %q", h.Get(trellis.HeaderTab))
	}
	msg, sig, err := trellis.ParseVoucherHeader(h.Get(trellis.HeaderTabVoucher))
	if err != nil || !bytes.Equal(msg, v1.Message) || !bytes.Equal(sig, v1.Signature) {
		t.Fatalf("voucher header: %v", err)
	}
	back, err := VerifyVoucherHeaders(h, localnetProgram, createdAt, pub)
	if err != nil || back.Seq != 1 || back.CumulativeUsed != 1500 || back.Tab != tab || back.ProgramID != localnetProgram || back.CreatedAt != createdAt {
		t.Fatalf("headers back: %+v %v", back, err)
	}
	if _, err := VerifyVoucherHeaders(h, localnetProgram, createdAt, sessionPub); err == nil {
		t.Fatal("wrong session key accepted")
	}
	if _, err := VerifyVoucherHeaders(h, localnetProgram, createdAt+60, pub); err == nil {
		t.Fatal("a voucher for another opening of the tab accepted")
	}
	if _, err := VerifyVoucherHeaders(h, payeeKey, createdAt, pub); err == nil {
		t.Fatal("a voucher for another program accepted")
	}
	wrongTab := h.Clone()
	wrongTab.Set(trellis.HeaderTab, payeeKey.String())
	if _, err := VerifyVoucherHeaders(wrongTab, localnetProgram, createdAt, pub); err == nil {
		t.Fatal("tab mismatch accepted")
	}
	// The 48 bytes tab || cumulative_used || seq, validly signed by the session key, are not a voucher.
	legacy := append(append(append([]byte{}, tab.Bytes()...), le64(1500)...), le64(1)...)
	old := http.Header{}
	old.Set(trellis.HeaderTab, tab.String())
	old.Set(trellis.HeaderTabVoucher, trellis.VoucherHeader(legacy, ed25519.Sign(key, legacy)))
	if _, err := VerifyVoucherHeaders(old, localnetProgram, createdAt, pub); err == nil {
		t.Fatal("the 48-byte form accepted")
	}
	w := v1.Wire()
	if w.Tab != tab.String() || w.CumulativeUsed != "1500" || w.Seq != "1" || w.SessionKey != pub.String() {
		t.Fatalf("wire %+v", w)
	}
	if dec, _ := trellis.Base58Decode(w.Signature); !bytes.Equal(dec, v1.Signature) {
		t.Fatal("wire signature")
	}
	wj, _ := json.Marshal(w)
	if !strings.Contains(string(wj), `"cumulative_used":"1500"`) || !strings.Contains(string(wj), `"session_key":"`) {
		t.Fatalf("wire json %s", wj)
	}
	// The session's own Headers/Wire follow the latest voucher; seq increases; cumulative may stay, never fall.
	v2, err := s.Voucher(1500)
	if err != nil || v2.Seq != 2 || s.Headers().Get(trellis.HeaderTabVoucher) != v2.Headers().Get(trellis.HeaderTabVoucher) || s.Wire().Seq != "2" {
		t.Fatalf("second voucher %+v %v", v2, err)
	}
	if _, err := s.Voucher(1499); err == nil {
		t.Fatal("decreasing cumulative accepted")
	}
	s.Resume(10, 9000)
	v3, err := s.Voucher(9500)
	if err != nil || v3.Seq != 11 || s.CumulativeUsed() != 9500 {
		t.Fatalf("resume %+v %v", v3, err)
	}
	// RequestOptions put the two headers on a client call.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := VerifyVoucherHeaders(r.Header, localnetProgram, createdAt, pub); err != nil {
			t.Errorf("request headers: %v", err)
		}
		io.WriteString(w, `{"id":"gen-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`)
	}))
	defer srv.Close()
	c := trellis.NewClient(trellis.WithBaseURL(srv.URL), trellis.WithHTTPClient(srv.Client()))
	if _, err := c.Chat(context.Background(), trellis.ChatRequest{Model: "m"}, v3.RequestOptions()...); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeTabAccount(t *testing.T) {
	enc := func(rulebook *PublicKey) []byte {
		b := append([]byte{}, TabAccountDiscriminator[:]...)
		for _, k := range []PublicKey{payerKey, payeeKey, sessionPub, USDCMint} {
			b = append(b, k.Bytes()...)
		}
		for _, v := range []uint64{7, 5_000_000, 1200, 3, 1_800_000_000, 1_790_000_000} {
			b = append(b, le64(v)...)
		}
		if rulebook == nil {
			b = append(b, 0)
		} else {
			b = append(append(b, 1), rulebook.Bytes()...)
		}
		return append(b, 254, 253)
	}
	tab, err := DecodeTabAccount(enc(nil))
	if err != nil {
		t.Fatal(err)
	}
	if tab.Payer != payerKey || tab.Payee != payeeKey || tab.SessionKey != sessionPub || tab.Mint != USDCMint || tab.TabID != 7 || tab.Cap != 5_000_000 || tab.PostedUsed != 1200 || tab.PostedSeq != 3 || tab.Expiry != 1_800_000_000 || tab.CreatedAt != 1_790_000_000 || tab.Rulebook != nil || tab.Bump != 254 || tab.EscrowBump != 253 {
		t.Fatalf("%+v", tab)
	}
	rb := feePayerKey
	tab, err = DecodeTabAccount(enc(&rb))
	if err != nil || tab.Rulebook == nil || *tab.Rulebook != rb || tab.Bump != 254 {
		t.Fatalf("%+v %v", tab, err)
	}
	if _, err := DecodeTabAccount(enc(nil)[:100]); err == nil {
		t.Fatal("truncated accepted")
	}
	bad := enc(nil)
	bad[0]++
	if _, err := DecodeTabAccount(bad); err == nil {
		t.Fatal("wrong discriminator accepted")
	}
}

func TestKeySigner(t *testing.T) {
	s := seedSigner(t, 0x33)
	full, err := NewKeySigner(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x33}, 32)))
	if err != nil || full.PublicKey() != s.PublicKey() {
		t.Fatal("64-byte key")
	}
	if _, err := NewKeySigner(make([]byte, 31)); err == nil {
		t.Fatal("31 bytes accepted")
	}
	sig, _ := s.Sign([]byte("m"))
	if !ed25519.Verify(ed25519.PublicKey(s.PublicKey().Bytes()), []byte("m"), sig) {
		t.Fatal("signature")
	}
	if _, err := ParseAddress("not base58 0OIl"); err == nil {
		t.Fatal("bad address parsed")
	}
}
