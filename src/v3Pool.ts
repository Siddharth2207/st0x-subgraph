import { BigInt, Bytes, Address, ethereum } from "@graphprotocol/graph-ts"
import { Mint, Burn, CLPool } from "../generated/V3Pool1/CLPool"
import { NonfungiblePositionManager } from "../generated/V3Pool1/NonfungiblePositionManager"
import { Pool, LPTokenAttribution, UserPoolLP } from "../generated/schema"

// NonfungiblePositionManager address
const NFT_POSITION_MANAGER = Address.fromString("0x827922686190790b37229fd06084350E74485b72")

// Event signature hashes
// IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const INCREASE_LIQUIDITY_TOPIC = Bytes.fromHexString("0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f")
// DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const DECREASE_LIQUIDITY_TOPIC = Bytes.fromHexString("0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4")

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

// Find tokenId from IncreaseLiquidity/DecreaseLiquidity event in tx receipt
function findTokenIdFromReceipt(
  receipt: ethereum.TransactionReceipt, 
  eventTopic: Bytes
): BigInt | null {
  let logs = receipt.logs
  
  for (let i = 0; i < logs.length; i++) {
    let log = logs[i]
    
    // Check if this log is from NonfungiblePositionManager
    if (log.address.notEqual(NFT_POSITION_MANAGER)) {
      continue
    }
    
    // Check if topics exist and first topic matches our event
    if (log.topics.length < 2) {
      continue
    }
    
    if (log.topics[0].notEqual(eventTopic)) {
      continue
    }
    
    // tokenId is in topics[1] (indexed parameter)
    let tokenId = BigInt.fromByteArray(Bytes.fromUint8Array(log.topics[1].reverse()))
    return tokenId
  }
  
  return null
}

// Get owner of NFT position by tokenId via contract call
function getPositionOwner(tokenId: BigInt): Address | null {
  let nftManager = NonfungiblePositionManager.bind(NFT_POSITION_MANAGER)
  let ownerResult = nftManager.try_ownerOf(tokenId)
  
  if (ownerResult.reverted) {
    return null
  }
  
  return ownerResult.value
}

// Resolve the actual owner (LP holder) - handles Safe wallets and direct transactions
function resolveOwner(event: ethereum.Event, eventTopic: Bytes): Address {
  let receipt = event.receipt
  if (receipt !== null) {
    let tokenId = findTokenIdFromReceipt(receipt, eventTopic)
    if (tokenId !== null) {
      let realOwner = getPositionOwner(tokenId)
      if (realOwner !== null) {
        return realOwner
      }
    }
  }
  // Fallback to transaction.from if we can't find the owner from receipt
  return event.transaction.from
}

export function handleV3Mint(event: Mint): void {
  let pool = getOrCreatePool(event.address)
  
  let owner: Address = event.params.owner
  
  // If owner is NFT position manager, resolve the actual LP holder
  // by looking up ownerOf(tokenId) from the IncreaseLiquidity event
  if (owner.equals(NFT_POSITION_MANAGER)) {
    owner = resolveOwner(event, INCREASE_LIQUIDITY_TOPIC)
  }
  
  let liquidity = event.params.amount
  let amount0 = event.params.amount0
  let amount1 = event.params.amount1
  
  // Track liquidity balance for proportional withdrawal
  if (liquidity.gt(BigInt.zero())) {
    let userLp = getOrCreateUserPoolLP(event.address, owner)
    userLp.lpBalance = userLp.lpBalance.plus(liquidity)
    userLp.save()
  }
  
  if (pool.token0.length > 0 && amount0.gt(BigInt.zero())) {
    let a0 = getOrCreateAttribution(event.address, owner, pool.token0)
    a0.depositedBalance = a0.depositedBalance.plus(amount0)
    a0.save()
  }
  
  if (pool.token1.length > 0 && amount1.gt(BigInt.zero())) {
    let a1 = getOrCreateAttribution(event.address, owner, pool.token1)
    a1.depositedBalance = a1.depositedBalance.plus(amount1)
    a1.save()
  }
}

export function handleV3Burn(event: Burn): void {
  let pool = getOrCreatePool(event.address)
  
  let owner: Address = event.params.owner
  
  // If owner is NFT position manager, resolve the actual LP holder
  // by looking up ownerOf(tokenId) from the DecreaseLiquidity event
  if (owner.equals(NFT_POSITION_MANAGER)) {
    owner = resolveOwner(event, DECREASE_LIQUIDITY_TOPIC)
  }
  
  let liquidityRemoved = event.params.amount
  
  // Get user's liquidity balance for proportional calculation
  let userLp = getOrCreateUserPoolLP(event.address, owner)
  let totalLiquidity = userLp.lpBalance
  
  // Calculate proportion: liquidityRemoved / totalLiquidity
  // Use high precision (18 decimals) for ratio calculation
  let PRECISION = BigInt.fromI32(10).pow(18)
  
  if (totalLiquidity.gt(BigInt.zero()) && liquidityRemoved.gt(BigInt.zero())) {
    // ratio = liquidityRemoved * PRECISION / totalLiquidity
    let ratio = liquidityRemoved.times(PRECISION).div(totalLiquidity)
    
    // Deduct liquidity balance
    userLp.lpBalance = userLp.lpBalance.minus(liquidityRemoved)
    if (userLp.lpBalance.lt(BigInt.zero())) {
      userLp.lpBalance = BigInt.zero()
    }
    userLp.save()
    
    // Deduct proportionally from deposited balances
    if (pool.token0.length > 0) {
      let a0 = getOrCreateAttribution(event.address, owner, pool.token0)
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
      let a1 = getOrCreateAttribution(event.address, owner, pool.token1)
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
}
