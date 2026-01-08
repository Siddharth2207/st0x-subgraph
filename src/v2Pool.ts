import { BigInt, Bytes, Address, ethereum } from "@graphprotocol/graph-ts"
import { Mint, Burn, Transfer, Pool as PoolContract } from "../generated/V2Pool1/Pool"
import { LPTokenAttribution, Pool, V2TxRecipient, UserPoolLP } from "../generated/schema"

const ZERO = Address.fromString("0x0000000000000000000000000000000000000000")

function emptyBytes(): Bytes {
  return Bytes.fromHexString("0x") as Bytes
}

function moveDepositBasisOnLpTransfer(
  poolAddr: Address,
  pool: Pool,
  from: Address,
  to: Address,
  lpMoved: BigInt
): void {
  if (lpMoved.le(BigInt.zero())) return

  // Update LP balances
  let fromLp = getOrCreateUserPoolLP(poolAddr as Bytes, from as Bytes)
  let toLp = getOrCreateUserPoolLP(poolAddr as Bytes, to as Bytes)

  let fromTotal = fromLp.lpBalance
  if (fromTotal.le(BigInt.zero())) return // nothing to move

  // ratio = lpMoved / fromTotal (18-dec fixed point)
  let PRECISION = BigInt.fromI32(10).pow(18)
  let ratio = lpMoved.times(PRECISION).div(fromTotal)

  // Move token0 basis
  if (pool.token0.length > 0) {
    let fromA0 = getOrCreateAttribution(poolAddr as Bytes, from as Bytes, pool.token0)
    let move0 = fromA0.depositedBalance.times(ratio).div(PRECISION)

    if (move0.gt(BigInt.zero())) {
      fromA0.depositedBalance = fromA0.depositedBalance.minus(move0)
      fromA0.save()

      let toA0 = getOrCreateAttribution(poolAddr as Bytes, to as Bytes, pool.token0)
      toA0.depositedBalance = toA0.depositedBalance.plus(move0)
      toA0.save()
    }
  }

  // Move token1 basis
  if (pool.token1.length > 0) {
    let fromA1 = getOrCreateAttribution(poolAddr as Bytes, from as Bytes, pool.token1)
    let move1 = fromA1.depositedBalance.times(ratio).div(PRECISION)

    if (move1.gt(BigInt.zero())) {
      fromA1.depositedBalance = fromA1.depositedBalance.minus(move1)
      fromA1.save()

      let toA1 = getOrCreateAttribution(poolAddr as Bytes, to as Bytes, pool.token1)
      toA1.depositedBalance = toA1.depositedBalance.plus(move1)
      toA1.save()
    }
  }

  // Finally move LP balances
  fromLp.lpBalance = fromLp.lpBalance.minus(lpMoved)
  if (fromLp.lpBalance.lt(BigInt.zero())) fromLp.lpBalance = BigInt.zero()
  fromLp.save()

  toLp.lpBalance = toLp.lpBalance.plus(lpMoved)
  toLp.save()
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
  if (Address.fromBytes(s.mintedTo).equals(ZERO)) return

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

  // -----------------------------
  // 1) LP MINT: Transfer(0x0 -> user)
  // -----------------------------
  if (from.equals(ZERO)) {
    s.mintedTo = to as Bytes
    s.mintLpAmount = lpAmount
    s.mintedToReady = true
    s.save()
    tryFinalizeMint(poolAddr, pool, s)
    return
  }

  // -----------------------------
  // 2) User sends LP to pair (burn intent)
  // -----------------------------
  if (to.equals(poolAddr)) {
    s.lastLpFrom = from as Bytes
    s.lastLpAmount = lpAmount
    s.save()
    return
  }

  // -----------------------------
  // 3) Actual LP burn: Transfer(pair -> 0x0)
  // -----------------------------
  if (from.equals(poolAddr) && to.equals(ZERO)) {
    // definitive LP burned amount
    s.lastLpAmount = lpAmount
    s.save()
    return
  }

  // -----------------------------
  // 4) LP transfer between users
  // -----------------------------
  if (!from.equals(ZERO) && !to.equals(ZERO) && !to.equals(poolAddr)) {
    moveDepositBasisOnLpTransfer(poolAddr, pool, from, to, lpAmount)
    return
  }

  // ignore everything else
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

  // Prefer LP sender captured from Transfer(user -> pair)
  let userBytes = s.lastLpFrom
  if (Address.fromBytes(userBytes).equals(ZERO)) {
    userBytes = event.transaction.from as Bytes
  }

  let lpRemoved = s.lastLpAmount
  if (lpRemoved.le(BigInt.zero())) {
    // nothing to do
    return
  }

  let userLp = getOrCreateUserPoolLP(poolAddr as Bytes, userBytes)
  let totalLp = userLp.lpBalance
  if (totalLp.le(BigInt.zero())) {
    return
  }

  let PRECISION = BigInt.fromI32(10).pow(18)
  let ratio = lpRemoved.times(PRECISION).div(totalLp)

  // Update LP balance
  userLp.lpBalance = userLp.lpBalance.minus(lpRemoved)
  if (userLp.lpBalance.lt(BigInt.zero())) {
    userLp.lpBalance = BigInt.zero()
  }
  userLp.save()

  // Proportional deduction for token0
  if (pool.token0.length > 0) {
    let a0 = getOrCreateAttribution(poolAddr as Bytes, userBytes, pool.token0)
    if (a0.depositedBalance.gt(BigInt.zero())) {
      let deduction0 = a0.depositedBalance.times(ratio).div(PRECISION)
      a0.depositedBalance = a0.depositedBalance.minus(deduction0)
      if (a0.depositedBalance.lt(BigInt.zero())) {
        a0.depositedBalance = BigInt.zero()
      }
      a0.save()
    }
  }

  // Proportional deduction for token1
  if (pool.token1.length > 0) {
    let a1 = getOrCreateAttribution(poolAddr as Bytes, userBytes, pool.token1)
    if (a1.depositedBalance.gt(BigInt.zero())) {
      let deduction1 = a1.depositedBalance.times(ratio).div(PRECISION)
      a1.depositedBalance = a1.depositedBalance.minus(deduction1)
      if (a1.depositedBalance.lt(BigInt.zero())) {
        a1.depositedBalance = BigInt.zero()
      }
      a1.save()
    }
  }

  // Clear scratch
  s.lastLpFrom = ZERO as Bytes
  s.lastLpAmount = BigInt.zero()
  s.save()
}

