// English, the default and the fallback for every key. zh-Hans.js mirrors this shape.
// The footer link labels and the header menu titles stay in components/Footer.jsx, components/Landing.jsx and
// lib/site-map.js (tests read them there); their translations are keyed by href or task id.
export default {
  lang: {
    label: 'Language',
  },
  nav: {
    skip: 'Skip to content',
    home: 'Trellis home',
    main: 'Main navigation',
    mobile: 'Mobile navigation',
    product: 'Product',
    developers: 'Developers',
    pricing: 'Pricing',
    docs: 'Docs',
    status: 'Status',
    dashboard: 'Dashboard',
    workspace: 'Open workspace',
    open: 'Open navigation',
    close: 'Close navigation',
    closeShort: 'Close',
    explore: 'Explore Trellis',
    homeLink: 'Home',
    search: 'Search',
    searchEverything: 'Search everything',
    groupTasks: '{group} tasks',
  },
  hero: {
    facts: {
      routes: ['Routes to', 'Open models across many providers'],
      paid: ['Paid in', 'USDC on Solana'],
      receipts: ['Receipts', 'Signed per call, rooted hourly'],
      markup: ['Router markup', 'None'],
    },
    kicker: 'The open inference router',
    title: ['Model inference,', 'paid per call.'],
    lede: 'Use one OpenAI-compatible API to reach models across providers. Each answer comes with a signed receipt.',
    key: 'Get an API key',
    docs: 'Read the docs',
  },
  home: {
    product: {
      title: 'Choose where your request runs.',
      body: 'Compare model capabilities, context limits and prices in the catalog. Trellis finds an eligible provider for the model you choose.',
      how: 'How routing works',
      explore: 'Explore models',
      art: 'Climbing vines overlooking a valley at dawn',
    },
    developers: {
      title: 'Your first request',
      quickstart: 'Follow the quickstart',
    },
    trust: {
      title: 'Read the receipt.',
      body: 'Each receipt identifies the route and the cost recorded for that call. Check its signature with the router’s public key.',
      verify: 'Verify a receipt',
    },
    pricing: {
      title: 'Pay per request.',
      body: 'Get an x402 quote in USDC. Your wallet authorizes the payment on Solana.',
      estimate: 'Estimate a call',
      rates: ['Model rates', 'Input and output prices are listed separately in the catalog.'],
      fee: ['Network fee', 'The quote includes the Solana network fee at cost.'],
      prepay: ['Prepayment', 'Per-call payments require no prepaid balance.'],
    },
  },
  firstCall: {
    client: 'Client',
    example: '{client} example',
    record: 'In each model record',
    fields: {
      id: 'Use this identifier when requesting a quote.',
      context_length: 'Maximum context size, in tokens.',
      pricing: 'Input and output rates for this model.',
    },
  },
  footer: {
    about: 'The open inference router for Solana. Any model, any provider, an accountable route.',
    built: 'Built on Solana',
    signed: 'Receipts signed with Ed25519, rooted hourly',
    groups: {},
    links: {},
  },
  groups: {},
  tasks: {},
};
