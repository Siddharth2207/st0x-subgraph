import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts"
import { Mint, Burn, CLPool } from "../generated/V3Pool1/CLPool"
import { LPTokenAttribution, Pool } from "../generated/schema"

function getOrCreatePool(poolAddress: Address): Pool {
  let id = poolAddress.toHexString()
  let pool = Pool.load(id)
  
  if (pool == null) {
    pool = new Pool(id)
    
    // Fetch token0 and token1 from the contract
    let contract = CLPool.bind(poolAddress)
    let token0Result = contract.try_token0()
    let token1Result = contract.try_token1()
    
    if (!token0Result.reverted) {
      pool.token0 = token0Result.value
    } else {
      pool.token0 = Bytes.empty()
    }
    
    if (!token1Result.reverted) {
      pool.token1 = token1Result.value
    } else {
      pool.token1 = Bytes.empty()
    }
    
    pool.isV3 = true
    pool.save()
  }
  
  return pool
}

function getOrCreateAttribution(pool: Bytes, user: Bytes, token: Bytes): LPTokenAttribution {
  let id = pool.toHexString() + "-" + user.toHexString() + "-" + token.toHexString()
  let attribution = LPTokenAttribution.load(id)
  
  if (attribution == null) {
    attribution = new LPTokenAttribution(id)
    attribution.pool = pool
    attribution.user = user
    attribution.token = token
    attribution.depositedBalance = BigInt.zero()
  }
  
  return attribution
}

export function handleV3Mint(event: Mint): void {
  let poolAddress = event.address
  let pool = getOrCreatePool(poolAddress)
  
  // owner is the LP position owner
  let owner = event.params.owner
  let amount0 = event.params.amount0
  let amount1 = event.params.amount1
  
  // Update attribution for token0
  let attribution0 = getOrCreateAttribution(poolAddress, owner, pool.token0)
  attribution0.depositedBalance = attribution0.depositedBalance.plus(amount0)
  attribution0.save()
  
  // Update attribution for token1
  let attribution1 = getOrCreateAttribution(poolAddress, owner, pool.token1)
  attribution1.depositedBalance = attribution1.depositedBalance.plus(amount1)
  attribution1.save()
}

export function handleV3Burn(event: Burn): void {
  let poolAddress = event.address
  let pool = getOrCreatePool(poolAddress)
  
  // owner is the LP position owner
  let owner = event.params.owner
  let amount0 = event.params.amount0
  let amount1 = event.params.amount1
  
  // Update attribution for token0 (subtract)
  let attribution0 = getOrCreateAttribution(poolAddress, owner, pool.token0)
  attribution0.depositedBalance = attribution0.depositedBalance.minus(amount0)
  attribution0.save()
  
  // Update attribution for token1 (subtract)
  let attribution1 = getOrCreateAttribution(poolAddress, owner, pool.token1)
  attribution1.depositedBalance = attribution1.depositedBalance.minus(amount1)
  attribution1.save()
}
