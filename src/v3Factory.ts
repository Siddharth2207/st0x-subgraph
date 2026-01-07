import { PoolCreated } from "../generated/V3Factory/CLFactory"
import { V2Pool } from "../generated/schema"

// We reuse V2Pool entity to store V3 pool info (token0, token1)
// The id is the pool address, which we can look up when processing position events
export function handleV3PoolCreated(event: PoolCreated): void {
  let pool = new V2Pool(event.params.pool.toHexString())
  pool.token0 = event.params.token0
  pool.token1 = event.params.token1
  pool.save()
}

