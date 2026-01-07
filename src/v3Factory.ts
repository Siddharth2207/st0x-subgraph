import { Bytes } from "@graphprotocol/graph-ts"
import { PoolCreated } from "../generated/V3Factory/CLFactory"
import { V2Pool, V3PoolKey } from "../generated/schema"
import { isWhitelisted } from "./constants"

function poolKeyId(token0: Bytes, token1: Bytes, tickSpacing: i32): string {
  return token0.toHexString() + "-" + token1.toHexString() + "-" + tickSpacing.toString()
}

export function handleV3PoolCreated(event: PoolCreated): void {
  const poolId = event.params.pool.toHexString()
  if (!isWhitelisted(poolId)) return

  // cache key -> pool
  const key = poolKeyId(event.params.token0, event.params.token1, event.params.tickSpacing)
  let k = V3PoolKey.load(key)
  if (k == null) {
    k = new V3PoolKey(key)
    k.pool = event.params.pool
    k.token0 = event.params.token0
    k.token1 = event.params.token1
    k.tickSpacing = event.params.tickSpacing
    k.save()
  }

  // store pool tokens
  let pool = V2Pool.load(poolId)
  if (pool == null) {
    pool = new V2Pool(poolId)
    pool.token0 = event.params.token0
    pool.token1 = event.params.token1
    pool.createdAtBlock = event.block.number
    pool.save()
  }
}
