// lib/shuffle.js
// Integrasi bot.js ↔ DiscordShuffle smart contract di Base Mainnet
//
// Contract: 0xfABe5E941887b490eF6FaC127FD16553656f25aE (Base)
// Env vars di Railway:
//   BOT_PRIVATE_KEY   — private key wallet bot
//   BASE_RPC_URL      — (opsional) custom RPC, default: https://mainnet.base.org
//
// [FIX] ethers di-require secara lazy (di dalam fungsi, bukan di top-level)
// sehingga bot tidak crash saat startup jika ethers belum terinstall.
// Error hanya muncul saat !shuffle benar-benar dipanggil.

const CONTRACT_ADDRESS = process.env.SHUFFLE_CONTRACT
  || '0xfABe5E941887b490eF6FaC127FD16553656f25aE';

const ABI = [
  'event WinnerPicked(uint256 indexed raffleId, string guildId, string roleName, uint256 participantCount, uint256 winnerIndex, bytes32 entropy, uint256 timestamp)',
  'function raffleCount() view returns (uint256)',
  'function pickWinner(uint256 participantCount, string guildId, string roleName) returns (uint256 winnerIndex)',
];

let _contract = null;
let _wallet   = null;
let _ethers   = null;

// Lazy-load ethers — hanya diload saat pertama kali !shuffle dipanggil
function loadEthers() {
  if (_ethers) return _ethers;
  try {
    _ethers = require('ethers');
    return _ethers;
  } catch (e) {
    throw new Error(
      '❌ Package "ethers" belum terinstall di Railway.\n' +
      'Solusi: Tambahkan variabel env INSTALL_ETHERS=1 atau jalankan `npm install ethers` di Railway.\n' +
      'Detail: ' + e.message
    );
  }
}

function getContract() {
  if (_contract) return _contract;

  const ethers = loadEthers();
  const pk  = process.env.BOT_PRIVATE_KEY;
  const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  if (!pk) throw new Error('BOT_PRIVATE_KEY tidak diset di env Railway!');

  const provider = new ethers.JsonRpcProvider(rpc);
  _wallet   = new ethers.Wallet(pk, provider);
  _contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, _wallet);

  console.log(`[shuffle] ✅ Wallet: ${_wallet.address} | Contract: ${CONTRACT_ADDRESS}`);
  return _contract;
}

/**
 * Pilih pemenang secara on-chain via DiscordShuffle contract.
 */
async function pickWinnerOnChain(participants, guildId, roleName) {
  if (!participants || participants.length === 0) {
    throw new Error('Tidak ada peserta untuk diundi');
  }

  const contract = getContract();

  const gasEstimate = await contract.pickWinner.estimateGas(
    participants.length, guildId, roleName
  );

  const tx = await contract.pickWinner(
    participants.length,
    guildId,
    roleName,
    { gasLimit: gasEstimate * 120n / 100n }
  );
  console.log(`[shuffle] TX dikirim: ${tx.hash}`);

  const receipt = await tx.wait(1);
  console.log(`[shuffle] TX confirmed block #${receipt.blockNumber}`);

  let winnerIndex = null;
  let raffleId    = null;

  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === 'WinnerPicked') {
        winnerIndex = Number(parsed.args.winnerIndex);
        raffleId    = Number(parsed.args.raffleId);
        break;
      }
    } catch { /* skip log dari contract lain */ }
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

function isShuffleConfigured() {
  return !!process.env.BOT_PRIVATE_KEY;
}

async function getWalletInfo() {
  const ethers   = loadEthers();
  const contract = getContract();
  const balance  = await _wallet.provider.getBalance(_wallet.address);
  const raffleCount = await contract.raffleCount();

  return {
    address:      _wallet.address,
    balanceEth:   parseFloat(ethers.formatEther(balance)).toFixed(6),
    contractAddr: CONTRACT_ADDRESS,
    raffleCount:  Number(raffleCount),
    explorerUrl:  `https://basescan.org/address/${_wallet.address}`,
    network:      'Base Mainnet',
  };
}

module.exports = { pickWinnerOnChain, isShuffleConfigured, getWalletInfo };
