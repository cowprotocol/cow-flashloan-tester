# CoW Swap Flash Loan Tester
This project provides a semi-automatic way of testing [Cow Swap](https://swap.cow.fi/) Flash Loan functionality on Sepolia network.

##  Prerequisites

### 1. Set up the environment variable file 
The project uses [dotenv](https://github.com/motdotla/dotenv#readme).
Copy the `.env.example` file into `.env` in the root folder of the project:
```console
cp .env.example .env
```
The following sections will specify which values to give to all the environment variables in the `.env` file

### 2. Set up a Safe Wallet
A deployed [Safe Wallet](https://app.safe.global/) in Sepolia is needed, with enough funds to pay gas costs. We assume a Safe with a single EOA owner.

#### **`.env`**
```
SAFE_ADDRESS = "0x....."
# Private key of the Safe owner
SIGNER_ADDRESS_PRIVATE_KEY = "0x...."
```

If the safe has more than one owner, the project code needs to be updated to reflect that. Check out the [Safe SDK](https://docs.safe.global/sdk-protocol-kit) for more info.

### 2. Select Aave tokens
For the test, we must select a pair of tokens in Aave:
* One token will be deposited and thus used as collateral (envvars  `COLLATERAL_TOKEN` and `COLLATERAL_TOKEN_DECIMALS`).
* The other token will be borrowed (envvars  `BORROWED_TOKEN` and `BORROWED_TOKEN_DECIMALS`).

Please take into account that in Sepolia, Aave token names may not correspond with the token name in any other dapp, so it's 
important to check in [Aave's frontend](https://app.aave.com/) the token addresses:
* The section `Assets to supply` (check the option `Show assets with 0 balance`) will show which tokens can be used as collateral.
* The section `Assets to borrow` shows which tokens can be borrowed against

### 3. Token approvals
ERC20 token approvals (for both collateral and borrowed tokens) are needed from the Safe wallet to CoW's Vault relayer contract in Sepolia (address: `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`).
For convenience it's recommended to set up max values for the approval.

### 4. Determine token amounts needed to trade and deposit
In Sepolia, the token ratios in Uniswap (which we use as a default solver) may be too extreme and vary a lot.

Please play around [Cow Swap](https://swap.cow.fi/) (make sure to include the **exact token addresses** from Aave, do not rely on token names) to determine the exchange ratio between the collateral and borrowed tokens.

You may need to perform a few trades with the most valuable token of the pair to get the least valuable, so the ratios are somehow balanced before the test.

It's also important to know that the amounts to trade must be big enough so the network costs don't skyrocket.

### 5. Get tokens from the faucet
Aave tokens can be obtained from the [faucet](https://gho.aave.com/faucet/). Currently this is a manual process (10k tokens per transactions) and very time-consuming.

The faucet site doesn't seem to be able to be connected to Safe using WalletConnect, so we recommend using a regular EOA account to get the tokens and then transfer the needed amounts to the Safe wallet. 

You will need to deposit enough tokens in Aave so that an big enough amount can be withdrawn and used to trade for the borrowed token.

### 6. Create the deposit and borrow in Aave
In Aave, create a new deposit (`Assets to supply`) with the collateral token and a new borrow (`Assets to borrow`) with the selected borrowed token.

The deposit and borrow amounts must be bigger/equal than the intended amounts to trade.

At this point you can set up the `COLLATERAL_AMOUNT` and `BORROWED_AMOUNT` environment variables in the `.env` file. Both must be lower or equal than the the corresponding deposit/borrow in Aave, but big enough for the trade to succeed.

Set up the `BUY_AMOUNT` envvar to be a bit higher than the `BORROWED_AMOUNT`, enough to pay for the flashloan fee.

### 7. Check Aave's withdrawal/borrow availability
Even if you have a large enough deposit in Aave, there may not be enough tokens available in Aave to withdraw at any moment. Same with borrowing tokens.

To check for withdrawal availability, after having deposited the collateral tokens, click on `Your supplies -> Withdraw` to see a preview of the max supply balance. There should be enough tokens for the trade. If there are not enough, you will need to use another account (different than the Safe) to deposit enough funds to raise the max supply balance
    
For borrowing availability (used in the flashloan itself) is the same process, but under the `Your borrows -> Borrow`. If there are not enough tokens (`BORROWED_AMOUNT`) then you need to use another account to deposit more funds into Aave for that token.


## Running the test

Install dependencies with:
```console
npm i
```

After all prerequisites are met and all the environment variables set, run the test with:
```console
npm run main 
```

If everything succeeds, the order UID will be shown, along with instructions to manually set the order presignature using Safe.

Finally, you can use the [CoW explorer](https://explorer.cow.fi/) to track the order's progress.