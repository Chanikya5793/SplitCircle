# SplitCircle Architecture DNA

> **For AI Agents**: This document explains the core architecture principles. Read this first before making changes.

## Core Philosophy

SplitCircle follows a **local-first, privacy-focused** architecture inspired by WhatsApp:

| Principle | Implementation |
|-----------|----------------|
| **Local-first** | Messages & call history stored on device, not server |
| **Ephemeral transit** | Data deleted from server after delivery |
| **Privacy by design** | Server never has permanent access to content |

---

## Three-Tier Storage

| Tier | Technology | Purpose | Lifetime |
|------|------------|---------|----------|
| **Transit** | Firebase Realtime DB | Message queue, call signaling | Until delivered, then **deleted** |
| **Local** | AsyncStorage | Messages, call history, media | Permanent on device |
| **Persistent** | Firestore | Metadata (profiles, groups, threads) | Permanent on server |

---

## Message Flow

```
SEND:
1. Save to LOCAL AsyncStorage (immediate display)
2. Queue to Realtime DB (messageQueue/{recipientId}/{messageId})
3. Status: 'sent'

RECEIVE:
1. Detect in Realtime DB queue
2. Download media → save to local filesystem
3. Save to LOCAL AsyncStorage
4. Send delivery receipt
5. DELETE from Realtime DB ← KEY STEP
6. Status: 'delivered'
```

---

## Call Flow

```
START CALL:
1. Create signaling in Realtime DB (calls/{callId})
2. Fetch LiveKit token
3. Connect to LiveKit room

END CALL:
1. Save call history to LOCAL AsyncStorage
2. DELETE signaling from Realtime DB ← NO ACCUMULATION
3. Disconnect from LiveKit
```

---

## Key Services

| Service | Database | Purpose |
|---------|----------|---------|
| `localMessageStorage.ts` | AsyncStorage | Permanent message storage |
| `messageQueueService.ts` | Realtime DB | Temporary message queue |
| `localCallStorage.ts` | AsyncStorage | Local call history |
| `callService.ts` | Realtime DB | Ephemeral call signaling |
| `LiveKitService.ts` | External | Audio/video handling |

---

## Firestore Collections (Persistent Only)

| Collection | Purpose |
|------------|---------|
| `users` | User profiles |
| `groups` | Group metadata |
| `chats` | Chat thread metadata |
| `expenses` | Expense tracking |
| `recurringBills` | Bill reminders |

> ⚠️ **Never store ephemeral data (messages, calls) in Firestore**

---

## Tech Stack

- **Framework**: React Native + Expo
- **Navigation**: React Navigation
- **State**: React Context
- **Local Storage**: AsyncStorage
- **Ephemeral Queue**: Firebase Realtime Database
- **Persistent Data**: Firebase Firestore
- **Media Storage**: Firebase Storage
- **Auth**: Firebase Auth
- **Video/Audio**: LiveKit
- **UI**: React Native Paper + Custom Components


/* a safe view option with safety pin in chats to just stalk the chatd like kinda incognito so we wont send any read receipts and also diable sending any kind of messages */