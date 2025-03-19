import Safe, { SigningMethod } from '@safe-global/protocol-kit'
import SafeApiKit from '@safe-global/api-kit'
import { OperationType, SafeTransactionDataPartial } from '@safe-global/types-kit'
import { encodeFunctionData } from 'viem'
import { SupportedChainId, OrderKind, TradeParameters, TradingSdk, SwapAdvancedSettings, SigningScheme } from '@cowprotocol/cow-sdk'
import { VoidSigner } from '@ethersproject/abstract-signer'
import { JsonRpcProvider } from '@ethersproject/providers'
import * as dotenv from 'dotenv'

dotenv.config()
const config = process.env

async function main() {
  // Create Safe instance
  const safe = await Safe.init({
    // @ts-ignore
    provider: config.RPC_URL,
    signer: config.SIGNER_ADDRESS_PRIVATE_KEY,
    safeAddress: config.SAFE_ADDRESS,
  })

  // Get the next Safe nonce
  const apiKit = new SafeApiKit({
    chainId: BigInt(config.CHAIN_ID as string)
  })
  config.NONCE = await apiKit.getNextNonce(config.SAFE_ADDRESS as string);

  console.log('Creating transaction with Safe:')
  console.log(' - Address: ', await safe.getAddress())
  console.log(' - ChainID: ', await safe.getChainId())
  console.log(' - Version: ', await safe.getContractVersion())
  console.log(' - Threshold: ', await safe.getThreshold(), '\n')

  const encoded_replay_tx = await build_repay_transaction(config, safe);
  const encoded_withdraw_tx = await build_withdraw_transaction(config, safe);

  // TODO: use app-data sdk when flashloans are supported
  // https://github.com/cowprotocol/app-data/issues/77
  const appData = {
    metadata: {
      flashloan: {
        lender: config.AAVE_POOL_ADDRESS,
        token: config.BORROWED_TOKEN,
        amount: config.BORROWED_AMOUNT
      },
      hooks: {
        pre: [
          {
            target: config.SAFE_ADDRESS,
            value: "0",
            callData: encoded_replay_tx,
            gasLimit: "1000000"
          },
          {
            target: config.SAFE_ADDRESS,
            value: "0",
            callData: encoded_withdraw_tx,
            gasLimit: "1000000"
          }
        ],
        "post": []
      },
      signer: config.SAFE_ADDRESS
    }, 
    
  };

  console.log(JSON.stringify(appData, null, 2));

  
  // Initialize the COW SDK
  const sdk = new TradingSdk({
    chainId: SupportedChainId.SEPOLIA,
    signer: new VoidSigner(config.SAFE_ADDRESS as string, new JsonRpcProvider('https://sepolia.gateway.tenderly.co')),
    appCode: config.APP_CODE as string,
  });


  // Define trade parameters
  const parameters: TradeParameters = {
    // @ts-ignore
    env: 'staging',
    kind: OrderKind.BUY,
    // @ts-ignore
    sellToken: config.COLLATERAL_TOKEN,
    sellTokenDecimals: config.COLLATERAL_TOKEN_DECIMALS as unknown as number,
    // @ts-ignore
    buyToken: config.BORROWED_TOKEN,
    buyTokenDecimals: config.BORROWED_TOKEN_DECIMALS as unknown as number,
    // @ts-ignore
    amount: config.BUY_AMOUNT,
    // receiver is always the settlement contract because the driver takes
    // funds from the settlement contract to pay back the loan
    receiver: config.COW_SETTLEMENT_CONTRACT,
  }

  console.log({parameters});

  const quote = await sdk.getQuote(parameters, {
    quoteRequest: {
      from: config.SAFE_ADDRESS,
      signingScheme: SigningScheme.PRESIGN,      
    },
  });
  console.log({results: quote.quoteResults});

  console.log({amountsAndCosts: quote.quoteResults.amountsAndCosts});
  console.log({order: quote.quoteResults.orderToSign});

  const advancedParameters: SwapAdvancedSettings = {
    quoteRequest: {
      // Specify the signing scheme
      signingScheme: SigningScheme.PRESIGN,
    },
    // @ts-ignore
    appData,
  }

  const orderId = await sdk.postSwapOrder(parameters, advancedParameters);
  console.log('Order created, id: ', orderId);
}

async function build_repay_transaction(config: any, safe: Safe): Promise<string> {
  const repayAbi = [{
    "type": "function",
    "name": "repay",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "interestRateMode",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "onBehalfOf",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  }];

  const repayTxData = encodeFunctionData({
    abi: repayAbi,
    functionName: 'repay',
    args: [
      config.BORROWED_TOKEN,
      config.BORROWED_AMOUNT,
      // interest_rate_mode
      2,
      // on_behalf_of
      config.SAFE_ADDRESS,
    ]
  });
  const repaySafeTxData: SafeTransactionDataPartial = {
    //to: config.SAFE_ADDRESS,
    to: config.AAVE_POOL_ADDRESS,
    value: '0',
    data: repayTxData,
    operation: OperationType.Call,
    // we need to put the nonce in the future to account for the order presign transaction
    nonce: parseInt(config.NONCE) + 1,
  }

  const safeTransaction = await safe.createTransaction({ transactions: [repaySafeTxData] })
  const signedSafeTransaction = await safe.signTransaction(safeTransaction, SigningMethod.ETH_SIGN);
  const encodedSafeTransaction = await safe.getEncodedTransaction(signedSafeTransaction);

  return encodedSafeTransaction;
}

async function build_withdraw_transaction(config: any, safe: Safe): Promise<string> {
  const abi = [{
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  }];

  const txData = encodeFunctionData({
    abi,
    functionName: 'withdraw',
    args: [
      config.COLLATERAL_TOKEN,
      config.COLLATERAL_AMOUNT,
      config.SAFE_ADDRESS,
    ]
  });
  const safeTxData: SafeTransactionDataPartial = {
    to: config.AAVE_POOL_ADDRESS,
    value: '0',
    data: txData,
    operation: OperationType.Call,
    // we need to put the nonce in the future to account for the order presign transaction
    nonce: parseInt(config.NONCE) + 2,
  }

  const safeTransaction = await safe.createTransaction({ transactions: [safeTxData] })
  const signedSafeTransaction = await safe.signTransaction(safeTransaction, SigningMethod.ETH_SIGN);
  const encodedSafeTransaction = await safe.getEncodedTransaction(signedSafeTransaction);

  return encodedSafeTransaction;
}

main()
