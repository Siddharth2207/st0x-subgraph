import { PoolCreated } from "../generated/V2Factory/PoolFactory"
import { V2Pool } from "../generated/schema"
import { V2PoolTemplate } from "../generated/templates"

export function handleV2PoolCreated(event: PoolCreated): void {
  let pool = new V2Pool(event.params.pool.toHexString())
  pool.token0 = event.params.token0
  pool.token1 = event.params.token1
  pool.save()

  // Create a new data source to track Mint/Burn events on this pool
  V2PoolTemplate.create(event.params.pool)
}

