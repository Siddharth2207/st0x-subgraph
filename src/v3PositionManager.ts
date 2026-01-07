import { BigInt, Bytes, Address, log } from "@graphprotocol/graph-ts"
import {
  IncreaseLiquidity,
  DecreaseLiquidity,
  Transfer
} from "../generated/NonfungiblePositionManager/NonfungiblePositionManager"
import { NonfungiblePositionManager } from "../generated/NonfungiblePositionManager/NonfungiblePositionManager"
import { CLFactory } from "../generated/NonfungiblePositionManager/CLFactory"
import { LPTokenAttribution, V3Position, V2Pool } from "../generated/schema"

// Zero address constant
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// V3 Factory address for looking up pools
const V3_FACTORY_ADDRESS = "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a"

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

// Get or create V3Position entity and populate pool info from contract call
function getOrCreatePosition(
  tokenId: BigInt,
  nftAddress: Address
): V3Position | null {
  let id = tokenId.toString()
  let position = V3Position.load(id)
  
  if (position == null) {
    // Need to call positions() to get pool info
    let nftContract = NonfungiblePositionManager.bind(nftAddress)
    let positionResult = nftContract.try_positions(tokenId)
    
    if (positionResult.reverted) {
      log.warning("Failed to get position info for tokenId: {}", [id])
      return null
    }
    
    let positionData = positionResult.value
    let token0 = positionData.getToken0()
    let token1 = positionData.getToken1()
    let tickSpacing = positionData.getTickSpacing()
    
    // Look up the pool address from the factory
    let factory = CLFactory.bind(Address.fromString(V3_FACTORY_ADDRESS))
    let poolResult = factory.try_getPool(token0, token1, tickSpacing)
    
    if (poolResult.reverted) {
      log.warning("Failed to get pool for tokens: {} - {} with tickSpacing: {}", [
        token0.toHexString(),
        token1.toHexString(),
        tickSpacing.toString()
      ])
      return null
    }
    
    position = new V3Position(id)
    position.owner = Bytes.fromHexString(ZERO_ADDRESS)
    position.pool = poolResult.value
    position.token0 = token0
    position.token1 = token1
    position.save()
    
    // Also ensure the pool is tracked in V2Pool entity (we reuse this for both V2 and V3)
    let poolEntity = V2Pool.load(poolResult.value.toHexString())
    if (poolEntity == null) {
      poolEntity = new V2Pool(poolResult.value.toHexString())
      poolEntity.token0 = token0
      poolEntity.token1 = token1
      poolEntity.save()
    }
  }
  
  return position
}

export function handleV3PositionTransfer(event: Transfer): void {
  let tokenId = event.params.tokenId
  let from = event.params.from
  let to = event.params.to
  
  // Skip if burning (to zero address)
  if (to.toHexString() == ZERO_ADDRESS) {
    return
  }
  
  let position = getOrCreatePosition(tokenId, event.address)
  if (position == null) {
    return
  }
  
  // Update position owner
  position.owner = to
  position.save()
}

export function handleIncreaseLiquidity(event: IncreaseLiquidity): void {
  let tokenId = event.params.tokenId
  let amount0 = event.params.amount0
  let amount1 = event.params.amount1
  
  let position = getOrCreatePosition(tokenId, event.address)
  if (position == null) {
    log.warning("Position not found for tokenId: {}", [tokenId.toString()])
    return
  }
  
  // Get the current owner of the position
  let owner = position.owner
  
  // If owner is zero (shouldn't happen normally), try to get from contract
  if (owner.toHexString() == ZERO_ADDRESS) {
    let nftContract = NonfungiblePositionManager.bind(event.address)
    let ownerResult = nftContract.try_ownerOf(tokenId)
    if (!ownerResult.reverted) {
      owner = ownerResult.value
      position.owner = owner
      position.save()
    } else {
      log.warning("Could not determine owner for tokenId: {}", [tokenId.toString()])
      return
    }
  }
  
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
    log.warning("Position not found for tokenId: {}", [tokenId.toString()])
    return
  }
  
  // Get the current owner of the position
  let owner = position.owner
  
  // If owner is zero (shouldn't happen normally), try to get from contract
  if (owner.toHexString() == ZERO_ADDRESS) {
    let nftContract = NonfungiblePositionManager.bind(event.address)
    let ownerResult = nftContract.try_ownerOf(tokenId)
    if (!ownerResult.reverted) {
      owner = ownerResult.value
      position.owner = owner
      position.save()
    } else {
      log.warning("Could not determine owner for tokenId: {}", [tokenId.toString()])
      return
    }
  }
  
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

