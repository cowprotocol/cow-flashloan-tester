import Safe, { SigningMethod } from '@safe-global/protocol-kit'
import { OperationType, SafeTransactionDataPartial } from '@safe-global/types-kit'
import { encodeFunctionData } from 'viem'
import { SupportedChainId, OrderKind, TradeParameters, TradingSdk, SwapAdvancedSettings, SigningScheme } from '@cowprotocol/cow-sdk'

const config = {
  RPC_URL: 'https://sepolia.gateway.tenderly.co',
  COW_SETTLEMENT_CONTRACT: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
  APP_CODE: 'FlashLoan Test',
  SIGNER_ADDRESS_PRIVATE_KEY: '0x',
  SAFE_ADDRESS: '0x',
  AAVE_POOL_ADDRESS: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  COLLATERAL_TOKEN: "0x",
  COLLATERAL_AMOUNT: "10000000000",
  BORROWED_TOKEN: "0x",
  BORROWED_AMOUNT: "10000000000",
}

async function main() {
  // Create Safe instance
  const safe = await Safe.init({
    provider: config.RPC_URL,
    signer: config.SIGNER_ADDRESS_PRIVATE_KEY,
    safeAddress: config.SAFE_ADDRESS,
  })

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
      }
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
    "signer": config.SAFE_ADDRESS
  };

  console.log(JSON.stringify(appData, null, 2));
  
  // Initialize the COW SDK
  const sdk = new TradingSdk({
    chainId: SupportedChainId.SEPOLIA,
    signer: config.SIGNER_ADDRESS_PRIVATE_KEY,
    appCode: config.APP_CODE,
  });


  // Define trade parameters
  const parameters: TradeParameters = {
    // @ts-ignore
    env: 'staging',
    kind: OrderKind.BUY,
    sellToken: config.COLLATERAL_TOKEN,
    sellTokenDecimals: 6,
    buyToken: config.BORROWED_TOKEN,
    buyTokenDecimals: 6,
    amount: config.COLLATERAL_AMOUNT,
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
  
  const orderId = await quote.postSwapOrderFromQuote();
  console.log('Order created, id: ', orderId);

  const preSignTransaction = await sdk.getPreSignTransaction({
    orderId,
    account: config.SAFE_ADDRESS,
  });
  console.log(
    `Pre-sign unsigned transaction: ${JSON.stringify(
      preSignTransaction,
      null,
      2
    )}`
  );

  const safeTransactionData: SafeTransactionDataPartial = {
    to: preSignTransaction.to,
    value: preSignTransaction.value,
    data: preSignTransaction.data,
    operation: OperationType.Call
  }
  const safeTransaction = await safe.createTransaction({ transactions: [safeTransactionData] });
  const signedSafeTransaction = await safe.signTransaction(safeTransaction, SigningMethod.ETH_SIGN);
  const transactionResult = await safe.executeTransaction(signedSafeTransaction);

  console.log({transactionResult});
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
      config.BORROWED_TOKEN,
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
    operation: OperationType.Call
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
    operation: OperationType.Call
  }

  const safeTransaction = await safe.createTransaction({ transactions: [safeTxData] })
  const signedSafeTransaction = await safe.signTransaction(safeTransaction, SigningMethod.ETH_SIGN);
  const encodedSafeTransaction = await safe.getEncodedTransaction(signedSafeTransaction);

  return encodedSafeTransaction;
}

main()
