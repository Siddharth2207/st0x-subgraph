import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import { Mint, Burn } from "../generated/templates/V2PoolTemplate/V2Pool"
import { LPTokenAttribution, V2Pool } from "../generated/schema"

const INDEX_FROM_BLOCK = BigInt.fromI32(37553000)

function attributionId(pool: Bytes, user: Bytes, token: Bytes): string {
  return pool.toHexString() + "-" + user.toHexString() + "-" + token.toHexString()
}

function getOrCreateAttribution(pool: Bytes, user: Bytes, token: Bytes): LPTokenAttribution {
  const id = attributionId(pool, user, token)
  let a = LPTokenAttribution.load(id)
  if (a == null) {
    a = new LPTokenAttribution(id)
    a.pool = pool
    a.user = user
    a.token = token
    a.depositedBalance = BigInt.zero()
  }
  return a
}

export function handleV2Mint(event: Mint): void {
  if (event.block.number.lt(INDEX_FROM_BLOCK)) return

  const poolId = event.address.toHexString()
  const pool = V2Pool.load(poolId)
  if (pool == null) return
  if (event.block.number.lt(pool.createdAtBlock)) return

  // Fast depositor heuristic:
  // Best you can do cheaply: tx.origin / tx.from
  const depositor = event.transaction.from

  const a0 = getOrCreateAttribution(event.address, depositor, pool.token0)
  a0.depositedBalance = a0.depositedBalance.plus(event.params.amount0)
  a0.save()

  const a1 = getOrCreateAttribution(event.address, depositor, pool.token1)
  a1.depositedBalance = a1.depositedBalance.plus(event.params.amount1)
  a1.save()
}

export function handleV2Burn(event: Burn): void {
  if (event.block.number.lt(INDEX_FROM_BLOCK)) return

  const poolId = event.address.toHexString()
  const pool = V2Pool.load(poolId)
  if (pool == null) return
  if (event.block.number.lt(pool.createdAtBlock)) return

  // Burn event already gives you the withdrawer
  const withdrawer = event.params.to

  const a0 = getOrCreateAttribution(event.address, withdrawer, pool.token0)
  a0.depositedBalance = a0.depositedBalance.minus(event.params.amount0)
  a0.save()

  const a1 = getOrCreateAttribution(event.address, withdrawer, pool.token1)
  a1.depositedBalance = a1.depositedBalance.minus(event.params.amount1)
  a1.save()
}
