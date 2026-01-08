import { BigInt, Bytes, Address, ethereum } from "@graphprotocol/graph-ts"
import { Mint, Burn, CLPool } from "../generated/V3Pool1/CLPool"
import { Pool, LPTokenAttribution, UserPoolLP } from "../generated/schema"

// NonfungiblePositionManager address
const NFT_POSITION_MANAGER = Address.fromString("0x827922686190790b37229fd06084350E74485b72")
const ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000")

// ERC721 Transfer event: Transfer(indexed address from, indexed address to, indexed uint256 tokenId)
const ERC721_TRANSFER_TOPIC = Bytes.fromHexString("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")

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

// Find owner from ERC721 Transfer event in receipt
// For mint: looks for Transfer(0x0 -> user), returns `to`
// For burn: looks for Transfer(user -> 0x0), returns `from`
function findOwnerFromNFTTransfer(
  receipt: ethereum.TransactionReceipt,
  isMint: boolean
): Address | null {
  let logs = receipt.logs
  
  for (let i = 0; i < logs.length; i++) {
    let log = logs[i]
    
    // Check if this log is from NonfungiblePositionManager
    if (log.address.notEqual(NFT_POSITION_MANAGER)) {
      continue
    }
    
    // Check if topics exist and first topic is ERC721 Transfer
    if (log.topics.length < 4) {
      continue
    }
    
    if (log.topics[0].notEqual(ERC721_TRANSFER_TOPIC)) {
      continue
    }
    
    // ERC721 Transfer: topics[1] = from, topics[2] = to, topics[3] = tokenId
    let from = Address.fromBytes(Bytes.fromUint8Array(log.topics[1].subarray(12)))
    let to = Address.fromBytes(Bytes.fromUint8Array(log.topics[2].subarray(12)))
    
    if (isMint) {
      // For mint: look for Transfer(0x0 -> user) - NFT being minted to user
      if (from.equals(ZERO_ADDRESS) && to.notEqual(ZERO_ADDRESS)) {
        return to
      }
    } else {
      // For burn: look for Transfer(user -> 0x0) - NFT being burned
      // Or any transfer where from != 0x0 (user is the current holder)
      if (from.notEqual(ZERO_ADDRESS)) {
        return from
      }
    }
  }
  
  return null
}

// Resolve the actual owner (LP holder) from ERC721 Transfer events
function resolveOwnerForMint(event: ethereum.Event): Address {
  let receipt = event.receipt
  if (receipt !== null) {
    let owner = findOwnerFromNFTTransfer(receipt, true)
    if (owner !== null) {
      return owner
    }
  }
  // Fallback to transaction.from
  return event.transaction.from
}

function resolveOwnerForBurn(event: ethereum.Event): Address {
  let receipt = event.receipt
  if (receipt !== null) {
    let owner = findOwnerFromNFTTransfer(receipt, false)
    if (owner !== null) {
      return owner
    }
  }
  // Fallback to transaction.from
  return event.transaction.from
}

export function handleV3Mint(event: Mint): void {
  let pool = getOrCreatePool(event.address)
  
  let owner: Address = event.params.owner
  
  // If owner is NFT position manager, resolve the actual LP holder
  // by looking for ERC721 Transfer event (NFT minted to user)
  if (owner.equals(NFT_POSITION_MANAGER)) {
    owner = resolveOwnerForMint(event)
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
  // by looking for ERC721 Transfer event (user's NFT)
  if (owner.equals(NFT_POSITION_MANAGER)) {
    owner = resolveOwnerForBurn(event)
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
