// Shared live-price table for copied on-chain positions (written by onchain.js, read by engine.js).
// Key: "<zerion chain id>:<token address>" -> { px, at }
export const onchainPx = new Map();
export const onchainPxAgeMs = (key) => { const p = onchainPx.get(key); return p ? Date.now() - p.at : Infinity; };
