// Whitelist of pool addresses to index (lowercase)
const WHITELISTED_POOLS: string[] = [
  "0x40a8e39aba67debedab94f76d21114ab39909c5a",
  "0xa0d736dd7386230de3aa2e6b4f60d36a5ded2291",
  "0xff948480d67f83f6f0d2b87217ffc662f19f4b47",
  "0xb804fa2e3631465455594538067001e7a0f83d37",
  "0x419ac22a42e866dd92f36d7aca3f126d2edd2567"
]

export function isWhitelisted(addrHex: string): bool {
  let addr = addrHex.toLowerCase()
  for (let i = 0; i < WHITELISTED_POOLS.length; i++) {
    if (WHITELISTED_POOLS[i] == addr) {
      return true
    }
  }
  return false
}
