import { BigInt, Bytes, ethereum, log, Address, dataSource } from "@graphprotocol/graph-ts"
import { Mint, Burn } from "../generated/templates/V2PoolTemplate/V2Pool"
import { LPTokenAttribution, V2Pool } from "../generated/schema"

function getOrCreateAttribution(
  pool: Bytes,
  user: Bytes,
  token: Bytes
): LPTokenAttribution {
  let id = pool.toHexString() + "-" + user.toHexString() + "-" + token.toHexString()
  let attribution = LPTokenAttribution.load(id)
  
  if (attribution == null) {
    attribution = new LPTokenAttribution(id)
    attribution.pool = pool
    attribution.user = user
    attribution.token = token
    attribution.depositedBalance = BigInt.fromI32(0)
  }
  
  return attribution
}

// Find the actual depositor by looking at the transaction receipt
// The depositor is the one who received LP tokens (Transfer event from zero address)
function findDepositorFromReceipt(event: Mint): Bytes {
  let poolAddress = event.address
  let receipt = event.receipt
  
  if (receipt != null) {
    // Transfer event topic0: keccak256("Transfer(address,address,uint256)")
    let transferSigHex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    let zeroAddrHex = "0x0000000000000000000000000000000000000000000000000000000000000000"
    
    for (let i = 0; i < receipt.logs.length; i++) {
      let receiptLog = receipt.logs[i]
      
      // Check if this is from the pool contract and has enough topics
      if (receiptLog.address.toHexString() == poolAddress.toHexString()) {
        if (receiptLog.topics.length >= 3) {
          // Check if topic0 matches Transfer signature
          if (receiptLog.topics[0].toHexString() == transferSigHex) {
            // topic1 is 'from', topic2 is 'to'
            let fromHex = receiptLog.topics[1].toHexString()
            
            // If from is zero address, this is a mint
            if (fromHex == zeroAddrHex) {
              // Extract the 'to' address (last 20 bytes of 32-byte topic)
              let toHex = receiptLog.topics[2].toHexString()
              // toHex is like "0x000000000000000000000000<actual address>"
              // We need to extract the actual address: 0x + last 40 chars
              let actualAddr = "0x" + toHex.slice(26) // skip "0x" + 24 zeros
              return Address.fromString(actualAddr)
            }
          }
        }
      }
    }
  }
  
  // Fallback: use transaction origin (the EOA that initiated the transaction)
  return event.transaction.from
}

export function handleV2Mint(event: Mint): void {
  let poolAddress = event.address
  let poolEntity = V2Pool.load(poolAddress.toHexString())
  
  if (poolEntity == null) {
    log.warning("V2Pool not found for address: {}", [poolAddress.toHexString()])
    return
  }

  // Find the depositor from receipt or use tx origin
  let depositor = findDepositorFromReceipt(event)

  // Update attribution for token0
  let attribution0 = getOrCreateAttribution(
    poolAddress,
    depositor,
    poolEntity.token0
  )
  attribution0.depositedBalance = attribution0.depositedBalance.plus(event.params.amount0)
  attribution0.save()

  // Update attribution for token1
  let attribution1 = getOrCreateAttribution(
    poolAddress,
    depositor,
    poolEntity.token1
  )
  attribution1.depositedBalance = attribution1.depositedBalance.plus(event.params.amount1)
  attribution1.save()
}

export function handleV2Burn(event: Burn): void {
  let poolAddress = event.address
  let poolEntity = V2Pool.load(poolAddress.toHexString())
  
  if (poolEntity == null) {
    log.warning("V2Pool not found for address: {}", [poolAddress.toHexString()])
    return
  }

  // The "to" address in Burn event is the one withdrawing
  let withdrawer = event.params.to

  // Update attribution for token0 (subtract)
  let attribution0 = getOrCreateAttribution(
    poolAddress,
    withdrawer,
    poolEntity.token0
  )
  attribution0.depositedBalance = attribution0.depositedBalance.minus(event.params.amount0)
  attribution0.save()

  // Update attribution for token1 (subtract)
  let attribution1 = getOrCreateAttribution(
    poolAddress,
    withdrawer,
    poolEntity.token1
  )
  attribution1.depositedBalance = attribution1.depositedBalance.minus(event.params.amount1)
  attribution1.save()
}
