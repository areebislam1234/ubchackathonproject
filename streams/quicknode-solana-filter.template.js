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

var AUTHORITY = "__AUTHORITY__";
var MINTS = __MINTS__;
var MEMO_RE = /Memo \(len \d+\): "(.*)"$/;

function keyOf(k) {
  return typeof k === "string" ? k : k && k.pubkey;
}

function main(stream) {
  var blocks = Array.isArray(stream.data) ? stream.data : [stream.data];
  var events = [];
  for (var b = 0; b < blocks.length; b++) {
    var block = blocks[b];
    if (!block || !block.transactions) continue;
    var slot = block.slot != null ? block.slot : block.parentSlot != null ? block.parentSlot + 1 : stream.metadata && stream.metadata.batch_start_range;
    for (var t = 0; t < block.transactions.length; t++) {
      var tx = block.transactions[t];
      var meta = tx.meta;
      if (!meta || meta.err) continue;
      var msg = tx.transaction && tx.transaction.message;
      if (!msg) continue;
      var keys = (msg.accountKeys || msg.staticAccountKeys || []).map(keyOf);
      var involved = keys.indexOf(AUTHORITY) >= 0;
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
      if (!involved && !badgeChanges.length) continue;
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
      if (!memos.length && !badgeChanges.length) continue;
      events.push({ signature: tx.transaction.signatures[0], slot: slot, blockTime: block.blockTime || null, memos: memos, badges: badgeChanges });
    }
  }
  return events.length ? { events: events } : null;
}
