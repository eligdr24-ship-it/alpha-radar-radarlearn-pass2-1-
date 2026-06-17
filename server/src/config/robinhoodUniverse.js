// Robinhood Crypto Universe — single source of truth.
// Edit this list to change which coins Alpha Radar tracks/ranks/analyzes.
// Set ROBINHOOD_ONLY=false (env) to temporarily scan the full market again.

export const UNIVERSE_LABEL = 'Robinhood Crypto Universe';

// Categories in display order.
export const CATEGORIES = [
  'Store of Value', 'Smart Contracts', 'Payments', 'DeFi',
  'Infrastructure', 'Meme Coins', 'Layer 2', 'AI / Compute', 'Other',
];

// One entry per supported coin. category MUST be one of CATEGORIES.
export const ROBINHOOD_COINS = [
  { symbol: 'BTC', category: 'Store of Value' },
  { symbol: 'ETH', category: 'Smart Contracts' },
  { symbol: 'SOL', category: 'Smart Contracts' },
  { symbol: 'XRP', category: 'Payments' },
  { symbol: 'ADA', category: 'Smart Contracts' },
  { symbol: 'DOGE', category: 'Meme Coins' },
  { symbol: 'SHIB', category: 'Meme Coins' },
  { symbol: 'PEPE', category: 'Meme Coins' },
  { symbol: 'AVAX', category: 'Smart Contracts' },
  { symbol: 'LINK', category: 'Infrastructure' },
  { symbol: 'HBAR', category: 'Smart Contracts' },
  { symbol: 'SUI', category: 'Smart Contracts' },
  { symbol: 'BONK', category: 'Meme Coins' },
  { symbol: 'AAVE', category: 'DeFi' },
  { symbol: 'UNI', category: 'DeFi' },
  { symbol: 'DOT', category: 'Infrastructure' },
  { symbol: 'ATOM', category: 'Infrastructure' },
  { symbol: 'ARB', category: 'Layer 2' },
  { symbol: 'OP', category: 'Layer 2' },
  { symbol: 'NEAR', category: 'Smart Contracts' },
  { symbol: 'RENDER', category: 'AI / Compute' },
  { symbol: 'INJ', category: 'DeFi' },
  { symbol: 'FIL', category: 'Infrastructure' },
  { symbol: 'ALGO', category: 'Smart Contracts' },
  { symbol: 'BCH', category: 'Payments' },
  { symbol: 'ETC', category: 'Smart Contracts' },
  { symbol: 'MKR', category: 'DeFi' },
  { symbol: 'COMP', category: 'DeFi' },
  { symbol: 'LTC', category: 'Payments' },
  { symbol: 'XLM', category: 'Payments' },
  { symbol: 'APT', category: 'Smart Contracts' },
];

// Whether to restrict the universe to the list above. Env override: ROBINHOOD_ONLY=false
export const ROBINHOOD_ONLY = String(process.env.ROBINHOOD_ONLY ?? 'true').toLowerCase() !== 'false';

// Derived lookups.
export const ROBINHOOD_SYMBOLS = ROBINHOOD_COINS.map((c) => c.symbol);
export const ROBINHOOD_SET = new Set(ROBINHOOD_SYMBOLS);
export const CATEGORY_BY_SYMBOL = Object.fromEntries(ROBINHOOD_COINS.map((c) => [c.symbol, c.category]));

export const isRobinhood = (symbol) => ROBINHOOD_SET.has(String(symbol || '').toUpperCase());
export const categoryOf = (symbol) => CATEGORY_BY_SYMBOL[String(symbol || '').toUpperCase()] || 'Other';

// Filter + annotate a coin list. Pure. Always tags `category`; only filters when ROBINHOOD_ONLY.
export function applyRobinhoodUniverse(coins, { only = ROBINHOOD_ONLY } = {}) {
  const tagged = (coins || []).map((c) => ({ ...c, category: categoryOf(c.symbol) }));
  return only ? tagged.filter((c) => isRobinhood(c.symbol)) : tagged;
}
