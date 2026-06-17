export const coins = [
  { symbol:'SOL', name:'Solana', sector:'Layer 1', price:175.42, change24h:2.35, marketCap:'$81.2B', volume24h:'$3.45B', type:'large-alt' },
  { symbol:'PEPE', name:'Pepe', sector:'Meme', price:0.0000136, change24h:-4.9, marketCap:'$5.7B', volume24h:'$1.12B', type:'meme' },
  { symbol:'LINK', name:'Chainlink', sector:'Oracle', price:14.82, change24h:1.65, marketCap:'$9.2B', volume24h:'$618M', type:'alt' },
  { symbol:'SUI', name:'Sui', sector:'Layer 1', price:1.65, change24h:3.11, marketCap:'$5.1B', volume24h:'$720M', type:'alt' },
  { symbol:'BTC', name:'Bitcoin', sector:'Blue Chip', price:68340, change24h:1.25, marketCap:'$1.35T', volume24h:'$31.1B', type:'major' },
  { symbol:'ETH', name:'Ethereum', sector:'Blue Chip', price:3512, change24h:1.65, marketCap:'$422B', volume24h:'$19.4B', type:'major' },
  { symbol:'DOGE', name:'Dogecoin', sector:'Meme', price:0.128, change24h:2.45, marketCap:'$18.8B', volume24h:'$890M', type:'meme' },
  { symbol:'WIF', name:'dogwifhat', sector:'Meme', price:2.12, change24h:5.6, marketCap:'$2.1B', volume24h:'$450M', type:'meme' },
  { symbol:'SEI', name:'Sei Network', sector:'Emerging', price:0.48, change24h:24.5, marketCap:'$1.7B', volume24h:'$680M', type:'emerging' },
  { symbol:'JUP', name:'Jupiter', sector:'Solana Ecosystem', price:0.91, change24h:16.3, marketCap:'$1.2B', volume24h:'$370M', type:'emerging' },
  { symbol:'XRP', name:'XRP', sector:'Payments', price:0.62, change24h:1.1, marketCap:'$34B', volume24h:'$1.4B', type:'large-alt' },
  { symbol:'ADA', name:'Cardano', sector:'Layer 1', price:0.45, change24h:0.8, marketCap:'$16B', volume24h:'$420M', type:'large-alt' },
  { symbol:'AVAX', name:'Avalanche', sector:'Layer 1', price:36.2, change24h:2.9, marketCap:'$13B', volume24h:'$510M', type:'large-alt' },
  { symbol:'SHIB', name:'Shiba Inu', sector:'Meme', price:0.0000241, change24h:-2.1, marketCap:'$14B', volume24h:'$640M', type:'meme' },
  { symbol:'LINK', name:'Chainlink', sector:'Oracle', price:14.82, change24h:1.65, marketCap:'$9.2B', volume24h:'$618M', type:'alt' },
  { symbol:'DOT', name:'Polkadot', sector:'Layer 0', price:6.9, change24h:1.2, marketCap:'$9.5B', volume24h:'$280M', type:'large-alt' },
  { symbol:'UNI', name:'Uniswap', sector:'DeFi', price:9.8, change24h:3.4, marketCap:'$5.9B', volume24h:'$190M', type:'alt' },
  { symbol:'AAVE', name:'Aave', sector:'DeFi', price:96.5, change24h:4.1, marketCap:'$1.4B', volume24h:'$160M', type:'alt' },
  { symbol:'ATOM', name:'Cosmos', sector:'Infrastructure', price:7.4, change24h:0.5, marketCap:'$2.9B', volume24h:'$140M', type:'alt' },
  { symbol:'NEAR', name:'NEAR Protocol', sector:'Layer 1', price:5.1, change24h:3.0, marketCap:'$5.6B', volume24h:'$230M', type:'large-alt' },
  { symbol:'ARB', name:'Arbitrum', sector:'Layer 2', price:0.78, change24h:2.2, marketCap:'$3.1B', volume24h:'$210M', type:'alt' },
  { symbol:'OP', name:'Optimism', sector:'Layer 2', price:1.55, change24h:2.6, marketCap:'$2.4B', volume24h:'$180M', type:'alt' },
  { symbol:'RENDER', name:'Render', sector:'AI', price:7.2, change24h:5.5, marketCap:'$3.7B', volume24h:'$260M', type:'alt' },
  { symbol:'LTC', name:'Litecoin', sector:'Payments', price:72.4, change24h:0.9, marketCap:'$5.4B', volume24h:'$340M', type:'large-alt' },
  { symbol:'BCH', name:'Bitcoin Cash', sector:'Payments', price:402, change24h:1.4, marketCap:'$7.9B', volume24h:'$300M', type:'large-alt' },
  { symbol:'XLM', name:'Stellar', sector:'Payments', price:0.11, change24h:0.6, marketCap:'$3.2B', volume24h:'$120M', type:'alt' },
  { symbol:'INJ', name:'Injective', sector:'DeFi', price:24.6, change24h:4.8, marketCap:'$2.4B', volume24h:'$170M', type:'alt' },
  { symbol:'APT', name:'Aptos', sector:'Layer 1', price:8.3, change24h:2.1, marketCap:'$4.3B', volume24h:'$200M', type:'large-alt' }
];

export const macro = {
  marketTemperature: 72,
  fearGreed: 68,
  stablecoinInflow24h: 1230000000,
  smartMoneyFlow24h: 245700000,
  btcDominance: 54.3,
  totalOpportunities: 158,
  avgConfidence: 78,
  winRate24h: 68,
  assets: [
    { label:'Gold', value:2387, change:1.25, bias:'supportive' },
    { label:'VIX', value:13.24, change:-2.35, bias:'risk-on' },
    { label:'DXY', value:104.32, change:-0.45, bias:'supportive' },
    { label:'NASDAQ', value:18547, change:1.08, bias:'risk-on' }
  ]
};

export const narratives = [
  { narrative:'Memes', strength:92, momentum:-8 },
  { narrative:'AI', strength:80, momentum:25 },
  { narrative:'DeFi', strength:65, momentum:12 },
  { narrative:'Gaming', strength:55, momentum:30 },
  { narrative:'RWA', strength:45, momentum:18 },
  { narrative:'Solana Ecosystem', strength:88, momentum:22 }
];
