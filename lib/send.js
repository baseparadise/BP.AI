// lib/send.js — Kirim ETH / USDC di Base Mainnet
// Hanya bisa dipakai oleh owner bot (diproteksi di bot.js).
//
// Perintah: send <nominal> <usdc|eth> to <alamat>
// Contoh  : send 1 usdc to 0xABC...
//           send 0.5 usdc to 0xABC...
//           send 0.0002 eth to 0xABC...

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC native Base, 6 desimal
const USDC_ABI  = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

let _ethers   = null;
let _provider = null;
let _wallet   = null;

function loadWallet() {
  if (_wallet) return { ethers: _ethers, provider: _provider, wallet: _wallet };
  try { _ethers = require('ethers'); } catch (e) { throw new Error('Package "ethers" belum terinstall.'); }
  const pk  = process.env.BOT_PRIVATE_KEY;
  const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  if (!pk) throw new Error('BOT_PRIVATE_KEY tidak diset di Railway!');
  _provider = new _ethers.JsonRpcProvider(rpc);
  _wallet   = new _ethers.Wallet(pk, _provider);
  return { ethers: _ethers, provider: _provider, wallet: _wallet };
}

/**
 * Deteksi perintah kirim token.
 * Format: send <nominal> <usdc|eth> to <0xALAMAT>
 * Mengembalikan { amount, token, to } atau null.
 */
function parseSendCommand(text) {
  const m = (text || '').trim().match(
    /^send\s+([\d.,]+)\s+(usdc|eth)\s+to\s+(0x[a-fA-F0-9]{40})\s*$/i
  );
  if (!m) return null;
  const amount = parseFloat(m[1].replace(',', '.'));
  if (isNaN(amount) || amount <= 0) return null;
  return { amount, token: m[2].toLowerCase(), to: m[3] };
}

/**
 * Eksekusi transfer token.
 * @param {{ amount: number, token: 'eth'|'usdc', to: string }} params
 * @returns {Promise<{ token, amount, to, txHash, txUrl, blockNumber, from }>}
 */
async function sendToken({ amount, token, to }) {
  const { ethers, provider, wallet } = loadWallet();

  // ── ETH ─────────────────────────────────────────────────────────────────
  if (token === 'eth') {
    const weiAmount = ethers.parseEther(String(amount));
    const balance   = await provider.getBalance(wallet.address);

    if (balance < weiAmount) {
      const have = parseFloat(ethers.formatEther(balance)).toFixed(6);
      throw new Error(
        `Saldo ETH tidak cukup.\nPunya: **${have} ETH** | Kirim: **${amount} ETH**`
      );
    }

    const feeData    = await provider.getFeeData();
    const gasPrice   = feeData.gasPrice || feeData.maxFeePerGas;
    const gasLimit   = 21000n;
    const gasCost    = gasPrice * gasLimit;
    const maxSendable = balance - gasCost;

    if (weiAmount > maxSendable) {
      const safeEth = parseFloat(ethers.formatEther(maxSendable)).toFixed(6);
      throw new Error(
        `Nominal terlalu besar setelah dipotong gas fee.\nMaksimal aman: **${safeEth} ETH**`
      );
    }

    const tx = await wallet.sendTransaction({ to, value: weiAmount, gasLimit });
    console.log(`[send] ETH TX sent: ${tx.hash}`);
    const receipt = await tx.wait(1);
    return {
      token: 'ETH',
      amount: String(amount),
      to,
      from: wallet.address,
      txHash: receipt.hash,
      txUrl: `https://basescan.org/tx/${receipt.hash}`,
      blockNumber: receipt.blockNumber,
    };
  }

  // ── USDC ─────────────────────────────────────────────────────────────────
  if (token === 'usdc') {
    // Bulatkan ke 6 desimal agar tidak overflow parseUnits
    const amountFixed = amount.toFixed(6);
    const units   = ethers.parseUnits(amountFixed, 6);
    const usdc    = new ethers.Contract(USDC_BASE, USDC_ABI, wallet);
    const balance = await usdc.balanceOf(wallet.address);

    if (balance < units) {
      const have = (Number(balance) / 1e6).toFixed(2);
      throw new Error(
        `Saldo USDC tidak cukup.\nPunya: **${have} USDC** | Kirim: **${amount} USDC**`
      );
    }

    const tx = await usdc.transfer(to, units);
    console.log(`[send] USDC TX sent: ${tx.hash}`);
    const receipt = await tx.wait(1);
    return {
      token: 'USDC',
      amount: (amount % 1 === 0) ? String(amount) : amount.toFixed(2).replace(/\.?0+$/, ''),
      to,
      from: wallet.address,
      txHash: receipt.hash,
      txUrl: `https://basescan.org/tx/${receipt.hash}`,
      blockNumber: receipt.blockNumber,
    };
  }

  throw new Error(`Token "${token}" tidak didukung. Gunakan: usdc atau eth`);
}

module.exports = { parseSendCommand, sendToken };
