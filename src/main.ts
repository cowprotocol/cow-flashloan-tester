import Safe, { SafeTransactionOptionalProps, SigningMethod } from '@safe-global/protocol-kit'
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
  console.log('\nSetting up Safe')
  const {safe, nonce} = await setupSafe();

  console.log('\nBuilding order appData')
  const appData = await buildAppData(safe, nonce);
  
  // Setup CoW SDK
  const sdk = new TradingSdk({
    chainId: SupportedChainId.SEPOLIA,
    signer: new VoidSigner(config.SAFE_ADDRESS as string, new JsonRpcProvider(config.RPC_URL)),
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

  console.log('\nGetting a quote for the trade')
  const quote = await sdk.getQuote(parameters, {
    quoteRequest: {
      from: config.SAFE_ADDRESS,
      signingScheme: SigningScheme.PRESIGN,      
    },
  });
  console.log({quote: quote.quoteResults.amountsAndCosts});

  const quoteSellAmount = quote.quoteResults.amountsAndCosts.afterSlippage.sellAmount;
  const maxSellAmount = BigInt(config.COLLATERAL_AMOUNT as string);
  if(quoteSellAmount > maxSellAmount) {
    console.log('\nError: cost exceeds the collateral')
    process.exit(1)
  }

  console.log('\nPublishing the order')
  const advancedParameters: SwapAdvancedSettings = {
    quoteRequest: {
      signingScheme: SigningScheme.PRESIGN,
    },
    // @ts-ignore
    appData,
  }

  const orderId = await sdk.postSwapOrder(parameters, advancedParameters);
  console.log('    - Order created, id: ', orderId);

  console.log('\nSigning the order')
  // FIXME: Ideally we want the signing to be automated with the "setOrderPresignature" function call below,
  // but the safe sdk returns errors on transaction creation and execution.
  // Example of a similar working manual transaction: 0x9008D19f58AAbD9eD0D60971565AA8510560ab41
  // await setOrderPresignature(config, sdk, safe, orderId);

  console.log('The signing must be done manually from the Safe UI:')
  console.log('   - "New Transaction" -> "Transaction Builder"')
  console.log('   - Enter the COW_SETTLEMENT_CONTRACT address: ', config.COW_SETTLEMENT_CONTRACT,)
  console.log('   - Select the "setPresignature" method')
  console.log('   - Put the order uid: ', orderId)
  console.log('   - Execute with 100k gas limit. Execution on sepolia is flaky (404 errors), must retry a few times')
}

async function setupSafe() {
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
  const nonceString = await apiKit.getNextNonce(config.SAFE_ADDRESS as string);
  const nonce = parseInt(nonceString);
  console.log('    - Current safe nonce: ', nonce);

  return {safe, nonce}
}

async function buildAppData(safe: Safe, nonce: number) {
  // we need to put the nonce in the future to account for the order presign transaction
  console.log('    - Using nonce ', nonce + 1, ' for the repay pre-hook');
  const repayTx = await buildRepayTransaction(safe, nonce + 1);
  console.log('    - Using nonce ', nonce + 2, ' for the withdraw pre-hook');
  const withdrawTx = await buildWithdrawTransaction(safe, nonce + 2);

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
            callData: repayTx,
            gasLimit: "1000000"
          },
          {
            target: config.SAFE_ADDRESS,
            value: "0",
            callData: withdrawTx,
            gasLimit: "1000000"
          }
        ],
        "post": []
      },
      signer: config.SAFE_ADDRESS
    }, 
    
  };

  return appData;
}

async function buildRepayTransaction(safe: Safe, nonce: number): Promise<string> {
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
    to: config.AAVE_POOL_ADDRESS as string,
    value: '0',
    data: repayTxData,
    operation: OperationType.Call,
    nonce,
  }

  const safeTransaction = await safe.createTransaction({ transactions: [repaySafeTxData] })
  const signedSafeTransaction = await safe.signTransaction(safeTransaction, SigningMethod.ETH_SIGN);
  const encodedSafeTransaction = await safe.getEncodedTransaction(signedSafeTransaction);

  return encodedSafeTransaction;
}

async function buildWithdrawTransaction(safe: Safe, nonce: number): Promise<string> {
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
    to: config.AAVE_POOL_ADDRESS as string,
    value: '0',
    data: txData,
    operation: OperationType.Call,
    nonce,
  }

  const safeTransaction = await safe.createTransaction({ transactions: [safeTxData] })
  const signedSafeTransaction = await safe.signTransaction(safeTransaction, SigningMethod.ETH_SIGN);
  const encodedSafeTransaction = await safe.getEncodedTransaction(signedSafeTransaction);

  return encodedSafeTransaction;
}

async function setOrderPresignature(config: any, sdk: TradingSdk, safe: Safe, orderId: string) {
  const preSignTransaction = await sdk.getPreSignTransaction({
    orderId,
    account: config.SAFE_ADDRESS as string,
  });

  const safeTransactionData: SafeTransactionDataPartial = {
    to: config.COW_SETTLEMENT_CONTRACT as string,
    value: preSignTransaction.value,
    data: preSignTransaction.data,
    operation: OperationType.Call
  }

  // These values work in the Safe UI (Transaction Builder) for the same type of transaction
  const options = {
    // FIXME: not sure which of the two gas options (safeTxGas, gas) use here
    safeTxGas: '200000',
    gas: 200000n,
    maxFeePerGas: 241000000n, // 0.26601 Gwei) 
    maxPriorityFeePerGas: 1000000n // 0.001 Gwei
  } as SafeTransactionOptionalProps;

  /*
    FIXME: We are setting the gas limit manually ("gas" option) but the "createTransaction" call below logs an error::
      Error: cannot estimate gas; transaction may fail or may require manual gas limit [ See: https://links.ethers.org/v5-errors-UNPREDICTABLE_GAS_LIMIT ] (reason="execution reverted", method="estimateGas", transaction={"from":"0x35eD9A9D1122A1544e031Cc92fCC7eA599e28D9C","to":"0x35eD9A9D1122A1544e031Cc92fCC7eA599e28D9C","data":"0xec6cb13f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000038a83f594602e797a9579096cd92deb6745829cf6a7ae407d80155f86af30b3b4835ed9a9d1122a1544e031cc92fcc7ea599e28d9c67dd36fe0000000000000000","accessList":null}, error={"reason":"processing response error","code":"SERVER_ERROR","body":"{\"id\":44,\"jsonrpc\":\"2.0\",\"error\":{\"code\":3,\"message\":\"execution reverted\"}}","error":{"code":3},"requestBody":"{\"method\":\"eth_estimateGas\",\"params\":[{\"from\":\"0x35ed9a9d1122a1544e031cc92fcc7ea599e28d9c\",\"to\":\"0x35ed9a9d1122a1544e031cc92fcc7ea599e28d9c\",\"data\":\"0xec6cb13f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000038a83f594602e797a9579096cd92deb6745829cf6a7ae407d80155f86af30b3b4835ed9a9d1122a1544e031cc92fcc7ea599e28d9c67dd36fe0000000000000000\"}],\"id\":44,\"jsonrpc\":\"2.0\"}","requestMethod":"POST","url":"https://sepolia.gateway.tenderly.co"}, code=UNPREDICTABLE_GAS_LIMIT, version=providers/5.8.0)
  */
  const safeTransaction = await safe.createTransaction({ transactions: [safeTransactionData], options });

  const signedSafeTransaction = await safe.signTransaction(safeTransaction, SigningMethod.ETH_SIGN);
  
  /*
    FIXME: Execution fails with:
      Version: viem@2.23.11 cause: HttpRequestError: HTTP request failed.
      Status: 429 URL: https://sepolia.gateway.tenderly.co Request body: {"method":"eth_sendRawTransaction","params"....
      {"code":-32005,"message":"rate limit exceeded"}
  */
  const transactionResult = await safe.executeTransaction(signedSafeTransaction, options);
  console.log('    - Presigned transaction hash: ' + transactionResult.hash);
}

main()
