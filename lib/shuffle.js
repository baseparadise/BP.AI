// lib/shuffle.js
// Integrasi bot.js ↔ DiscordShuffle smart contract di Base Mainnet
//
// Contract: 0xfABe5E941887b490eF6FaC127FD16553656f25aE (Base)
// Env vars di Railway:
//   BOT_PRIVATE_KEY   — private key wallet bot (jangan commit ke git!)
//   BASE_RPC_URL      — (opsional) custom RPC, default: https://mainnet.base.org

const { ethers } = require('ethers');

const CONTRACT_ADDRESS = process.env.SHUFFLE_CONTRACT
  || '0xfABe5E941887b490eF6FaC127FD16553656f25aE';

const ABI = [
  'event WinnerPicked(uint256 indexed raffleId, string guildId, string roleName, uint256 participantCount, uint256 winnerIndex, bytes32 entropy, uint256 timestamp)',
  'function raffleCount() view returns (uint256)',
  'function pickWinner(uint256 participantCount, string guildId, string roleName) returns (uint256 winnerIndex)',
];

let _contract = null;
let _wallet   = null;

function getContract() {
  if (_contract) return _contract;

  const pk  = process.env.BOT_PRIVATE_KEY;
  const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  if (!pk) throw new Error('BOT_PRIVATE_KEY tidak diset di env Railway!');

  const provider = new ethers.JsonRpcProvider(rpc);
  _wallet   = new ethers.Wallet(pk, provider);
  _contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, _wallet);

  console.log(`[shuffle] Wallet: ${_wallet.address} | Contract: ${CONTRACT_ADDRESS} | RPC: ${rpc}`);
  return _contract;
}

/**
 * Panggil smart contract DiscordShuffle untuk memilih pemenang secara on-chain.
 *
 * @param {string[]} participants  Array Discord username peserta
 * @param {string}   guildId      Discord Guild ID (audit trail di blockchain)
 * @param {string}   roleName     Nama role yang diundi
 * @returns {Promise<{winner, winnerIndex, raffleId, txHash, txUrl, contractUrl, blockNumber}>}
 */
async function pickWinnerOnChain(participants, guildId, roleName) {
  if (!participants || participants.length === 0) {
    throw new Error('Tidak ada peserta untuk diundi');
  }

  const contract = getContract();

  // Estimate gas dulu, tangkap error lebih awal
  const gasEstimate = await contract.pickWinner.estimateGas(
    participants.length, guildId, roleName
  );
  console.log(`[shuffle] pickWinner: count=${participants.length} gasEstimate=${gasEstimate}`);

  // Kirim transaksi ke Base
  const tx = await contract.pickWinner(
    participants.length,
    guildId,
    roleName,
    { gasLimit: gasEstimate * 120n / 100n } // +20% buffer
  );
  console.log(`[shuffle] TX dikirim: ${tx.hash}`);

  const receipt = await tx.wait(1); // tunggu 1 konfirmasi
  console.log(`[shuffle] TX confirmed block #${receipt.blockNumber}`);

  // Parse event WinnerPicked dari receipt
  let winnerIndex = null;
  let raffleId    = null;

  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({
        topics: log.topics,
        data:   log.data,
      });
      if (parsed && parsed.name === 'WinnerPicked') {
        winnerIndex = Number(parsed.args.winnerIndex);
        raffleId    = Number(parsed.args.raffleId);
        break;
      }
    } catch {
      // skip log yang tidak bisa di-parse (logs dari contract lain)
    }
  }

  if (winnerIndex === null) {
    throw new Error(`WinnerPicked event tidak ditemukan di receipt (TX: ${receipt.hash})`);
  }

  return {
    winner:      participants[winnerIndex],
    winnerIndex,
    raffleId,
    txHash:      receipt.hash,
    txUrl:       `https://basescan.org/tx/${receipt.hash}`,
    contractUrl: `https://basescan.org/address/${CONTRACT_ADDRESS}`,
    blockNumber: receipt.blockNumber,
  };
}

/**
 * Cek apakah shuffle sudah dikonfigurasi (BOT_PRIVATE_KEY diset)
 */
function isShuffleConfigured() {
  return !!process.env.BOT_PRIVATE_KEY;
}

/**
 * Info wallet bot: address + ETH balance di Base
 */
async function getWalletInfo() {
  const contract = getContract();
  const provider = _wallet.provider;
  const address  = _wallet.address;
  const balance  = await provider.getBalance(address);
  const raffleCount = await contract.raffleCount();

  return {
    address,
    balanceEth:   parseFloat(ethers.formatEther(balance)).toFixed(6),
    contractAddr: CONTRACT_ADDRESS,
    raffleCount:  Number(raffleCount),
    explorerUrl:  `https://basescan.org/address/${address}`,
    network:      'Base Mainnet',
  };
}

module.exports = { pickWinnerOnChain, isShuffleConfigured, getWalletInfo };
