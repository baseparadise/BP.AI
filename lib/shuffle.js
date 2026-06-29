// lib/shuffle.js — DiscordShuffle v2
// Contract v2 menerima array peserta langsung + emit nama pemenang on-chain.
// Update SHUFFLE_CONTRACT di Railway ke address contract v2 setelah deploy.

const CONTRACT_ADDRESS = process.env.SHUFFLE_CONTRACT
  || '0x2E990da09C7837dcFbfF5F34FdF07BcD7a63B977'; // DiscordShuffle v2 — Base Mainnet

const ABI = [
  // v2: pickWinner menerima string[] participants (bukan uint256 count)
  'function pickWinner(string[] calldata participants, string guildId, string roleName) external returns (uint256 winnerIndex)',
  'function raffleCount() view returns (uint256)',
  'function getRaffle(uint256 raffleId) view returns (tuple(uint256 raffleId, string guildId, string roleName, string winnerName, uint256 winnerIndex, uint256 participantCount, bytes32 entropy, uint256 timestamp, bytes32 participantsHash))',
  'function verifyParticipants(uint256 raffleId, string[] calldata participants) view returns (bool)',
  // v2 event — participants[] + winnerName langsung tersimpan on-chain
  'event WinnerPicked(uint256 indexed raffleId, string guildId, string roleName, string[] participants, uint256 winnerIndex, string winnerName, bytes32 entropy, uint256 timestamp)',
];

let _contract = null;
let _wallet   = null;
let _ethers   = null;

function loadEthers() {
  if (_ethers) return _ethers;
  try {
    _ethers = require('ethers');
    return _ethers;
  } catch (e) {
    throw new Error(
      '❌ Package "ethers" belum terinstall.\n' +
      'Solusi: jalankan `npm install ethers` di Railway.\nDetail: ' + e.message
    );
  }
}

function getContract() {
  if (_contract) return _contract;
  const ethers = loadEthers();
  const pk  = process.env.BOT_PRIVATE_KEY;
  const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  if (!pk) throw new Error('BOT_PRIVATE_KEY tidak diset di Railway!');
  const provider = new ethers.JsonRpcProvider(rpc);
  _wallet   = new ethers.Wallet(pk, provider);
  _contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, _wallet);
  console.log(`[shuffle] ✅ Wallet: ${_wallet.address} | Contract v2: ${CONTRACT_ADDRESS}`);
  return _contract;
}

/**
 * Pilih pemenang secara on-chain.
 * Contract v2 menerima seluruh array peserta — nama pemenang tersimpan on-chain
 * dan langsung terbaca di Basescan tanpa decoding manual.
 */
async function pickWinnerOnChain(participants, guildId, roleName) {
  if (!participants || participants.length === 0) {
    throw new Error('Tidak ada peserta untuk diundi');
  }

  const contract = getContract();

  const gasEstimate = await contract.pickWinner.estimateGas(
    participants, guildId, roleName
  );

  const tx = await contract.pickWinner(
    participants,
    guildId,
    roleName,
    { gasLimit: gasEstimate * 130n / 100n } // +30% buffer (array calldata lebih besar)
  );
  console.log(`[shuffle] TX dikirim: ${tx.hash}`);

  const receipt = await tx.wait(1);
  console.log(`[shuffle] TX confirmed block #${receipt.blockNumber}`);

  let winnerIndex = null;
  let winnerName  = null;
  let raffleId    = null;

  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === 'WinnerPicked') {
        winnerIndex = Number(parsed.args.winnerIndex);
        winnerName  = parsed.args.winnerName;   // langsung dari event
        raffleId    = Number(parsed.args.raffleId);
        break;
      }
    } catch { /* skip log dari contract lain */ }
  }

  if (winnerIndex === null) {
    throw new Error(`WinnerPicked event tidak ditemukan di receipt (TX: ${receipt.hash})`);
  }

  return {
    winner:      winnerName || participants[winnerIndex],
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
