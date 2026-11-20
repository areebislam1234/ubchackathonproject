// QuickNode Streams filter for StakeClash (Solana).
//
// Stream settings
//   Chain / network : Solana · Devnet
//   Dataset         : Block
//   Destination     : Webhook -> https://<your-game-server>/webhooks/quicknode
//   Security token  : copy into QUICKNODE_WEBHOOK_SECRET in .env
//
// Generate a copy with your addresses filled in: `npm run print-filter`.
// Keeps only successful transactions that involve the game authority or a StakeClash badge mint,
// and returns their game memos plus badge balance changes (mints, transfers between wallets).
// Transactions that call the StakeClash program also return its log lines, from which the game
// decodes the program's events (Gold, Might, stakes, abilities, battles).
//
// It also samples network activity: one block in every NETWORK_EVERY slots gets a small summary
// (transaction counts, failure rate, busiest programs, watched-token transfers) for the game's
// crypto intelligence reports. Every other block still returns nothing unless it has game events.

var AUTHORITY = "__AUTHORITY__";
var MINTS = __MINTS__;
var MEMO_RE = /Memo \(len \d+\): "(.*)"$/;
var WATCH_MINTS = __WATCH_MINTS__; // token mints whose transfers are counted in network samples
var DEPOSIT_MINT = "__DEPOSIT_MINT__"; // USDC: transfers into the authority's account are deposits
var NETWORK_EVERY = __NETWORK_EVERY__; // sample one block in this many slots
var VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";
var PROGRAM = "__PROGRAM__"; // the StakeClash on-chain program

function keyOf(k) {
  return typeof k === "string" ? k : k && k.pubkey;
}

/** A compact summary of one block's activity. */
function networkSample(block, slot) {
  var txs = block.transactions || [];
  var sample = { slot: slot, blockTime: block.blockTime || null, txCount: txs.length, failed: 0, vote: 0, programs: {}, transfers: {} };
  for (var t = 0; t < txs.length; t++) {
    var tx = txs[t];
    var meta = tx.meta || {};
    if (meta.err) sample.failed++;
    var msg = (tx.transaction && tx.transaction.message) || {};
    var keys = (msg.accountKeys || msg.staticAccountKeys || []).map(keyOf);
    var ixs = msg.instructions || [];
    var isVote = false;
    for (var x = 0; x < ixs.length; x++) {
      var ix = ixs[x] || {};
      var pid = ix.programId || (typeof ix.programIdIndex === "number" ? keys[ix.programIdIndex] : null);
      if (!pid) continue;
      if (pid === VOTE_PROGRAM) isVote = true;
      sample.programs[pid] = (sample.programs[pid] || 0) + 1;
    }
    if (isVote) sample.vote++;
    var pre = {};
    var bals = meta.preTokenBalances || [];
    for (var i = 0; i < bals.length; i++) if (WATCH_MINTS.indexOf(bals[i].mint) >= 0) pre[bals[i].accountIndex] = Number(bals[i].uiTokenAmount && bals[i].uiTokenAmount.uiAmount) || 0;
    var post = meta.postTokenBalances || [];
    for (var j = 0; j < post.length; j++) {
      var b = post[j];
      if (WATCH_MINTS.indexOf(b.mint) < 0) continue;
      var delta = (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0) - (pre[b.accountIndex] || 0);
      if (delta <= 0) continue;
      if (!sample.transfers[b.mint]) sample.transfers[b.mint] = { count: 0, amount: 0 };
      sample.transfers[b.mint].count++;
      sample.transfers[b.mint].amount += delta;
    }
  }
  // keep the five busiest programs, so the payload stays small
  var top = Object.keys(sample.programs)
    .sort(function (a, b) {
      return sample.programs[b] - sample.programs[a];
    })
    .slice(0, 5);
  var programs = {};
  for (var k = 0; k < top.length; k++) programs[top[k]] = sample.programs[top[k]];
  sample.programs = programs;
  return sample;
}

function main(stream) {
  var blocks = Array.isArray(stream.data) ? stream.data : [stream.data];
  var events = [];
  var network = [];
  for (var b = 0; b < blocks.length; b++) {
    var block = blocks[b];
    if (!block || !block.transactions) continue;
    var slot = block.slot != null ? block.slot : block.parentSlot != null ? block.parentSlot + 1 : stream.metadata && stream.metadata.batch_start_range;
    // blocks the local relay builds from single transactions are marked partial: never sample those
    if (!block.partial && NETWORK_EVERY > 0 && slot % NETWORK_EVERY === 0) network.push(networkSample(block, slot));
    for (var t = 0; t < block.transactions.length; t++) {
      var tx = block.transactions[t];
      var meta = tx.meta;
      if (!meta || meta.err) continue;
      var msg = tx.transaction && tx.transaction.message;
      if (!msg) continue;
      var keys = (msg.accountKeys || msg.staticAccountKeys || []).map(keyOf);
      var involved = keys.indexOf(AUTHORITY) >= 0;
      var callsProgram = PROGRAM && keys.indexOf(PROGRAM) >= 0;
      var changes = {};
      var lists = [["pre", meta.preTokenBalances || []], ["post", meta.postTokenBalances || []]];
      for (var l = 0; l < lists.length; l++) {
        var when = lists[l][0];
        var bals = lists[l][1];
        for (var i = 0; i < bals.length; i++) {
          var bal = bals[i];
          if (MINTS.indexOf(bal.mint) < 0) continue;
          var id = bal.mint + "|" + bal.owner;
          if (!changes[id]) changes[id] = { mint: bal.mint, owner: bal.owner, pre: 0, post: 0 };
          changes[id][when] = Number(bal.uiTokenAmount && bal.uiTokenAmount.amount) || 0;
        }
      }
      var badgeChanges = Object.keys(changes).map(function (k) {
        return changes[k];
      });
      // USDC deposits: the authority's USDC goes up; the sender is the owner whose USDC went down
      var deposits = [];
      if (DEPOSIT_MINT) {
        var usdc = {};
        var pairs = [["pre", meta.preTokenBalances || []], ["post", meta.postTokenBalances || []]];
        for (var u = 0; u < pairs.length; u++)
          for (var v = 0; v < pairs[u][1].length; v++) {
            var tb = pairs[u][1][v];
            if (tb.mint !== DEPOSIT_MINT || !tb.owner) continue;
            if (!usdc[tb.owner]) usdc[tb.owner] = { pre: 0, post: 0 };
            usdc[tb.owner][pairs[u][0]] += Number(tb.uiTokenAmount && tb.uiTokenAmount.amount) || 0;
          }
        var into = usdc[AUTHORITY] ? usdc[AUTHORITY].post - usdc[AUTHORITY].pre : 0;
        if (into > 0) {
          var from = null;
          var drop = 0;
          for (var o in usdc)
            if (o !== AUTHORITY && usdc[o].pre - usdc[o].post > drop) {
              drop = usdc[o].pre - usdc[o].post;
              from = o;
            }
          // the transaction's accounts, so a Solana Pay reference key can match the deposit to a player
          deposits.push({ from: from, amount: into, keys: keys.slice(0, 16) });
        }
      }
      if (!involved && !callsProgram && !badgeChanges.length && !deposits.length) continue;
      // Memo text shows up as `Memo (len N): "text"`, as its own log line, or (jsonParsed) as a
      // parsed spl-memo instruction, depending on the memo program version and encoding.
      var memos = [];
      var addMemo = function (text) {
        if (typeof text === "string" && text.indexOf("stakeclash:") === 0 && memos.indexOf(text) < 0) memos.push(text);
      };
      var logs = meta.logMessages || [];
      for (var j = 0; j < logs.length; j++) {
        var m = MEMO_RE.exec(logs[j]);
        if (m) addMemo(m[1]);
        else if (logs[j].indexOf("Program log: stakeclash:") === 0) addMemo(logs[j].slice(13));
      }
      var ixs = msg.instructions || [];
      for (var x = 0; x < ixs.length; x++) if (ixs[x] && ixs[x].program === "spl-memo") addMemo(ixs[x].parsed);
      // program events: keep only the invoke/success/data lines the decoder needs
      var programLogs = [];
      if (callsProgram)
        for (var pl = 0; pl < logs.length; pl++) {
          var line = logs[pl];
          if (line.indexOf("Program data: ") === 0 || / invoke \[\d+\]$/.test(line) || / (success|failed)/.test(line)) programLogs.push(line);
        }
      if (!memos.length && !badgeChanges.length && !deposits.length && !programLogs.length) continue;
      var ev = { signature: tx.transaction.signatures[0], slot: slot, blockTime: block.blockTime || null, memos: memos, badges: badgeChanges };
      if (deposits.length) ev.deposits = deposits;
      if (programLogs.length) ev.programLogs = programLogs;
      events.push(ev);
    }
  }
  if (!events.length && !network.length) return null;
  var out = { events: events };
  if (network.length) out.network = network;
  return out;
}
