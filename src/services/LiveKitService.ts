import { getAuth } from 'firebase/auth';

const TOKEN_ENDPOINT = process.env.EXPO_PUBLIC_LIVEKIT_TOKEN_ENDPOINT || 'https://your-token-server.com/api/token';

export interface TokenResult {
    token: string;
    url: string;
}

export const LiveKitService = {
    /**
     * Fetches an access token from backend using Firebase user auth.
     *
     * @param roomName - The unique room id for the call session
     * @param chatId - Chat that owns the call
     * @param participantName - Display name for LiveKit participant
     */
    getToken: async (roomName: string, chatId: string, participantName: string): Promise<TokenResult> => {
        if (TOKEN_ENDPOINT.includes('your-token-server')) {
            throw new Error('LiveKit token endpoint is not configured.');
        }

        const currentUser = getAuth().currentUser;
        if (!currentUser) {
            throw new Error('User must be authenticated before requesting call token.');
        }

        const idToken = await currentUser.getIdToken();
        const identity = currentUser.uid;

        // Backward compatibility:
        // - New endpoint uses JSON body with roomName/chatId/name
        // - Legacy endpoint expects roomName/identity (sometimes from query params)
        const endpointUrl = new URL(TOKEN_ENDPOINT);
        endpointUrl.searchParams.set('roomName', roomName);
        endpointUrl.searchParams.set('chatId', chatId);
        endpointUrl.searchParams.set('name', participantName);
        endpointUrl.searchParams.set('identity', identity);

        const response = await fetch(endpointUrl.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
                roomName,
                chatId,
                name: participantName,
                identity,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch LiveKit token (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        if (typeof data?.token !== 'string' || typeof data?.url !== 'string') {
            throw new Error('Token endpoint returned an invalid response payload.');
        }

        return {
            token: data.token,
            url: data.url,
        };
    }
};
