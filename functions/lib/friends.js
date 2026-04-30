"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.touchFriendInteraction = exports.materializeDebtFriendships = exports.materializeGroupFriendships = exports.materializeMutualFriendship = void 0;
const database_1 = require("firebase-admin/database");
const logger = __importStar(require("firebase-functions/logger"));
const FRIENDS_PATH = "friends";
const sourceRank = {
    // Higher rank "wins" on collision so we never silently downgrade a debt
    // friendship to a group friendship — it would obscure that there's still
    // money between them. `manual` is the strongest because the user
    // explicitly chose it.
    group: 1,
    debt: 2,
    manual: 3,
};
const writeFriendEntry = async (ownerUid, friendUid, next) => {
    if (!ownerUid || !friendUid || ownerUid === friendUid)
        return;
    const ref = (0, database_1.getDatabase)().ref(`${FRIENDS_PATH}/${ownerUid}/${friendUid}`);
    await ref.transaction((current) => {
        var _a, _b, _c, _d, _e;
        if (!current)
            return next;
        const incomingRank = (_a = sourceRank[next.source]) !== null && _a !== void 0 ? _a : 0;
        const existingRank = (_b = sourceRank[current.source]) !== null && _b !== void 0 ? _b : 0;
        const winningSource = incomingRank >= existingRank ? next.source : current.source;
        return {
            source: winningSource,
            since: Math.min((_c = current.since) !== null && _c !== void 0 ? _c : next.since, next.since),
            lastInteractionAt: Math.max((_d = current.lastInteractionAt) !== null && _d !== void 0 ? _d : 0, (_e = next.lastInteractionAt) !== null && _e !== void 0 ? _e : next.since),
        };
    });
};
/**
 * Add a mutual friendship between two users — both /friends/A/B and /friends/B/A
 * are written by the admin SDK in parallel. Idempotent and source-aware.
 */
const materializeMutualFriendship = async (uidA, uidB, source) => {
    if (!uidA || !uidB || uidA === uidB)
        return;
    const now = Date.now();
    const entry = { source, since: now, lastInteractionAt: now };
    await Promise.all([
        writeFriendEntry(uidA, uidB, entry),
        writeFriendEntry(uidB, uidA, entry),
    ]);
};
exports.materializeMutualFriendship = materializeMutualFriendship;
/**
 * For every pair in the given member set, ensure a `group` friendship exists.
 * Pair count is O(n²) but groups are bounded (~tens of members). Single RTDB
 * round-trip per directed edge via transaction.
 */
const materializeGroupFriendships = async (memberIds) => {
    const unique = Array.from(new Set(memberIds.filter((id) => typeof id === "string" && id.length > 0)));
    if (unique.length < 2)
        return;
    const writes = [];
    for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
            writes.push((0, exports.materializeMutualFriendship)(unique[i], unique[j], "group"));
        }
    }
    try {
        await Promise.all(writes);
    }
    catch (error) {
        logger.warn("friends: materializeGroupFriendships partial failure", {
            error: error instanceof Error ? error.message : String(error),
            memberCount: unique.length,
        });
    }
};
exports.materializeGroupFriendships = materializeGroupFriendships;
/**
 * The payer + each split-participant on an expense gets a mutual `debt`
 * friendship. Use this from your expense / settlement create triggers.
 */
const materializeDebtFriendships = async (payerUid, counterpartyUids) => {
    if (!payerUid)
        return;
    const counterparties = Array.from(new Set(counterpartyUids.filter((id) => typeof id === "string" && id.length > 0 && id !== payerUid)));
    try {
        await Promise.all(counterparties.map((uid) => (0, exports.materializeMutualFriendship)(payerUid, uid, "debt")));
    }
    catch (error) {
        logger.warn("friends: materializeDebtFriendships partial failure", {
            error: error instanceof Error ? error.message : String(error),
            payerUid,
            counterpartyCount: counterparties.length,
        });
    }
};
exports.materializeDebtFriendships = materializeDebtFriendships;
/**
 * Bump `lastInteractionAt` on an existing friendship (use after settlements,
 * messages, calls). Best-effort — does not create a friendship if missing.
 */
const touchFriendInteraction = async (uidA, uidB) => {
    if (!uidA || !uidB || uidA === uidB)
        return;
    const now = Date.now();
    const updates = {
        [`${FRIENDS_PATH}/${uidA}/${uidB}/lastInteractionAt`]: now,
        [`${FRIENDS_PATH}/${uidB}/${uidA}/lastInteractionAt`]: now,
    };
    try {
        await (0, database_1.getDatabase)().ref().update(updates);
    }
    catch (error) {
        // Ignore — entry might not exist yet, or write was racing a delete.
    }
};
exports.touchFriendInteraction = touchFriendInteraction;
//# sourceMappingURL=friends.js.map