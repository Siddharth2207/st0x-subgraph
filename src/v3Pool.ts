import {
  IncreaseLiquidity,
  DecreaseLiquidity,
  Transfer,
  NonfungiblePositionManager,
} from "../generated/V3PositionManager/NonfungiblePositionManager";
import { V3Position, LPTokenAttribution } from "../generated/schema";

import { ethereum, BigInt, Bytes, Address } from "@graphprotocol/graph-ts";

const NFT_POSITION_MANAGER = Address.fromString(
  "0x827922686190790b37229fd06084350E74485b72"
);

// topic0 for IncreaseLiquidity(uint256,uint128,uint256,uint256)
const INCREASE_LIQUIDITY_TOPIC = Bytes.fromHexString(
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4"
);

// topic0 for DecreaseLiquidity(uint256,uint128,uint256,uint256)
const DECREASE_LIQUIDITY_TOPIC = Bytes.fromHexString(
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f"
);

/**
 * Extract tokenId from NPM IncreaseLiquidity / DecreaseLiquidity log
 * in the SAME transaction as the CLPool Mint/Burn.
 */
export function findTokenIdFromReceipt(
  receipt: ethereum.TransactionReceipt
): BigInt | null {
  let logs = receipt.logs;

  for (let i = 0; i < logs.length; i++) {
    let log = logs[i];

    if (!log.address.equals(NFT_POSITION_MANAGER)) continue;
    if (log.topics.length < 2) continue;

    let topic0 = log.topics[0];
    if (
      !topic0.equals(INCREASE_LIQUIDITY_TOPIC) &&
      !topic0.equals(DECREASE_LIQUIDITY_TOPIC)
    ) {
      continue;
    }

    // tokenId is indexed and stored in topics[1]
    return BigInt.fromByteArray(
      Bytes.fromUint8Array(log.topics[1].reverse())
    );
  }

  return null;
}


const NPM = Address.fromString("0x827922686190790b37229fd06084350E74485b72");
const ZERO = Address.fromString("0x0000000000000000000000000000000000000000");

function isAddressBytes(b: Bytes): bool {
  return b.length == 20;
}

function clampNonNegative(x: BigInt): BigInt {
  return x.lt(BigInt.zero()) ? BigInt.zero() : x;
}

function getOrCreateAttribution(pool: Bytes, user: Bytes, token: Bytes): LPTokenAttribution {
  let id = pool.toHexString() + "-" + user.toHexString() + "-" + token.toHexString();
  let a = LPTokenAttribution.load(id);

  if (a == null) {
    a = new LPTokenAttribution(id);
    a.pool = pool;
    a.user = user;
    a.token = token;
    a.depositedBalance = BigInt.zero();
  }
  return a;
}

/**
 * Loads or initializes a V3Position by tokenId.
 * IMPORTANT: we only call positions(tokenId) when we first see the tokenId.
 */
function getOrInitPosition(tokenId: BigInt): V3Position | null {
  let id = tokenId.toString();
  let pos = V3Position.load(id);
  if (pos != null) return pos;

  let mgr = NonfungiblePositionManager.bind(NPM);
  let res = mgr.try_positions(tokenId);
  if (res.reverted) return null;

  // NPM.positions(tokenId) gives token0/token1/liquidity (but NOT pool address)
  let token0 = res.value.getToken0();
  let token1 = res.value.getToken1();
  let liquidity = res.value.getLiquidity();

  pos = new V3Position(id);
  pos.owner = ZERO as Bytes;
  pos.pool = Bytes.empty(); // set later via setPoolForPosition()
  pos.token0 = token0;
  pos.token1 = token1;
  pos.liquidity = liquidity;
  pos.deposited0 = BigInt.zero();
  pos.deposited1 = BigInt.zero();
  pos.save();

  return pos;
}

/**
 * Call this from your CLPool (pool-side) Mint/Burn handlers once you’ve
 * extracted tokenId from the receipt.
 *
 * This is the correct place to bind tokenId -> pool without “indexing pools from NPM”.
 */
export function setPoolForPosition(tokenId: BigInt, poolAddr: Address): void {
  let pos = V3Position.load(tokenId.toString());
  if (pos == null) {
    // if we haven't seen this tokenId yet via NPM events, initialize it once
    pos = getOrInitPosition(tokenId);
    if (pos == null) return;
  }

  // only set if unset OR changed (shouldn’t change in practice, but safe)
  let poolBytes = poolAddr as Bytes;
  if (pos.pool.length == 0 || pos.pool.notEqual(poolBytes)) {
    pos.pool = poolBytes;
    pos.save();
  }
}

/**
 * Helper: apply a delta to LPTokenAttribution for a position, if pool is known.
 */
function applyAttributionDelta(pos: V3Position, user: Bytes, token: Bytes, delta: BigInt): void {
  if (pos.pool.length == 0) return; // can't attribute without pool binding
  let a = getOrCreateAttribution(pos.pool, user, token);
  a.depositedBalance = a.depositedBalance.plus(delta);
  a.depositedBalance = clampNonNegative(a.depositedBalance);
  a.save();
}

/**
 * When liquidity increases: treat amount0/amount1 as deposit added to the POSITION.
 * Also add to user attribution for that pool+token (only if pool known).
 */
export function handleIncreaseLiquidity(event: IncreaseLiquidity): void {
  let tokenId = event.params.tokenId;

  let pos = getOrInitPosition(tokenId);
  if (pos == null) return;

  // Prefer tracked owner (from Transfer). Else fallback to tx.from
  let ownerAddr = event.transaction.from;
  if (isAddressBytes(pos.owner)) {
    ownerAddr = Address.fromBytes(pos.owner);
  }

  let amount0 = event.params.amount0;
  let amount1 = event.params.amount1;
  let liqDelta = event.params.liquidity;

  // update position liquidity + deposits
  pos.liquidity = pos.liquidity.plus(liqDelta);
  pos.deposited0 = pos.deposited0.plus(amount0);
  pos.deposited1 = pos.deposited1.plus(amount1);
  pos.owner = ownerAddr as Bytes;
  pos.save();

  // aggregate to LPTokenAttribution (only works once pool is bound)
  applyAttributionDelta(pos, ownerAddr as Bytes, pos.token0, amount0);
  applyAttributionDelta(pos, ownerAddr as Bytes, pos.token1, amount1);
}

/**
 * When liquidity decreases: withdraw is PROPORTIONAL:
 * deposited -= deposited * (liquidityRemoved / positionLiquidityBefore)
 *
 * (This matches your new requirement: deduct based on LP share removed.)
 */
export function handleDecreaseLiquidity(event: DecreaseLiquidity): void {
  let tokenId = event.params.tokenId;

  let pos = V3Position.load(tokenId.toString());
  if (pos == null) {
    pos = getOrInitPosition(tokenId);
    if (pos == null) return;
  }

  let ownerAddr = event.transaction.from;
  if (isAddressBytes(pos.owner)) {
    ownerAddr = Address.fromBytes(pos.owner);
  }

  let liqRemoved = event.params.liquidity;
  let liqBefore = pos.liquidity;

  if (liqBefore.le(BigInt.zero()) || liqRemoved.le(BigInt.zero())) return;

  // ratio = liqRemoved / liqBefore with 1e18 precision
  let PRECISION = BigInt.fromI32(10).pow(18);
  let ratio = liqRemoved.times(PRECISION).div(liqBefore);

  // proportional deductions from "net deposited"
  let d0 = pos.deposited0.times(ratio).div(PRECISION);
  let d1 = pos.deposited1.times(ratio).div(PRECISION);

  pos.deposited0 = clampNonNegative(pos.deposited0.minus(d0));
  pos.deposited1 = clampNonNegative(pos.deposited1.minus(d1));

  // update liquidity
  pos.liquidity = clampNonNegative(pos.liquidity.minus(liqRemoved));

  pos.owner = ownerAddr as Bytes;
  pos.save();

  // aggregate to LPTokenAttribution as negative deltas
  applyAttributionDelta(pos, ownerAddr as Bytes, pos.token0, d0.neg());
  applyAttributionDelta(pos, ownerAddr as Bytes, pos.token1, d1.neg());

  // Optional: remove fully burned positions (only if you're sure you won't see it again)
  // if (pos.liquidity.isZero()) store.remove("V3Position", tokenId.toString());
}

/**
 * NFT transfer moves the WHOLE position "as is" to new owner:
 * - subtract current position deposits from old owner attribution
 * - add to new owner attribution
 * - update position.owner
 */
export function handlePositionTransfer(event: Transfer): void {
  let tokenId = event.params.tokenId;
  let from = event.params.from;
  let to = event.params.to;

  let pos = V3Position.load(tokenId.toString());
  if (pos == null) {
    pos = getOrInitPosition(tokenId);
    if (pos == null) return;
  }

  // Mint transfer (0x0 -> to): just set owner
  if (from.equals(ZERO)) {
    pos.owner = to as Bytes;
    pos.save();
    return;
  }

  // Burn transfer (from -> 0x0): set owner to ZERO (or remove)
  if (to.equals(ZERO)) {
    pos.owner = to as Bytes;
    pos.save();
    return;
  }

  // Move attribution only if pool is known
  if (pos.pool.length > 0) {
    // subtract from old owner
    applyAttributionDelta(pos, from as Bytes, pos.token0, pos.deposited0.neg());
    applyAttributionDelta(pos, from as Bytes, pos.token1, pos.deposited1.neg());

    // add to new owner
    applyAttributionDelta(pos, to as Bytes, pos.token0, pos.deposited0);
    applyAttributionDelta(pos, to as Bytes, pos.token1, pos.deposited1);
  }

  pos.owner = to as Bytes;
  pos.save();
}
