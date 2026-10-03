import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
    type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { ref, remove, set, update } from "firebase/database";
import { afterAll, beforeAll, describe, it } from "vitest";

const emulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;

describeWithEmulator("Realtime Database authorization", () => {
    let environment: RulesTestEnvironment;

    beforeAll(async () => {
        environment = await initializeTestEnvironment({
            projectId: "manasplit-rtdb-rules-test",
            database: {
                rules: readFileSync(resolve(__dirname, "../../database.rules.json"), "utf8"),
            },
        });
        await environment.withSecurityRulesDisabled(async (context) => {
            await set(ref(context.database()), {
                chatMembers: { "chat-1": { alice: true, bob: true } },
                messageQueue: {
                    bob: {
                        existing: {
                            senderId: "alice",
                            chatId: "chat-1",
                            content: "",
                            timestamp: 1,
                            type: "text",
                            isGroupChat: false,
                        },
                    },
                },
                calls: {
                    "call-1": {
                        callId: "call-1",
                        chatId: "chat-1",
                        initiatorId: "alice",
                        participants: { 0: { userId: "alice" } },
                        participantIds: { alice: true },
                        allowedUserIds: { alice: true, bob: true },
                        type: "audio",
                        status: "ringing",
                        startedAt: 1,
                    },
                },
            });
        });
    });

    afterAll(async () => environment.cleanup());

    it("denies direct client creation in another user's message queue", async () => {
        const database = environment.authenticatedContext("alice").database();
        await assertFails(set(ref(database, "messageQueue/bob/new-message"), {
            senderId: "alice",
            chatId: "chat-1",
            content: "hello",
            timestamp: 2,
            type: "text",
            isGroupChat: false,
        }));
    });

    it("allows a recipient to delete an existing delivered queue item", async () => {
        const database = environment.authenticatedContext("bob").database();
        await assertSucceeds(remove(ref(database, "messageQueue/bob/existing")));
    });

    it("binds typing presence to server-materialized chat membership", async () => {
        const alice = environment.authenticatedContext("alice").database();
        const mallory = environment.authenticatedContext("mallory").database();
        await assertSucceeds(set(ref(alice, "typing/chat-1/alice"), Date.now()));
        await assertFails(set(ref(mallory, "typing/chat-1/mallory"), Date.now()));
    });

    it("denies all direct call creation and mutation", async () => {
        const alice = environment.authenticatedContext("alice").database();
        await assertFails(set(ref(alice, "calls/forged"), {
            callId: "forged",
            chatId: "chat-1",
            initiatorId: "alice",
            participants: { 0: { userId: "alice" } },
            participantIds: { alice: true },
            allowedUserIds: { alice: true, mallory: true },
            type: "audio",
            status: "ringing",
            startedAt: 2,
        }));
        await assertFails(update(ref(alice, "calls/call-1"), { status: "connected" }));
    });
});
