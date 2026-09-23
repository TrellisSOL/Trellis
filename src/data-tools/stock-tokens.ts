// B: tokenized-stock mints with verified price feeds on Solana. The list is empty by design until each (mint, Pyth price
// feed) pair has been verified against the issuer's published mint list on mainnet-beta; an unverified entry would price
// a token off the wrong feed. Rows are (symbol, mint, decimals, Pyth feed id), added only once verified;
// src/data-tools/stock.ts reads them as is.
export const SOL_CHAIN_ID = 101;
export const SOL_STOCK_TOKENS: readonly { symbol: string; address: string; decimals: number; feed: string }[] = [];
