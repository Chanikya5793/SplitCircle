#!/usr/bin/env node
// Seeds the local Firebase emulators (scripts/emulators.sh) with a realistic,
// disposable account so every screen has something to render.
//
//   npm run emulators            # terminal 1
//   node scripts/seed-emulator.mjs   # terminal 2 (idempotent; re-run to reset)
//
// Sign in on the simulator as the primary account below. These credentials
// exist ONLY in the local auth emulator (project `demo-manasplit`).
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_DATABASE_EMULATOR_HOST ??= '127.0.0.1:9000';
process.env.GCLOUD_PROJECT = 'demo-manasplit';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');

export const EMULATOR_TEST_PASSWORD = 'emulator-only-pass-7319';

const app = initializeApp({
  projectId: 'demo-manasplit',
  databaseURL: 'http://127.0.0.1:9000?ns=demo-manasplit',
});
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);

const PEOPLE = [
  { key: 'me', email: 'tester@manasplit.test', displayName: 'Taylor Tester' },
  { key: 'priya', email: 'priya@manasplit.test', displayName: 'Priya Sharma' },
  { key: 'arjun', email: 'arjun@manasplit.test', displayName: 'Arjun Mehta' },
  { key: 'maya', email: 'maya@manasplit.test', displayName: 'Maya Chen' },
  { key: 'leo', email: 'leo@manasplit.test', displayName: 'Leo García' },
  // Deliberately long, to catch truncation and wrapping bugs.
  { key: 'alex', email: 'alex@manasplit.test', displayName: 'Alexandria Montgomery-Fitzgerald' },
];

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const preferences = {
  pushEnabled: false,
  emailEnabled: true,
  messages: true,
  expenses: true,
  settlements: true,
  groupUpdates: true,
  calls: true,
  sounds: true,
  vibration: true,
};

async function upsertUser(person) {
  let record;
  try {
    record = await auth.getUserByEmail(person.email);
  } catch {
    record = await auth.createUser({
      email: person.email,
      password: EMULATOR_TEST_PASSWORD,
      displayName: person.displayName,
      emailVerified: true,
    });
  }
  return { ...person, uid: record.uid };
}

function member(person, role = 'member') {
  return { userId: person.uid, displayName: person.displayName, photoURL: null, role, balance: 0 };
}

function equalShares(amount, people) {
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / people.length);
  let remainder = cents - base * people.length;
  return people.map((p) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { userId: p.uid, share: (base + extra) / 100 };
  });
}

function expense(groupId, { title, category, amount, paidBy, among, daysAgo, notes }) {
  const expenseId = randomUUID();
  const createdAt = now - daysAgo * DAY;
  return {
    expenseId,
    revision: 1,
    requestId: expenseId,
    groupId,
    title,
    category,
    amount,
    paidBy: paidBy.uid,
    splitType: 'equal',
    participants: equalShares(amount, among),
    settled: false,
    ...(notes ? { notes } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

async function writeGroup({ name, currency, owner, members, expenses, settlements = [], daysAgo }) {
  const groupId = randomUUID();
  const createdAt = now - daysAgo * DAY;
  const builtExpenses = expenses.map((spec) => expense(groupId, spec));
  const group = {
    groupId,
    requestId: groupId,
    name,
    currency,
    inviteCode: groupId.slice(0, 6).toUpperCase(),
    members: members.map((p) => member(p, p.uid === owner.uid ? 'owner' : 'member')),
    memberIds: members.map((p) => p.uid),
    archivedMembers: [],
    expenses: builtExpenses,
    settlements: settlements.map((s) => ({
      settlementId: randomUUID(),
      revision: 1,
      fromUserId: s.from.uid,
      toUserId: s.to.uid,
      amount: s.amount,
      createdAt: now - s.daysAgo * DAY,
      status: 'completed',
    })),
    createdBy: owner.uid,
    createdAt,
    updatedAt: now,
  };
  const batch = db.batch();
  batch.set(db.collection('groups').doc(groupId), group);
  for (const item of builtExpenses) batch.set(db.collection('expenses').doc(item.expenseId), item);
  const chatId = randomUUID();
  batch.set(db.collection('chats').doc(chatId), {
    chatId,
    type: 'group',
    groupId,
    participants: members.map((p) => ({
      userId: p.uid, displayName: p.displayName, photoURL: null, status: 'offline',
    })),
    participantIds: members.map((p) => p.uid),
    unreadCount: 0,
    createdAt,
    updatedAt: now - 2 * 60 * 60 * 1000,
  });
  await batch.commit();
  return { groupId, chatId, name };
}

async function wipe() {
  for (const collection of ['groups', 'expenses', 'chats', 'users', 'pairedDevices']) {
    const snapshot = await db.collection(collection).get();
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    if (!snapshot.empty) await batch.commit();
  }
  await rtdb.ref('friends').remove();
}

async function main() {
  await wipe();
  const people = Object.fromEntries(
    await Promise.all(PEOPLE.map(async (p) => [p.key, await upsertUser(p)])),
  );
  const { me, priya, arjun, maya, leo, alex } = people;

  const goa = await writeGroup({
    name: 'Goa Trip 2026',
    currency: 'INR',
    owner: me,
    members: [me, priya, arjun, maya],
    daysAgo: 40,
    expenses: [
      { title: 'Villa booking', category: 'Travel', amount: 48000, paidBy: me, among: [me, priya, arjun, maya], daysAgo: 30 },
      { title: 'Flights BOM → GOI', category: 'Travel', amount: 26400, paidBy: priya, among: [me, priya, arjun, maya], daysAgo: 29 },
      { title: 'Seafood dinner at Fisherman’s Wharf', category: 'Food', amount: 6850, paidBy: arjun, among: [me, priya, arjun, maya], daysAgo: 21 },
      { title: 'Scooter rental (3 days)', category: 'Transport', amount: 3600, paidBy: maya, among: [me, maya], daysAgo: 20 },
      { title: 'Groceries', category: 'Shopping', amount: 2240, paidBy: me, among: [me, priya, arjun, maya], daysAgo: 19 },
      { title: 'Parasailing', category: 'Entertainment', amount: 9000, paidBy: priya, among: [priya, arjun, maya], daysAgo: 18, notes: 'Taylor skipped this one' },
      { title: 'Taxi to airport', category: 'Transport', amount: 1800, paidBy: arjun, among: [me, priya, arjun, maya], daysAgo: 17 },
      { title: 'Pharmacy', category: 'Health', amount: 640, paidBy: maya, among: [maya, me], daysAgo: 16 },
    ],
    settlements: [{ from: maya, to: me, amount: 5000, daysAgo: 10 }],
  });

  const flat = await writeGroup({
    name: 'Apartment 4B',
    currency: 'USD',
    owner: me,
    members: [me, leo, alex],
    daysAgo: 120,
    expenses: [
      { title: 'October rent', category: 'Rent', amount: 3150, paidBy: me, among: [me, leo, alex], daysAgo: 8 },
      { title: 'Electricity', category: 'Utilities', amount: 142.37, paidBy: leo, among: [me, leo, alex], daysAgo: 6 },
      { title: 'Internet', category: 'Utilities', amount: 79.99, paidBy: alex, among: [me, leo, alex], daysAgo: 5 },
      { title: 'Cleaning supplies', category: 'Shopping', amount: 38.5, paidBy: me, among: [me, leo, alex], daysAgo: 3 },
      { title: 'Streaming bundle', category: 'Subscriptions', amount: 22.99, paidBy: leo, among: [me, leo, alex], daysAgo: 2 },
      { title: 'September rent', category: 'Rent', amount: 3150, paidBy: alex, among: [me, leo, alex], daysAgo: 38 },
      { title: 'Water bill', category: 'Utilities', amount: 61.2, paidBy: me, among: [me, leo, alex], daysAgo: 35 },
    ],
  });

  const brunch = await writeGroup({
    name: 'Sunday Brunch Club & Occasional Karaoke Night Crew',
    currency: 'USD',
    owner: priya,
    members: [priya, me, arjun, maya, leo, alex],
    daysAgo: 60,
    expenses: [
      { title: 'Brunch at The Daily Grind', category: 'Food', amount: 186.4, paidBy: priya, among: [priya, me, arjun, maya, leo, alex], daysAgo: 14 },
      { title: 'Karaoke room (2 hrs)', category: 'Entertainment', amount: 120, paidBy: me, among: [priya, me, arjun, maya, leo, alex], daysAgo: 13 },
      { title: 'Uber XL home', category: 'Transport', amount: 47.85, paidBy: leo, among: [me, leo, alex], daysAgo: 13 },
      { title: 'Birthday cake for Maya', category: 'Food', amount: 64, paidBy: arjun, among: [priya, me, arjun, leo, alex], daysAgo: 4 },
    ],
  });

  const userDocs = db.batch();
  for (const person of Object.values(people)) {
    const memberOf = [goa, flat, brunch].filter((g) => {
      if (g === goa) return [me, priya, arjun, maya].includes(person);
      if (g === flat) return [me, leo, alex].includes(person);
      return true;
    });
    userDocs.set(db.collection('users').doc(person.uid), {
      userId: person.uid,
      email: person.email,
      displayName: person.displayName,
      photoURL: null,
      groups: memberOf.map((g) => ({ groupId: g.groupId, name: g.name, lastActive: now })),
      status: 'offline',
      createdAt: now - 200 * DAY,
      updatedAt: now,
      preferences,
    });
  }
  await userDocs.commit();

  for (const friend of [priya, arjun, maya, leo, alex]) {
    await rtdb.ref(`friends/${me.uid}/${friend.uid}`).set({
      source: 'group',
      since: now - 30 * DAY,
      displayName: friend.displayName,
    });
  }

  console.log(JSON.stringify({
    signIn: { email: me.email, password: EMULATOR_TEST_PASSWORD },
    uids: Object.fromEntries(Object.entries(people).map(([k, p]) => [k, p.uid])),
    groups: [goa, flat, brunch],
  }, null, 2));
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
