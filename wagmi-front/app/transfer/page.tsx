'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useChainId,
} from 'wagmi';
import {
  isAddress,
  parseUnits,
  formatUnits,
  type Address,
} from 'viem';
import permitTokenAbi from '../contracts/PermitToken.json';

// TODO: replace with your ERC20 contract
const PERMIT_TOKEN_ADDRESS = '0x042eB0c69FC25678B0d399984c17959875f7018c' as Address;

function explorerBaseFromChainId(chainId?: number) {
  switch (chainId) {
    case 1: return 'https://etherscan.io';
    case 11155111: return 'https://sepolia.etherscan.io';
    case 10: return 'https://optimistic.etherscan.io';
    case 8453: return 'https://basescan.org';
    case 42161: return 'https://arbiscan.io';
    case 137: return 'https://polygonscan.com';
    default: return undefined;
  }
}

export default function TransferPage() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { writeContractAsync, isPending: isWritePending, error: writeError } = useWriteContract();

  const [toAddress, setToAddress] = useState('');
  const [rawAmount, setRawAmount] = useState('');
  const [status, setStatus] = useState<string>('');
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);

  // Token metadata
  const { data: tokenName } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'name',
  });

  const { data: tokenSymbol } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'symbol',
  });

  const { data: tokenDecimals } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'decimals',
  });

  // Balance (as bigint)
  const {
    data: tokenBalance,
    refetch: refetchTokenBalance,
    isFetching: isBalanceLoading,
  } = useReadContract({
    address: PERMIT_TOKEN_ADDRESS,
    abi: permitTokenAbi,
    functionName: 'balanceOf',
    args: [address as Address],
    query: { enabled: Boolean(address) } as any,
  });

  const { isLoading: isConfirming, isSuccess: isConfirmed, error: receiptError } =
    useWaitForTransactionReceipt({ hash });

  // Derived values
  const decimals = typeof tokenDecimals === 'number' ? tokenDecimals : Number(tokenDecimals ?? 18);
  const formattedBalance = useMemo(() => {
    if (tokenBalance == null) return '—';
    try {
      return formatUnits(tokenBalance as bigint, decimals);
    } catch {
      return tokenBalance.toString();
    }
  }, [tokenBalance, decimals]);

  const amountAsBigInt = useMemo(() => {
    if (!rawAmount) return undefined;
    try {
      return parseUnits(rawAmount, decimals);
    } catch {
      return undefined;
    }
  }, [rawAmount, decimals]);

  const amountError = useMemo(() => {
    if (!rawAmount) return '';
    if (amountAsBigInt === undefined) return 'Invalid amount format';
    if (amountAsBigInt <= 0n) return 'Amount must be greater than 0';
    if (tokenBalance !== undefined && amountAsBigInt > (tokenBalance as bigint)) {
      return 'Insufficient balance';
    }
    return '';
  }, [rawAmount, amountAsBigInt, tokenBalance]);

  const addressError = useMemo(() => {
    if (!toAddress) return '';
    return isAddress(toAddress) ? '' : 'Invalid address';
  }, [toAddress]);

  const canSubmit =
    !!address &&
    !!chainId &&
    !!amountAsBigInt &&
    !amountError &&
    isAddress(toAddress) &&
    !isWritePending &&
    !isConfirming;

  const explorerBase = explorerBaseFromChainId(chainId);

  // Update status text on confirmation states
  useEffect(() => {
    if (isConfirming) setStatus('Confirming transaction…');
    if (isConfirmed) setStatus('Transaction successful!');
  }, [isConfirming, isConfirmed]);

  // Refresh balance after success
  useEffect(() => {
    if (isConfirmed) {
      refetchTokenBalance();
    }
  }, [isConfirmed, refetchTokenBalance]);

  const handleMax = () => {
    if (tokenBalance == null) return;
    setRawAmount(formatUnits(tokenBalance as bigint, decimals));
  };

  const handleTransfer = async () => {
    if (!canSubmit || amountAsBigInt == null) return;
    try {
      setStatus('Waiting for wallet confirmation…');
      const txHash = await writeContractAsync({
        address: PERMIT_TOKEN_ADDRESS,
        abi: permitTokenAbi,
        functionName: 'transfer',
        args: [toAddress as Address, amountAsBigInt],
      });
      setHash(txHash);
      setStatus('Transaction sent. Waiting for confirmations…');
    } catch (err: any) {
      setStatus(err?.shortMessage ?? err?.message ?? 'Transaction rejected or failed');
    }
  };

  return (
    <div className="mx-auto max-w-lg p-6">
      <div className="rounded-2xl shadow-md border border-gray-200 p-6">
        <h1 className="text-2xl font-semibold mb-1">Transfer Tokens</h1>
        <p className="text-sm text-gray-600 mb-6">Send your ERC-20 to another address.</p>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-gray-100 p-4">
            <div className="text-xs text-gray-500">Token</div>
            <div className="text-base font-medium">
              {tokenName ? `${tokenName} ${tokenSymbol ? `(${tokenSymbol})` : ''}` : '—'}
            </div>
          </div>
          <div className="rounded-xl border border-gray-100 p-4">
            <div className="text-xs text-gray-500">Your Balance</div>
            <div className="text-base font-medium">
              {isBalanceLoading ? 'Loading…' : formattedBalance}
              {tokenSymbol ? ` ${tokenSymbol}` : ''}
            </div>
          </div>
        </div>

        <label className="text-sm font-medium">Recipient Address</label>
        <input
          className={`mt-1 mb-3 w-full rounded-xl border p-3 text-sm outline-none transition
            ${addressError ? 'border-red-400 focus:ring-2 focus:ring-red-200' : 'border-gray-200 focus:ring-2 focus:ring-gray-200'}`}
          placeholder="0x…"
          value={toAddress}
          onChange={(e) => setToAddress(e.target.value.trim())}
          spellCheck={false}
        />
        {addressError && <div className="text-xs text-red-500 mb-3">{addressError}</div>}

        <label className="text-sm font-medium">Amount</label>
        <div className="mt-1 mb-1 flex gap-2">
          <input
            className={`w-full rounded-xl border p-3 text-sm outline-none transition
              ${amountError ? 'border-red-400 focus:ring-2 focus:ring-red-200' : 'border-gray-200 focus:ring-2 focus:ring-gray-200'}`}
            placeholder="e.g., 1.25"
            inputMode="decimal"
            value={rawAmount}
            onChange={(e) => setRawAmount(e.target.value.trim())}
          />
          <button
            type="button"
            className="px-3 rounded-xl border border-gray-200 text-sm hover:bg-gray-50"
            onClick={handleMax}
            disabled={tokenBalance == null}
            title="Use maximum available balance"
          >
            Max
          </button>
        </div>
        {amountError && <div className="text-xs text-red-500 mb-4">{amountError}</div>}

        <button
          onClick={handleTransfer}
          disabled={!canSubmit}
          className={`w-full mt-4 rounded-xl px-4 py-3 text-sm font-medium transition
            ${canSubmit ? 'bg-black text-white hover:opacity-90' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
        >
          {isWritePending
            ? 'Check Wallet…'
            : isConfirming
            ? 'Processing…'
            : 'Transfer'}
        </button>

        {status && <p className="text-sm mt-4">Status: {status}</p>}

        {writeError && (
          <p className="text-sm text-red-600 mt-2">
            Transaction Error: {writeError.message}
          </p>
        )}
        {receiptError && (
          <p className="text-sm text-red-600 mt-2">
            Receipt Error: {receiptError.message}
          </p>
        )}

        {isConfirmed && hash && (
          <div className="mt-4 text-sm">
            <p className="mb-1">Transaction confirmed ✅</p>
            {explorerBase && (
              <a
                className="underline text-blue-600"
                href={`${explorerBase}/tx/${hash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on explorer
              </a>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500 mt-4">
        Tip: balances and amounts respect token decimals ({decimals}).
      </p>
    </div>
  );
}
