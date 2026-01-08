import { BigInt, Bytes, Address, ethereum } from "@graphprotocol/graph-ts"
import { Mint, Burn, Transfer, Pool as PoolContract } from "../generated/V2Pool1/Pool"
import { LPTokenAttribution, Pool, V2TxRecipient, UserPoolLP } from "../generated/schema"

const ZERO = Address.fromString("0x0000000000000000000000000000000000000000")

function emptyBytes(): Bytes {
  return Bytes.fromHexString("0x") as Bytes
}

function getOrCreatePool(poolAddress: Address): Pool {
  let id = poolAddress.toHexString()
  let pool = Pool.load(id)

  if (pool == null) {
    pool = new Pool(id)

    let contract = PoolContract.bind(poolAddress)
    let token0Result = contract.try_token0()
    let token1Result = contract.try_token1()

    pool.token0 = token0Result.reverted ? emptyBytes() : token0Result.value
    pool.token1 = token1Result.reverted ? emptyBytes() : token1Result.value

    pool.isV3 = false
    pool.save()
  }

  return pool
}

function getOrCreateAttribution(pool: Bytes, user: Bytes, token: Bytes): LPTokenAttribution {
  let id = pool.toHexString() + "-" + user.toHexString() + "-" + token.toHexString()
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

function getOrCreateUserPoolLP(pool: Bytes, user: Bytes): UserPoolLP {
  let id = pool.toHexString() + "-" + user.toHexString()
  let lp = UserPoolLP.load(id)

  if (lp == null) {
    lp = new UserPoolLP(id)
    lp.pool = pool
    lp.user = user
    lp.lpBalance = BigInt.zero()
  }
  return lp
}

function scratchId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.address.toHexString()
}

function getScratch(event: ethereum.Event): V2TxRecipient {
  let id = scratchId(event)
  let s = V2TxRecipient.load(id)

  if (s == null) {
    s = new V2TxRecipient(id)
    s.pool = event.address
    s.mint0 = BigInt.zero()
    s.mint1 = BigInt.zero()
    s.mintLpAmount = BigInt.zero()
    s.mintReady = false
    s.mintedTo = ZERO as Bytes
    s.mintedToReady = false
    s.lastLpFrom = ZERO as Bytes
    s.lastLpAmount = BigInt.zero()
    s.save()
  }

  return s
}

function tryFinalizeMint(poolAddr: Address, pool: Pool, s: V2TxRecipient): void {
  if (!s.mintReady || !s.mintedToReady) return

  // mintedTo must not be ZERO
  if (Address.fromBytes(s.mintedTo) == ZERO) return

  let user = s.mintedTo
  let amount0 = s.mint0
  let amount1 = s.mint1
  let lpAmount = s.mintLpAmount

  // Track LP balance for proportional withdrawal
  if (lpAmount.gt(BigInt.zero())) {
    let userLp = getOrCreateUserPoolLP(poolAddr as Bytes, user)
    userLp.lpBalance = userLp.lpBalance.plus(lpAmount)
    userLp.save()
  }

  if (pool.token0.length > 0 && amount0.gt(BigInt.zero())) {
    let a0 = getOrCreateAttribution(poolAddr as Bytes, user, pool.token0)
    a0.depositedBalance = a0.depositedBalance.plus(amount0)
    a0.save()
  }

  if (pool.token1.length > 0 && amount1.gt(BigInt.zero())) {
    let a1 = getOrCreateAttribution(poolAddr as Bytes, user, pool.token1)
    a1.depositedBalance = a1.depositedBalance.plus(amount1)
    a1.save()
  }

  // clear mint scratch safely
  s.mint0 = BigInt.zero()
  s.mint1 = BigInt.zero()
  s.mintLpAmount = BigInt.zero()
  s.mintReady = false
  s.mintedTo = ZERO as Bytes
  s.mintedToReady = false
  s.save()
}

export function handleV2Transfer(event: Transfer): void {
  let poolAddr = event.address
  let pool = getOrCreatePool(poolAddr)
  let s = getScratch(event)

  let from = event.params.from
  let to = event.params.to
  let lpAmount = event.params.value

  // LP mint: Transfer(0x0, recipient, liquidity)
  if (from == ZERO) {
    s.mintedTo = to as Bytes
    s.mintLpAmount = lpAmount
    s.mintedToReady = true
    s.save()
    tryFinalizeMint(poolAddr, pool, s)
    return
  }

  // LP moved into pair before burn: Transfer(user, pair, liquidity)
  if (to == poolAddr) {
    s.lastLpFrom = from as Bytes
    s.lastLpAmount = lpAmount
    s.save()
    return
  }

  // ignore secondary transfers
}

export function handleV2Mint(event: Mint): void {
  let poolAddr = event.address
  let pool = getOrCreatePool(poolAddr)
  let s = getScratch(event)

  s.mint0 = event.params.amount0
  s.mint1 = event.params.amount1
  s.mintReady = true
  s.save()

  tryFinalizeMint(poolAddr, pool, s)
}

export function handleV2Burn(event: Burn): void {
  let poolAddr = event.address
  let pool = getOrCreatePool(poolAddr)
  let s = getScratch(event)

  // prefer LP provider captured from Transfer(user -> pair)
  let userBytes = s.lastLpFrom
  if (Address.fromBytes(userBytes) == ZERO) {
    userBytes = event.transaction.from as Bytes
  }

  let lpRemoved = s.lastLpAmount
  
  // Get user's LP balance for proportional calculation
  let userLp = getOrCreateUserPoolLP(poolAddr as Bytes, userBytes)
  let totalLp = userLp.lpBalance
  
  // Calculate proportion: lpRemoved / totalLp
  // Use high precision (18 decimals) for ratio calculation
  let PRECISION = BigInt.fromI32(10).pow(18)
  
  if (totalLp.gt(BigInt.zero()) && lpRemoved.gt(BigInt.zero())) {
    // ratio = lpRemoved * PRECISION / totalLp
    let ratio = lpRemoved.times(PRECISION).div(totalLp)
    
    // Deduct LP balance
    userLp.lpBalance = userLp.lpBalance.minus(lpRemoved)
    if (userLp.lpBalance.lt(BigInt.zero())) {
      userLp.lpBalance = BigInt.zero()
    }
    userLp.save()
    
    // Deduct proportionally from deposited balances
    if (pool.token0.length > 0) {
      let a0 = getOrCreateAttribution(poolAddr as Bytes, userBytes, pool.token0)
      if (a0.depositedBalance.gt(BigInt.zero())) {
        // deduction = depositedBalance * ratio / PRECISION
        let deduction = a0.depositedBalance.times(ratio).div(PRECISION)
        a0.depositedBalance = a0.depositedBalance.minus(deduction)
        if (a0.depositedBalance.lt(BigInt.zero())) {
          a0.depositedBalance = BigInt.zero()
        }
        a0.save()
      }
    }
    
    if (pool.token1.length > 0) {
      let a1 = getOrCreateAttribution(poolAddr as Bytes, userBytes, pool.token1)
      if (a1.depositedBalance.gt(BigInt.zero())) {
        // deduction = depositedBalance * ratio / PRECISION
        let deduction = a1.depositedBalance.times(ratio).div(PRECISION)
        a1.depositedBalance = a1.depositedBalance.minus(deduction)
        if (a1.depositedBalance.lt(BigInt.zero())) {
          a1.depositedBalance = BigInt.zero()
        }
        a1.save()
      }
    }
  }

  // clear burn helper
  s.lastLpFrom = ZERO as Bytes
  s.lastLpAmount = BigInt.zero()
  s.save()
}
