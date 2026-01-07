import { PoolCreated } from "../generated/V2Factory/PoolFactory"
import { V2Pool } from "../generated/schema"
import { V2PoolTemplate } from "../generated/templates"
import { isWhitelisted } from "./constants"

export function handleV2PoolCreated(event: PoolCreated): void {
  const poolId = event.params.pool.toHexString()
  if (!isWhitelisted(poolId)) return

  let pool = V2Pool.load(poolId)
  if (pool == null) {
    pool = new V2Pool(poolId)
    pool.token0 = event.params.token0
    pool.token1 = event.params.token1
    pool.createdAtBlock = event.block.number
    pool.save()

    V2PoolTemplate.create(event.params.pool)
  }
}
