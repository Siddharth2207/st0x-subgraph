import { ethereum, BigInt, Bytes, Address } from "@graphprotocol/graph-ts";
import { Mint, Burn } from "../generated/V3Pool1/CLPool";
import { setPoolForPosition } from "./v3Pool";

const NFT_POSITION_MANAGER = Address.fromString(
  "0x827922686190790b37229fd06084350E74485b72"
);

// topic0 for IncreaseLiquidity(uint256,uint128,uint256,uint256)
const INCREASE_LIQUIDITY_TOPIC = Bytes.fromHexString(
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4"
);

// topic0 for DecreaseLiquidity(uint256,uint128,uint256,uint256)
const DECREASE_LIQUIDITY_TOPIC = Bytes.fromHexString(
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f"
);

/**
 * Bind tokenId -> pool using the SAME tx receipt.
 * Note: receipt: true is set in subgraph.yaml, so receipt is guaranteed present.
 */

export function handleV3PoolMint(event: Mint): void {
  let logs = event.receipt!.logs;
  
  for (let i = 0; i < logs.length; i++) {
    let log = logs[i];
    
    if (!log.address.equals(NFT_POSITION_MANAGER)) continue;
    if (log.topics.length < 2) continue;
    
    let topic0 = log.topics[0];
    if (!topic0.equals(INCREASE_LIQUIDITY_TOPIC) && !topic0.equals(DECREASE_LIQUIDITY_TOPIC)) {
      continue;
    }
    
    let tokenId = BigInt.fromByteArray(Bytes.fromUint8Array(log.topics[1].reverse()));
    setPoolForPosition(tokenId, event.address);
    return;
  }
}

export function handleV3PoolBurn(event: Burn): void {
  let logs = event.receipt!.logs;
  
  for (let i = 0; i < logs.length; i++) {
    let log = logs[i];
    
    if (!log.address.equals(NFT_POSITION_MANAGER)) continue;
    if (log.topics.length < 2) continue;
    
    let topic0 = log.topics[0];
    if (!topic0.equals(INCREASE_LIQUIDITY_TOPIC) && !topic0.equals(DECREASE_LIQUIDITY_TOPIC)) {
      continue;
    }
    
    let tokenId = BigInt.fromByteArray(Bytes.fromUint8Array(log.topics[1].reverse()));
    setPoolForPosition(tokenId, event.address);
    return;
  }
}
