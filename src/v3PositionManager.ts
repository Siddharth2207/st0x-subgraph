import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts"
import {
  IncreaseLiquidity,
  DecreaseLiquidity
} from "../generated/NonfungiblePositionManager/NonfungiblePositionManager"
import { NonfungiblePositionManager } from "../generated/NonfungiblePositionManager/NonfungiblePositionManager"
import { LPTokenAttribution, V3Position, V3PoolKey } from "../generated/schema"

// Zero address constant
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// Helper to generate V3PoolKey id (must match v3Factory.ts)
function poolKeyId(token0: Bytes, token1: Bytes, tickSpacing: i32): string {
  return token0.toHexString() + "-" + token1.toHexString() + "-" + tickSpacing.toString()
}

function getOrCreateAttribution(
  pool: Bytes,
  user: Bytes,
  token: Bytes
): LPTokenAttribution {
  let id = pool.toHexString() + "-" + user.toHexString() + "-" + token.toHexString()
  let attribution = LPTokenAttribution.load(id)
  
  if (attribution == null) {
    attribution = new LPTokenAttribution(id)
    attribution.pool = pool
    attribution.user = user
    attribution.token = token
    attribution.depositedBalance = BigInt.fromI32(0)
  }
  
  return attribution
}

// Get or create V3Position entity
// Uses V3PoolKey lookup (from graph store) instead of getPool() eth_call
// Returns null if position is not in a whitelisted pool
function getOrCreatePosition(
  tokenId: BigInt,
  nftAddress: Address,
  blockNumber: BigInt
): V3Position | null {
  let id = tokenId.toString()
  let position = V3Position.load(id)
  
  // If position exists, check if it's a rejected (non-whitelisted) position
  if (position != null) {
    if (position.pool.toHexString() == ZERO_ADDRESS) {
      return null  // Cached as rejected - no eth_calls needed
    }
    return position
  }
  
  // New position - need 1 eth_call to get token info
  let nftContract = NonfungiblePositionManager.bind(nftAddress)
  let positionResult = nftContract.try_positions(tokenId)
  
  if (positionResult.reverted) {
    return null  // Position doesn't exist or was burned
  }
  
  let positionData = positionResult.value
  let token0 = positionData.getToken0()
  let token1 = positionData.getToken1()
  let tickSpacing = positionData.getTickSpacing()
  
  // Look up pool from V3PoolKey (graph store) instead of eth_call
  // V3PoolKey only exists for whitelisted pools (created in handleV3PoolCreated)
  let key = poolKeyId(token0, token1, tickSpacing)
  let poolKey = V3PoolKey.load(key)
  
  if (poolKey == null) {
    // No V3PoolKey means pool is not whitelisted - cache as rejected
    position = new V3Position(id)
    position.owner = Bytes.fromHexString(ZERO_ADDRESS)
    position.pool = Bytes.fromHexString(ZERO_ADDRESS)
    position.token0 = Bytes.fromHexString(ZERO_ADDRESS)
    position.token1 = Bytes.fromHexString(ZERO_ADDRESS)
    position.save()
    return null
  }
  
  // Found whitelisted pool - create full position
  position = new V3Position(id)
  position.owner = Bytes.fromHexString(ZERO_ADDRESS)
  position.pool = poolKey.pool
  position.token0 = token0
  position.token1 = token1
  position.save()
  
  return position
}

export function handleIncreaseLiquidity(event: IncreaseLiquidity): void {
  let tokenId = event.params.tokenId
  let amount0 = event.params.amount0
  let amount1 = event.params.amount1
  
  let position = getOrCreatePosition(tokenId, event.address, event.block.number)
  if (position == null) {
    return  // Not in a whitelisted pool
  }
  
  // Get current owner from contract (always fetch, since we don't track transfers)
  let nftContract = NonfungiblePositionManager.bind(event.address)
  let ownerResult = nftContract.try_ownerOf(tokenId)
  if (ownerResult.reverted) {
    return
  }
  let owner = ownerResult.value
  
  // Update attribution for token0
  let attribution0 = getOrCreateAttribution(
    position.pool,
    owner,
    position.token0
  )
  attribution0.depositedBalance = attribution0.depositedBalance.plus(amount0)
  attribution0.save()

  // Update attribution for token1
  let attribution1 = getOrCreateAttribution(
    position.pool,
    owner,
    position.token1
  )
  attribution1.depositedBalance = attribution1.depositedBalance.plus(amount1)
  attribution1.save()
}

export function handleDecreaseLiquidity(event: DecreaseLiquidity): void {
  let tokenId = event.params.tokenId
  let amount0 = event.params.amount0
  let amount1 = event.params.amount1
  
  let position = V3Position.load(tokenId.toString())
  if (position == null) {
    return  // Position not tracked
  }
  
  // Skip rejected (non-whitelisted) positions
  if (position.pool.toHexString() == ZERO_ADDRESS) {
    return
  }
  
  // Get current owner from contract (always fetch, since we don't track transfers)
  let nftContract = NonfungiblePositionManager.bind(event.address)
  let ownerResult = nftContract.try_ownerOf(tokenId)
  if (ownerResult.reverted) {
    return
  }
  let owner = ownerResult.value
  
  // Update attribution for token0 (subtract)
  let attribution0 = getOrCreateAttribution(
    position.pool,
    owner,
    position.token0
  )
  attribution0.depositedBalance = attribution0.depositedBalance.minus(amount0)
  attribution0.save()

  // Update attribution for token1 (subtract)
  let attribution1 = getOrCreateAttribution(
    position.pool,
    owner,
    position.token1
  )
  attribution1.depositedBalance = attribution1.depositedBalance.minus(amount1)
  attribution1.save()
}

